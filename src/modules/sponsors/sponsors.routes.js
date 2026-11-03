import { Router } from "express";
import { z } from "zod";
import { query, queryOne } from "../../db/pool.js";
import { districtScope, requirePortal, requireSuperadmin } from "../../middleware/auth.js";
import { AppError, asyncHandler, conflict, notFound, paginated, parseOrThrow, success, validation } from "../../lib/errors.js";
import { cleanString, idParam, likePattern, optionalHttpUrl, optionalId, paginationQuery, requiredString } from "../../lib/validators.js";
import { SPONSOR_STATUSES, SPONSOR_TIERS } from "../../lib/constants.js";
import { audit } from "../../lib/audit.js";
import { liveMedia } from "../../lib/media.js";

// Local sponsors: a district manager drafts a sponsor and requests approval;
// only a super admin can approve it, and only approved sponsors are public.
// Editing an approved sponsor sends it back to draft for re-approval.

const router = Router();
router.use(requirePortal);
const id = (req) => parseOrThrow(idParam, req.params.id);

const sponsorSchema = z.object({
  name: requiredString(150, "Sponsor name"),
  tier: z.enum(SPONSOR_TIERS).default("partner"),
  website: optionalHttpUrl(300).default(""),
  description: cleanString(600).default(""),
  contact_name: cleanString(100).default(""),
  contact_phone: cleanString(20)
    .default("")
    .refine((v) => v === "" || /^\+?[0-9][0-9 -]{5,19}$/.test(v), "Enter a valid phone number"),
  event_id: optionalId,
  logo_media_id: optionalId,
  district_id: optionalId,
  display_order: z.coerce.number().int().min(0).max(9999).default(0),
});

const reviewSchema = z
  .object({
    decision: z.enum(["approved", "rejected"], { errorMap: () => ({ message: "Approve or reject" }) }),
    note: cleanString(500).default(""),
  })
  .refine((v) => v.decision === "approved" || v.note.length > 0, { message: "Give a reason for rejecting", path: ["note"] });

const listQuery = z.object({
  ...paginationQuery,
  status: z.union([z.enum(SPONSOR_STATUSES), z.literal("")]).optional().default(""),
  district: z.union([z.coerce.number().int().positive(), z.literal("statewide"), z.literal("")]).optional().default(""),
});

const SELECT = `SELECT s.*, m.url AS logo_url, d.name_en AS district_name_en, d.name_mr AS district_name_mr,
    e.title_en AS event_title_en, e.title_mr AS event_title_mr,
    ru.name AS requested_by_name, vu.name AS reviewed_by_name
  FROM sponsors s
  LEFT JOIN media_assets m ON m.id = s.logo_media_id AND m.deleted_at IS NULL
  LEFT JOIN districts d ON d.id = s.district_id
  LEFT JOIN events e ON e.id = s.event_id
  LEFT JOIN admin_users ru ON ru.id = s.requested_by
  LEFT JOIN admin_users vu ON vu.id = s.reviewed_by`;

async function getSponsor(sponsorId, scope) {
  const row = await queryOne(
    `${SELECT} WHERE s.id = $1 AND s.deleted_at IS NULL AND ($2::int IS NULL OR s.district_id = $2)`,
    [sponsorId, scope]
  );
  if (!row) throw notFound("Sponsor");
  return row;
}

// The district comes from the manager's scope; a super admin may pick one or
// leave it empty for a statewide sponsor. A linked event must be in it.
async function checkRefs(data, scope) {
  const districtId = scope ?? data.district_id ?? null;
  const errors = [];
  if (districtId && !(await queryOne("SELECT 1 FROM districts WHERE id = $1 AND deleted_at IS NULL", [districtId]))) {
    errors.push({ field: "district_id", message: "Choose a valid district" });
  }
  if (data.event_id) {
    const e = await queryOne("SELECT district_id FROM events WHERE id = $1 AND deleted_at IS NULL", [data.event_id]);
    if (!e || (districtId && e.district_id !== districtId)) errors.push({ field: "event_id", message: "Choose an event of this district" });
  }
  if (data.logo_media_id && !(await liveMedia([data.logo_media_id])).has(data.logo_media_id)) {
    errors.push({ field: "logo_media_id", message: "Selected logo no longer exists" });
  }
  if (errors.length) throw validation(errors);
  return districtId;
}

router.get("/", asyncHandler(async (req, res) => {
  const q = parseOrThrow(listQuery, req.query);
  const scope = districtScope(req);
  const where = [q.trash === "true" ? "s.deleted_at IS NOT NULL" : "s.deleted_at IS NULL"];
  const params = [];
  const add = (value, sql) => {
    params.push(value);
    where.push(sql.replaceAll("$?", `$${params.length}`));
  };
  if (scope) add(scope, "s.district_id = $?");
  else if (q.district === "statewide") where.push("s.district_id IS NULL");
  else if (q.district) add(q.district, "s.district_id = $?");
  if (q.status) add(q.status, "s.status = $?");
  if (q.search) add(likePattern(q.search), "(s.name ILIKE $? OR s.contact_name ILIKE $?)");
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const total = (await queryOne(`SELECT COUNT(*) AS count FROM sponsors s ${whereSql}`, params)).count;
  params.push(q.limit, (q.page - 1) * q.limit);
  // The moderation queue reads oldest request first; other lists newest first.
  const order = q.status === "pending" ? "s.requested_at ASC" : "s.updated_at DESC";
  const rows = await query(
    `${SELECT} ${whereSql} ORDER BY ${order}, s.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return paginated(res, rows, total, q.page, q.limit);
}));

router.get("/:id", asyncHandler(async (req, res) => success(res, await getSponsor(id(req), districtScope(req)))));

router.post("/", asyncHandler(async (req, res) => {
  const data = parseOrThrow(sponsorSchema, req.body);
  const districtId = await checkRefs(data, districtScope(req));
  const row = await queryOne(
    `INSERT INTO sponsors (district_id, event_id, name, tier, logo_media_id, website, description, contact_name,
                           contact_phone, display_order, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11) RETURNING id`,
    [districtId, data.event_id, data.name, data.tier, data.logo_media_id, data.website, data.description,
      data.contact_name, data.contact_phone, data.display_order, req.user.id]
  );
  await audit(req.user, "create", "sponsors", row.id, `Created sponsor "${data.name}" (draft)`);
  return success(res, await getSponsor(row.id, districtScope(req)), 201);
}));

router.put("/:id", asyncHandler(async (req, res) => {
  const scope = districtScope(req);
  const sponsorId = id(req);
  const before = await getSponsor(sponsorId, scope);
  if (before.status === "pending" && scope) throw conflict("This sponsor is awaiting super admin review and cannot be edited now");
  const data = parseOrThrow(sponsorSchema, req.body);
  const districtId = scope ? before.district_id : await checkRefs(data, null);
  if (scope) await checkRefs({ ...data, district_id: districtId }, scope);
  // A manager's change to an approved sponsor needs approving again.
  const status = scope && before.status === "approved" ? "draft" : before.status;
  await query(
    `UPDATE sponsors SET district_id = $1, event_id = $2, name = $3, tier = $4, logo_media_id = $5, website = $6,
            description = $7, contact_name = $8, contact_phone = $9, display_order = $10, status = $11,
            updated_by = $12, updated_at = NOW()
      WHERE id = $13`,
    [districtId, data.event_id, data.name, data.tier, data.logo_media_id, data.website, data.description,
      data.contact_name, data.contact_phone, data.display_order, status, req.user.id, sponsorId]
  );
  await audit(req.user, "update", "sponsors", sponsorId,
    `Updated sponsor "${data.name}"${status !== before.status ? " (back to draft for re-approval)" : ""}`);
  return success(res, await getSponsor(sponsorId, scope));
}));

router.post("/:id/request-approval", asyncHandler(async (req, res) => {
  const scope = districtScope(req);
  const sponsorId = id(req);
  const before = await getSponsor(sponsorId, scope);
  if (!["draft", "rejected"].includes(before.status)) {
    throw conflict(before.status === "pending" ? "Approval has already been requested" : "This sponsor is already approved");
  }
  await query(
    `UPDATE sponsors SET status = 'pending', requested_by = $1, requested_at = NOW(), review_note = '', updated_at = NOW()
      WHERE id = $2`,
    [req.user.id, sponsorId]
  );
  await audit(req.user, "status", "sponsors", sponsorId, `Requested super admin approval for sponsor "${before.name}"`);
  return success(res, await getSponsor(sponsorId, scope));
}));

router.post("/:id/review", requireSuperadmin, asyncHandler(async (req, res) => {
  const sponsorId = id(req);
  const { decision, note } = parseOrThrow(reviewSchema, req.body);
  const before = await getSponsor(sponsorId, null);
  if (before.status !== "pending") throw new AppError("CONFLICT", "Only sponsors awaiting approval can be reviewed", 409);
  await query(
    `UPDATE sponsors SET status = $1, review_note = $2, reviewed_by = $3, reviewed_at = NOW(), updated_at = NOW()
      WHERE id = $4`,
    [decision, note, req.user.id, sponsorId]
  );
  await audit(req.user, "status", "sponsors", sponsorId, `${decision === "approved" ? "Approved" : "Rejected"} sponsor "${before.name}"`);
  return success(res, await getSponsor(sponsorId, null));
}));

router.delete("/:id", asyncHandler(async (req, res) => {
  const sponsorId = id(req);
  const before = await getSponsor(sponsorId, districtScope(req));
  await query("UPDATE sponsors SET deleted_at = NOW(), updated_by = $1, updated_at = NOW() WHERE id = $2", [req.user.id, sponsorId]);
  await audit(req.user, "delete", "sponsors", sponsorId, `Deleted sponsor "${before.name}"`);
  return success(res, { id: sponsorId, deleted: true });
}));

export default router;

// Approved sponsors for the public marquee, title sponsors first.
export async function publicSponsors() {
  return query(
    `SELECT s.id, s.name, s.tier, s.website, m.url AS logo_url, d.name_en AS district_name_en, d.name_mr AS district_name_mr
       FROM sponsors s
       LEFT JOIN media_assets m ON m.id = s.logo_media_id AND m.deleted_at IS NULL
       LEFT JOIN districts d ON d.id = s.district_id
      WHERE s.deleted_at IS NULL AND s.status = 'approved'
      ORDER BY array_position(ARRAY['title', 'gold', 'silver', 'partner'], s.tier), s.display_order, s.id`
  );
}
