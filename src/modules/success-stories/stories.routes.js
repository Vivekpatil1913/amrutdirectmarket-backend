import { Router } from "express";
import { z } from "zod";
import path from "path";
import { unlink } from "fs/promises";
import sharp from "sharp";
import { query, queryOne } from "../../db/pool.js";
import { env } from "../../config/env.js";
import { canModerate, districtScope, requireModerator, requirePortal } from "../../middleware/auth.js";
import { asyncHandler, notFound, paginated, parseOrThrow, success, validation } from "../../lib/errors.js";
import { cleanString, idParam, optionalId, paginationQuery } from "../../lib/validators.js";
import { COVER_IMAGE_MAX_MB, COVER_IMAGE_TYPES, EVENT_APPROVAL_STATUSES, STORY_MAX_CHARS } from "../../lib/constants.js";
import { audit } from "../../lib/audit.js";
import { liveMedia } from "../../lib/media.js";
import { assertImageContent, discardFiles, MEDIA_SUBDIR, safeFilename, uploadImage } from "../../middleware/upload.js";
import { getById as getEvent, reviewSchema } from "../events/events.service.js";

// Success stories of completed events. A district manager's story waits for
// approval, and so does any change to it; divisional managers and super
// admins approve within their scope, and their own stories go straight out.
const router = Router();
router.use(requirePortal);
const id = (req) => parseOrThrow(idParam, req.params.id);

const STORY_IMAGE_MAX_WIDTH = 1600;

const storySchema = z.object({
  event_id: z.coerce.number({ invalid_type_error: "Choose the event" }).int().positive("Choose the event"),
  story_mr: cleanString(STORY_MAX_CHARS).default(""),
  story_en: cleanString(STORY_MAX_CHARS).default(""),
  image_media_id: optionalId,
}).refine((v) => v.story_mr || v.story_en, { message: "Write the story", path: ["story_mr"] });

const listQuery = z.object({
  ...paginationQuery,
  approval: z.union([z.enum(EVENT_APPROVAL_STATUSES), z.literal("")]).optional().default(""),
});

const SELECT = `SELECT s.id, s.event_id, s.district_id, s.title_mr, s.title_en, s.story_mr, s.story_en, s.image, s.status,
    s.approval_status, s.moderation_status, s.review_note, s.submitted_at, s.reviewed_at,
    d.name_en AS district_name_en, d.name_mr AS district_name_mr, cu.name AS created_by_name, ru.name AS reviewed_by_name
  FROM success_stories s
  LEFT JOIN districts d ON d.id = s.district_id
  LEFT JOIN admin_users cu ON cu.id = s.created_by
  LEFT JOIN admin_users ru ON ru.id = s.reviewed_by`;

// A story inside the caller's scope; outside it, it does not exist.
async function getStory(storyId, scope) {
  const row = await queryOne(
    `${SELECT} WHERE s.id = $1 AND s.deleted_at IS NULL AND s.event_id IS NOT NULL
       AND ($2::int[] IS NULL OR s.district_id = ANY($2))`,
    [storyId, scope]
  );
  if (!row) throw notFound("Success story");
  return row;
}

// The story's event must be in scope and over; its photo must be one processed
// by the upload below.
async function prepare(body, scope) {
  const data = parseOrThrow(storySchema, body ?? {});
  const event = await getEvent(data.event_id, scope);
  if (event.phase !== "completed") throw validation([{ field: "event_id", message: "Stories can only be added to completed events" }]);
  let image = { media_id: null, url: "" };
  if (data.image_media_id) {
    const media = (await liveMedia([data.image_media_id])).get(data.image_media_id);
    if (media?.mime_type !== "image/webp") throw validation([{ field: "image_media_id", message: "Upload the photo again" }]);
    image = { media_id: media.id, url: media.url };
  }
  return { data, event, image };
}

// Any JPG, PNG or WebP up to the limit, stored as a resized WebP.
router.post("/upload", uploadImage.single("file"), asyncHandler(async (req, res) => {
  if (!req.file) throw validation([{ field: "file", message: "Choose an image to upload" }]);
  const refuse = async (message) => {
    await discardFiles([req.file]);
    throw validation([{ field: "file", message }]);
  };
  if (!COVER_IMAGE_TYPES.includes(req.file.mimetype)) await refuse("Photo must be a JPG, PNG or WebP image");
  if (req.file.size > COVER_IMAGE_MAX_MB * 1024 * 1024) await refuse(`Photo can be at most ${COVER_IMAGE_MAX_MB} MB`);
  await assertImageContent(req.file);

  const filename = safeFilename("image/webp");
  let info;
  try {
    info = await sharp(req.file.path)
      .rotate()
      .resize({ width: STORY_IMAGE_MAX_WIDTH, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(path.join(env.upload.dir, MEDIA_SUBDIR, filename));
  } catch {
    await refuse("This image could not be processed");
  }
  await unlink(req.file.path).catch(() => {});

  const media = await queryOne(
    `INSERT INTO media_assets (filename, original_name, mime_type, size_bytes, url, alt_text, uploaded_by)
     VALUES ($1, $2, 'image/webp', $3, $4, '', $5) RETURNING id, url, original_name`,
    [filename, req.file.originalname.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 200), info.size, `/uploads/${MEDIA_SUBDIR}/${filename}`, req.user.id]
  );
  await audit(req.user, "upload", "media_assets", media.id, `Uploaded story photo ${media.original_name}`);
  return success(res, { media_id: media.id, url: media.url }, 201);
}));

router.get("/", asyncHandler(async (req, res) => {
  const q = parseOrThrow(listQuery, req.query);
  const scope = districtScope(req);
  const where = ["s.deleted_at IS NULL", "s.event_id IS NOT NULL"];
  const params = [];
  if (scope) {
    params.push(scope);
    where.push(`s.district_id = ANY($${params.length})`);
  }
  if (q.approval) {
    params.push(q.approval);
    where.push(`s.approval_status = $${params.length}`);
  }
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const total = (await queryOne(`SELECT COUNT(*) AS count FROM success_stories s ${whereSql}`, params)).count;
  params.push(q.limit, (q.page - 1) * q.limit);
  const rows = await query(
    `${SELECT} ${whereSql} ORDER BY s.submitted_at DESC, s.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return paginated(res, rows, total, q.page, q.limit);
}));

router.get("/:id", asyncHandler(async (req, res) => success(res, await getStory(id(req), districtScope(req)))));

router.post("/", asyncHandler(async (req, res) => {
  const scope = districtScope(req);
  const { data, event, image } = await prepare(req.body, scope);
  const approved = canModerate(req.user);
  const row = await queryOne(
    `INSERT INTO success_stories (title_mr, title_en, story_mr, story_en, image, event_id, district_id, approval_status,
                                  reviewed_by, reviewed_at, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11) RETURNING id`,
    [event.title_mr, event.title_en, data.story_mr, data.story_en, JSON.stringify(image), event.id, event.district_id,
      approved ? "approved" : "pending", approved ? req.user.id : null, approved ? new Date() : null, req.user.id]
  );
  await audit(req.user, "create", "success_stories", row.id,
    `Created a story for "${event.title_en || event.title_mr}"${approved ? "" : " and sent it for approval"}`);
  return success(res, await getStory(row.id, scope), 201);
}));

router.put("/:id", asyncHandler(async (req, res) => {
  const storyId = id(req);
  const scope = districtScope(req);
  await getStory(storyId, scope);
  const { data, event, image } = await prepare(req.body, scope);
  const resubmit = !canModerate(req.user);
  await query(
    `UPDATE success_stories
        SET title_mr = $1, title_en = $2, story_mr = $3, story_en = $4, image = $5, event_id = $6, district_id = $7,
            updated_by = $8, updated_at = NOW(),
            approval_status = CASE WHEN $9 THEN 'pending' ELSE approval_status END,
            submitted_at = CASE WHEN $9 THEN NOW() ELSE submitted_at END,
            review_note = CASE WHEN $9 THEN '' ELSE review_note END
      WHERE id = $10`,
    [event.title_mr, event.title_en, data.story_mr, data.story_en, JSON.stringify(image), event.id, event.district_id,
      req.user.id, resubmit, storyId]
  );
  await audit(req.user, "update", "success_stories", storyId,
    `Updated the story for "${event.title_en || event.title_mr}"${resubmit ? " and sent it for approval" : ""}`);
  return success(res, await getStory(storyId, scope));
}));

router.post("/:id/review", requireModerator, asyncHandler(async (req, res) => {
  const storyId = id(req);
  const scope = districtScope(req);
  const data = parseOrThrow(reviewSchema, req.body ?? {});
  const before = await getStory(storyId, scope);
  await query(
    `UPDATE success_stories SET approval_status = $1, review_note = $2, reviewed_by = $3, reviewed_at = NOW(), updated_at = NOW()
      WHERE id = $4`,
    [data.decision, data.note, req.user.id, storyId]
  );
  await audit(req.user, "status", "success_stories", storyId,
    `${data.decision === "approved" ? "Approved" : "Rejected"} the story for "${before.title_en || before.title_mr}"${data.note ? `: ${data.note}` : ""}`);
  return success(res, await getStory(storyId, scope));
}));

router.delete("/:id", asyncHandler(async (req, res) => {
  const storyId = id(req);
  const before = await getStory(storyId, districtScope(req));
  await query("UPDATE success_stories SET deleted_at = NOW(), updated_by = $1, updated_at = NOW() WHERE id = $2", [req.user.id, storyId]);
  await audit(req.user, "delete", "success_stories", storyId, `Deleted the story for "${before.title_en || before.title_mr}"`);
  return success(res, { id: storyId, deleted: true });
}));

export default router;
