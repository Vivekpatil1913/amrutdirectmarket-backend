import { Router } from "express";
import { z } from "zod";
import { query, queryOne } from "../../db/pool.js";
import { requireAuth, requireSuperadmin } from "../../middleware/auth.js";
import { asyncHandler, conflict, notFound, parseOrThrow, success } from "../../lib/errors.js";
import { idParam, requiredString, SLUG_RE } from "../../lib/validators.js";
import { audit } from "../../lib/audit.js";

const router = Router();
const id = (req) => parseOrThrow(idParam, req.params.id);

const districtSchema = z.object({
  code: z.string().trim().toLowerCase().regex(SLUG_RE, "Use lowercase letters, numbers and single hyphens only").max(40),
  name_mr: requiredString(80, "Marathi name"),
  name_en: requiredString(80, "English name"),
  lat: z.coerce.number().min(15.5, "Latitude must be within Maharashtra").max(22.1, "Latitude must be within Maharashtra"),
  lng: z.coerce.number().min(72.5, "Longitude must be within Maharashtra").max(80.95, "Longitude must be within Maharashtra"),
  is_active: z.boolean().default(true),
});

export async function listDistricts({ activeOnly = false } = {}) {
  return query(
    `SELECT id, code, name_mr, name_en, division, lat::float AS lat, lng::float AS lng, is_active
       FROM districts WHERE deleted_at IS NULL ${activeOnly ? "AND is_active = TRUE" : ""}
      ORDER BY name_en ASC`
  );
}

async function assertCodeFree(code, excludeId = null) {
  const taken = await queryOne(
    "SELECT id FROM districts WHERE code = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR id <> $2)",
    [code, excludeId]
  );
  if (taken) throw conflict("Another district already uses this code", "code");
}

// Every signed-in user (CMS or portal) needs the list for pickers and labels.
router.get("/", requireAuth, asyncHandler(async (_req, res) => success(res, await listDistricts())));

router.post("/", requireSuperadmin, asyncHandler(async (req, res) => {
  const data = parseOrThrow(districtSchema, req.body);
  await assertCodeFree(data.code);
  const row = await queryOne(
    `INSERT INTO districts (code, name_mr, name_en, lat, lng, is_active)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, code, name_mr, name_en, lat::float, lng::float, is_active`,
    [data.code, data.name_mr, data.name_en, data.lat, data.lng, data.is_active]
  );
  await audit(req.user, "create", "districts", row.id, `Created district ${row.name_en}`);
  return success(res, row, 201);
}));

router.put("/:id", requireSuperadmin, asyncHandler(async (req, res) => {
  const districtId = id(req);
  const data = parseOrThrow(districtSchema, req.body);
  await assertCodeFree(data.code, districtId);
  const row = await queryOne(
    `UPDATE districts SET code = $1, name_mr = $2, name_en = $3, lat = $4, lng = $5, is_active = $6, updated_at = NOW()
      WHERE id = $7 AND deleted_at IS NULL
      RETURNING id, code, name_mr, name_en, lat::float, lng::float, is_active`,
    [data.code, data.name_mr, data.name_en, data.lat, data.lng, data.is_active, districtId]
  );
  if (!row) throw notFound("District");
  await audit(req.user, "update", "districts", districtId, `Updated district ${row.name_en}`);
  return success(res, row);
}));

// A district that has events or managers is deactivated instead of deleted.
router.delete("/:id", requireSuperadmin, asyncHandler(async (req, res) => {
  const districtId = id(req);
  const used = await queryOne(
    `SELECT (SELECT COUNT(*) FROM events WHERE district_id = $1 AND deleted_at IS NULL)
          + (SELECT COUNT(*) FROM admin_users WHERE district_id = $1 AND deleted_at IS NULL) AS n`,
    [districtId]
  );
  if (used.n > 0) throw conflict("This district has events or managers; deactivate it instead");
  const row = await queryOne(
    "UPDATE districts SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING id, name_en",
    [districtId]
  );
  if (!row) throw notFound("District");
  await audit(req.user, "delete", "districts", districtId, `Deleted district ${row.name_en}`);
  return success(res, { id: row.id, deleted: true });
}));

export default router;
