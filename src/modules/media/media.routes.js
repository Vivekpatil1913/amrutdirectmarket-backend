import { Router } from "express";
import { unlink } from "fs/promises";
import { z } from "zod";
import { query, queryOne } from "../../db/pool.js";
import { requireAdmin, requireEditor } from "../../middleware/auth.js";
import { assertImageContent, MEDIA_SUBDIR, uploadImage } from "../../middleware/upload.js";
import { AppError, asyncHandler, conflict, notFound, paginated, parseOrThrow, success } from "../../lib/errors.js";
import { cleanString, idParam, paginationQuery } from "../../lib/validators.js";
import { audit } from "../../lib/audit.js";
import { sectionByKey } from "../sections/sections.config.js";

const router = Router();
const id = (req) => parseOrThrow(idParam, req.params.id);
const altSchema = z.object({ alt_text: cleanString(300).optional().default("") });
const listQuery = z.object({
  ...paginationQuery,
  limit: z.coerce.number().int().min(1).max(100).default(24),
  type: z.union([z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]), z.literal("")]).optional().default(""),
});

// Page sections (draft or published) that reference a media asset.
async function usageOf(mediaId) {
  const rows = await query(
    `SELECT key,
            jsonb_path_exists(draft, '$.** ? (@.media_id == $id)', jsonb_build_object('id', $1::int)) AS in_draft,
            jsonb_path_exists(published, '$.** ? (@.media_id == $id)', jsonb_build_object('id', $1::int)) AS in_published
       FROM page_sections`,
    [mediaId]
  );
  return rows
    .filter((r) => r.in_draft || r.in_published)
    .map((r) => ({ key: r.key, title: sectionByKey(r.key)?.title ?? r.key, draft: r.in_draft, published: r.in_published }));
}

router.get("/", requireEditor, asyncHandler(async (req, res) => {
  const q = parseOrThrow(listQuery, req.query);
  const where = [q.trash === "true" ? "deleted_at IS NOT NULL" : "deleted_at IS NULL"];
  const params = [];
  if (q.search) {
    params.push(`%${q.search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    where.push(`(original_name ILIKE $${params.length} OR alt_text ILIKE $${params.length})`);
  }
  if (q.type) {
    params.push(q.type);
    where.push(`mime_type = $${params.length}`);
  }
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const total = (await queryOne(`SELECT COUNT(*) AS count FROM media_assets ${whereSql}`, params)).count;
  params.push(q.limit, (q.page - 1) * q.limit);
  const rows = await query(
    `SELECT * FROM media_assets ${whereSql} ORDER BY created_at ${q.order === "asc" ? "ASC" : "DESC"}, id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return paginated(res, rows, total, q.page, q.limit);
}));

router.get("/:id", requireEditor, asyncHandler(async (req, res) => {
  const row = await queryOne("SELECT * FROM media_assets WHERE id = $1", [id(req)]);
  if (!row) throw notFound("Media asset");
  return success(res, { ...row, usage: await usageOf(row.id) });
}));

router.post("/upload", requireEditor, uploadImage.single("file"), asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError("VALIDATION_ERROR", "No file uploaded", 422, [{ field: "file", message: "Choose an image to upload" }]);
  await assertImageContent(req.file);
  const parsed = altSchema.safeParse(req.body);
  const alt = parsed.success ? parsed.data.alt_text : "";
  try {
    const row = await queryOne(
      `INSERT INTO media_assets (filename, original_name, mime_type, size_bytes, url, alt_text, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        req.file.filename,
        req.file.originalname.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 200),
        req.file.mimetype,
        req.file.size,
        `/uploads/${MEDIA_SUBDIR}/${req.file.filename}`,
        alt,
        req.user.id,
      ]
    );
    await audit(req.user, "upload", "media_assets", row.id, `Uploaded ${row.original_name}`);
    return success(res, row, 201);
  } catch (err) {
    await unlink(req.file.path).catch(() => {});
    throw err;
  }
}));

router.put("/:id", requireEditor, asyncHandler(async (req, res) => {
  const { alt_text } = parseOrThrow(altSchema, req.body);
  const row = await queryOne(
    "UPDATE media_assets SET alt_text = $1, updated_at = NOW() WHERE id = $2 AND deleted_at IS NULL RETURNING *",
    [alt_text, id(req)]
  );
  if (!row) throw notFound("Media asset");
  return success(res, row);
}));

// Soft delete. The file stays on disk (it can be restored), and an image still
// used by a page section cannot be deleted until it is replaced there.
router.delete("/:id", requireAdmin, asyncHandler(async (req, res) => {
  const mediaId = id(req);
  const usage = await usageOf(mediaId);
  if (usage.length) {
    throw conflict(`This image is used by: ${usage.map((u) => u.title).join(", ")}. Replace it there first.`, "usage");
  }
  const row = await queryOne(
    "UPDATE media_assets SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING id, original_name",
    [mediaId]
  );
  if (!row) throw notFound("Media asset");
  await audit(req.user, "delete", "media_assets", row.id, `Deleted ${row.original_name}`);
  return success(res, { id: row.id, deleted: true });
}));

router.post("/:id/restore", requireAdmin, asyncHandler(async (req, res) => {
  const row = await queryOne(
    "UPDATE media_assets SET deleted_at = NULL, updated_at = NOW() WHERE id = $1 AND deleted_at IS NOT NULL RETURNING *",
    [id(req)]
  );
  if (!row) throw notFound("Deleted media asset");
  await audit(req.user, "restore", "media_assets", row.id, `Restored ${row.original_name}`);
  return success(res, row);
}));

export default router;
