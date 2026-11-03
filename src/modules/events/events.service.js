import { z } from "zod";
import { query, queryOne, transaction } from "../../db/pool.js";
import { conflict, forbidden, notFound, parseOrThrow, validation } from "../../lib/errors.js";
import { cleanString, isoDate, likePattern, optionalId, paginationQuery, requiredString } from "../../lib/validators.js";
import { EVENT_STATUSES, QUOTA_TYPES } from "../../lib/constants.js";
import { audit } from "../../lib/audit.js";
import { liveMedia } from "../../lib/media.js";
import { setQuotaTotal } from "../registrations/slots.js";

// Where an event is in its life, from its dates (computed, never stored).
export const PHASE_SQL = `CASE WHEN e.status = 'cancelled' THEN 'cancelled'
  WHEN CURRENT_DATE < e.start_date THEN 'upcoming'
  WHEN CURRENT_DATE <= e.end_date THEN 'live'
  ELSE 'completed' END`;
export const PHASES = ["upcoming", "live", "completed", "cancelled"];

// { general: { total, available }, ews: …, sponsored: … } for an event row.
export const QUOTAS_SQL = `COALESCE((SELECT json_object_agg(q.quota_type, json_build_object('total', q.total, 'available', q.available))
  FROM event_stall_quotas q WHERE q.event_id = e.id), '{}'::json)`;

const quotaCount = z.coerce.number().int().min(0, "Cannot be negative").max(10000, "At most 10000 stalls");

export const eventSchema = z
  .object({
    district_id: optionalId,
    title_mr: requiredString(160, "Marathi title"),
    title_en: cleanString(160).default(""),
    description_mr: cleanString(2000).default(""),
    description_en: cleanString(2000).default(""),
    venue_mr: requiredString(200, "Venue"),
    venue_en: cleanString(200).default(""),
    start_date: isoDate("Start date"),
    end_date: isoDate("End date"),
    status: z.enum(EVENT_STATUSES).default("draft"),
    registration_open: z.boolean().default(true),
    cover_media_id: optionalId,
    quotas: z
      .object({ general: quotaCount.default(0), ews: quotaCount.default(0), sponsored: quotaCount.default(0) })
      .default({}),
  })
  .refine((v) => v.end_date >= v.start_date, { message: "End date cannot be before the start date", path: ["end_date"] });

const listQuery = z.object({
  ...paginationQuery,
  district: z.union([z.coerce.number().int().positive(), z.literal("")]).optional().default(""),
  status: z.union([z.enum(EVENT_STATUSES), z.literal("")]).optional().default(""),
  phase: z.union([z.enum(PHASES), z.literal("")]).optional().default(""),
  sort: z.enum(["start_date", "created_at", "title_en"]).optional().default("start_date"),
});

const SELECT = `SELECT e.*, ${PHASE_SQL} AS phase, ${QUOTAS_SQL} AS quotas,
    d.name_mr AS district_name_mr, d.name_en AS district_name_en, d.code AS district_code,
    m.url AS cover_url,
    (SELECT COUNT(*) FROM vendor_registrations r WHERE r.event_id = e.id AND r.deleted_at IS NULL)::int AS applicants
  FROM events e
  JOIN districts d ON d.id = e.district_id
  LEFT JOIN media_assets m ON m.id = e.cover_media_id AND m.deleted_at IS NULL`;

export async function list(rawQuery, scope) {
  const q = parseOrThrow(listQuery, rawQuery);
  const where = [q.trash === "true" ? "e.deleted_at IS NOT NULL" : "e.deleted_at IS NULL"];
  const params = [];
  const add = (value, sql) => {
    params.push(value);
    where.push(sql.replaceAll("$?", `$${params.length}`));
  };
  if (scope) add(scope, "e.district_id = $?");
  else if (q.district) add(q.district, "e.district_id = $?");
  if (q.status) add(q.status, "e.status = $?");
  if (q.phase) add(q.phase, `(${PHASE_SQL}) = $?`);
  if (q.search) add(likePattern(q.search), "(e.title_mr ILIKE $? OR e.title_en ILIKE $? OR e.venue_mr ILIKE $? OR e.venue_en ILIKE $?)");

  const whereSql = `WHERE ${where.join(" AND ")}`;
  const total = (await queryOne(`SELECT COUNT(*) AS count FROM events e ${whereSql}`, params)).count;
  const order = (q.order ?? (q.sort === "created_at" ? "desc" : "asc")).toUpperCase();
  params.push(q.limit, (q.page - 1) * q.limit);
  const rows = await query(
    `${SELECT} ${whereSql} ORDER BY e.${q.sort} ${order}, e.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { rows, total, page: q.page, pageSize: q.limit };
}

// An event inside the caller's scope; a manager asking for another
// district's event gets 404, exactly as if it did not exist.
export async function getById(id, scope, { includeDeleted = false, db = { queryOne } } = {}) {
  const row = await db.queryOne(
    `${SELECT} WHERE e.id = $1 ${includeDeleted ? "" : "AND e.deleted_at IS NULL"} AND ($2::int IS NULL OR e.district_id = $2)`,
    [id, scope]
  );
  if (!row) throw notFound("Event");
  return row;
}

async function resolveDistrict(data, scope) {
  // A manager always works in their own district, whatever the body says.
  const districtId = scope ?? data.district_id;
  if (!districtId) throw validation([{ field: "district_id", message: "Choose the district" }]);
  const d = await queryOne("SELECT id FROM districts WHERE id = $1 AND deleted_at IS NULL AND is_active = TRUE", [districtId]);
  if (!d) throw validation([{ field: "district_id", message: "Choose a valid district" }]);
  return districtId;
}

async function assertCover(mediaId) {
  if (!mediaId) return;
  if (!(await liveMedia([mediaId])).has(mediaId)) {
    throw validation([{ field: "cover_media_id", message: "Selected image no longer exists" }]);
  }
}

async function applyQuotas(tx, eventId, quotas) {
  const errors = [];
  for (const type of QUOTA_TYPES) {
    const result = await setQuotaTotal(tx, eventId, type, quotas[type]);
    if (!result.ok) {
      errors.push({ field: `quotas.${type}`, message: `Cannot be below the ${result.held} stall(s) already allocated` });
    }
  }
  if (errors.length) throw validation(errors);
}

export async function create(body, user, scope) {
  const data = parseOrThrow(eventSchema, body ?? {});
  const districtId = await resolveDistrict(data, scope);
  await assertCover(data.cover_media_id);
  const id = await transaction(async (tx) => {
    const row = await tx.queryOne(
      `INSERT INTO events (district_id, title_mr, title_en, description_mr, description_en, venue_mr, venue_en,
                           start_date, end_date, status, registration_open, cover_media_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13) RETURNING id`,
      [districtId, data.title_mr, data.title_en, data.description_mr, data.description_en, data.venue_mr, data.venue_en,
        data.start_date, data.end_date, data.status, data.registration_open, data.cover_media_id, user.id]
    );
    await applyQuotas(tx, row.id, data.quotas);
    await audit(user, "create", "events", row.id, `Created event "${data.title_en || data.title_mr}"`, tx);
    return row.id;
  });
  return getById(id, scope);
}

export async function update(id, body, user, scope) {
  const before = await getById(id, scope);
  const data = parseOrThrow(eventSchema, body ?? {});
  // Only a super admin may move an event to another district.
  const districtId = scope ? before.district_id : await resolveDistrict({ district_id: data.district_id ?? before.district_id }, null);
  await assertCover(data.cover_media_id);
  await transaction(async (tx) => {
    await tx.query(
      `UPDATE events SET district_id = $1, title_mr = $2, title_en = $3, description_mr = $4, description_en = $5,
              venue_mr = $6, venue_en = $7, start_date = $8, end_date = $9, status = $10, registration_open = $11,
              cover_media_id = $12, updated_by = $13, updated_at = NOW()
        WHERE id = $14 AND deleted_at IS NULL`,
      [districtId, data.title_mr, data.title_en, data.description_mr, data.description_en, data.venue_mr, data.venue_en,
        data.start_date, data.end_date, data.status, data.registration_open, data.cover_media_id, user.id, id]
    );
    await applyQuotas(tx, id, data.quotas);
    await audit(user, "update", "events", id, `Updated event "${data.title_en || data.title_mr}"`, tx);
  });
  return getById(id, scope);
}

// Events with applications are cancelled, not deleted, so applicants keep a
// record of what happened to their booking.
export async function softDelete(id, user, scope) {
  const before = await getById(id, scope);
  if (before.applicants > 0) throw conflict("This event has applications; cancel it instead of deleting it");
  await query("UPDATE events SET deleted_at = NOW(), updated_by = $1, updated_at = NOW() WHERE id = $2", [user.id, id]);
  await audit(user, "delete", "events", id, `Deleted event "${before.title_en || before.title_mr}"`);
  return { id, deleted: true };
}

export async function restore(id, user, scope) {
  const before = await getById(id, scope, { includeDeleted: true });
  if (!before.deleted_at) throw notFound("Deleted event");
  if (scope && before.district_id !== scope) throw forbidden();
  await query("UPDATE events SET deleted_at = NULL, updated_by = $1, updated_at = NOW() WHERE id = $2", [user.id, id]);
  await audit(user, "restore", "events", id, `Restored event "${before.title_en || before.title_mr}"`);
  return getById(id, scope);
}

// ── Public ────────────────────────────────────────────────────────────────

const PUBLIC_COLUMNS = `e.id, e.district_id, e.title_mr, e.title_en, e.description_mr, e.description_en,
  e.venue_mr, e.venue_en, e.start_date, e.end_date, e.registration_open, ${PHASE_SQL} AS phase, ${QUOTAS_SQL} AS quotas,
  d.code AS district_code, d.name_mr AS district_name_mr, d.name_en AS district_name_en,
  d.lat::float AS lat, d.lng::float AS lng, m.url AS cover_url`;

const PUBLIC_FROM = `FROM events e
  JOIN districts d ON d.id = e.district_id
  LEFT JOIN media_assets m ON m.id = e.cover_media_id AND m.deleted_at IS NULL
  WHERE e.deleted_at IS NULL AND e.status = 'published'`;

// Bookable = published, open for registration and not yet over.
export const bookable = (e) => e.registration_open && (e.phase === "upcoming" || e.phase === "live");

export async function listPublic({ phases = ["live", "upcoming"], district = "", limit = 24 } = {}) {
  const rows = await query(
    `SELECT ${PUBLIC_COLUMNS} ${PUBLIC_FROM}
       AND (${PHASE_SQL}) = ANY($1::text[]) AND ($2 = '' OR d.code = $2)
     ORDER BY e.start_date ASC, e.id ASC LIMIT $3`,
    [phases, district, limit]
  );
  return rows.map((e) => ({ ...e, bookable: bookable(e) }));
}

export async function getPublic(id) {
  const e = await queryOne(`SELECT ${PUBLIC_COLUMNS} ${PUBLIC_FROM} AND e.id = $1`, [id]);
  if (!e) throw notFound("Event");
  const gallery = await query(
    `SELECT em.id, em.caption, m.url FROM event_media em JOIN media_assets m ON m.id = em.media_id
      WHERE em.event_id = $1 AND em.deleted_at IS NULL AND m.deleted_at IS NULL
      ORDER BY em.display_order ASC, em.id ASC`,
    [id]
  );
  return { ...e, bookable: bookable(e), gallery };
}

// Live availability for the registration form's slot counter.
export async function slots(id) {
  const e = await queryOne(`SELECT ${PUBLIC_COLUMNS} ${PUBLIC_FROM} AND e.id = $1`, [id]);
  if (!e) throw notFound("Event");
  const q = (type) => e.quotas[type] ?? { total: 0, available: 0 };
  const available = q("general").available + q("ews").available;
  return {
    event_id: e.id,
    bookable: bookable(e),
    quotas: { general: q("general"), ews: q("ews") },
    available,
    total: q("general").total + q("ews").total,
    state: !bookable(e) ? "closed" : available > 0 ? "open" : "waitlist",
    checked_at: new Date().toISOString(),
  };
}
