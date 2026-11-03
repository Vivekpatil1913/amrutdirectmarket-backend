import { Router } from "express";
import { unlink } from "fs/promises";
import { z } from "zod";
import { query, queryOne } from "../../db/pool.js";
import { districtScope, requirePortal } from "../../middleware/auth.js";
import { assertImageContent, MEDIA_SUBDIR, uploadImage } from "../../middleware/upload.js";
import { AppError, asyncHandler, notFound, parseOrThrow, success, validation } from "../../lib/errors.js";
import { cleanString, idParam } from "../../lib/validators.js";
import { audit } from "../../lib/audit.js";

// District manager media CMS: photos for event galleries, plus uploads used
// as event covers and sponsor logos. Files go into the shared media library
// (same validation as the CMS upload); gallery links are scoped by district.

const router = Router();
router.use(requirePortal);
const id = (req) => parseOrThrow(idParam, req.params.id);

const uploadBody = z.object({
  event_id: z.union([z.coerce.number().int().positive(), z.literal("")]).optional().default(""),
  caption: cleanString(300).optional().default(""),
});
const listQuery = z.object({ event_id: z.coerce.number().int().positive() });

async function scopedEvent(eventId, scope) {
  const e = await queryOne(
    "SELECT id, title_en, title_mr FROM events WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR district_id = $2)",
    [eventId, scope]
  );
  if (!e) throw validation([{ field: "event_id", message: "Choose one of your events" }]);
  return e;
}

router.get("/", asyncHandler(async (req, res) => {
  const { event_id } = parseOrThrow(listQuery, req.query);
  await scopedEvent(event_id, districtScope(req));
  const rows = await query(
    `SELECT em.id, em.event_id, em.caption, em.display_order, em.created_at, m.id AS media_id, m.url, m.original_name
       FROM event_media em JOIN media_assets m ON m.id = em.media_id
      WHERE em.event_id = $1 AND em.deleted_at IS NULL AND m.deleted_at IS NULL
      ORDER BY em.display_order ASC, em.id ASC`,
    [event_id]
  );
  return success(res, rows);
}));

router.post("/upload", uploadImage.single("file"), asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError("VALIDATION_ERROR", "No file uploaded", 422, [{ field: "file", message: "Choose an image to upload" }]);
  await assertImageContent(req.file);
  try {
    const body = parseOrThrow(uploadBody, req.body);
    const event = body.event_id ? await scopedEvent(body.event_id, districtScope(req)) : null;
    const media = await queryOne(
      `INSERT INTO media_assets (filename, original_name, mime_type, size_bytes, url, alt_text, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, url, original_name`,
      [
        req.file.filename,
        req.file.originalname.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 200),
        req.file.mimetype,
        req.file.size,
        `/uploads/${MEDIA_SUBDIR}/${req.file.filename}`,
        body.caption,
        req.user.id,
      ]
    );
    let item = null;
    if (event) {
      item = await queryOne(
        `INSERT INTO event_media (event_id, media_id, caption, display_order, created_by)
         VALUES ($1, $2, $3, (SELECT COALESCE(MAX(display_order), 0) + 10 FROM event_media WHERE event_id = $1), $4)
         RETURNING id, event_id, caption, display_order`,
        [event.id, media.id, body.caption, req.user.id]
      );
    }
    await audit(req.user, "upload", "media_assets", media.id,
      `Uploaded ${media.original_name}${event ? ` to the gallery of "${event.title_en || event.title_mr}"` : ""}`);
    return success(res, { media_id: media.id, url: media.url, ...(item ?? {}) }, 201);
  } catch (err) {
    await unlink(req.file.path).catch(() => {});
    throw err;
  }
}));

router.delete("/:id", asyncHandler(async (req, res) => {
  const row = await queryOne(
    `UPDATE event_media em SET deleted_at = NOW()
       FROM events e
      WHERE em.id = $1 AND em.deleted_at IS NULL AND e.id = em.event_id AND ($2::int IS NULL OR e.district_id = $2)
      RETURNING em.id, em.event_id`,
    [id(req), districtScope(req)]
  );
  if (!row) throw notFound("Gallery photo");
  await audit(req.user, "delete", "event_media", row.id, `Removed a photo from event #${row.event_id}`);
  return success(res, { id: row.id, deleted: true });
}));

export default router;
