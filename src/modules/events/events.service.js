import { z } from "zod";
import { query, queryOne, transaction } from "../../db/pool.js";
import { conflict, forbidden, notFound, parseOrThrow, validation } from "../../lib/errors.js";
import {
  cleanString, httpUrl, isoDate, likePattern, mobileNumber, optionalId, paginationQuery, requiredString,
} from "../../lib/validators.js";
import {
  COVER_IMAGE_MAX_MB, COVER_IMAGE_TYPES, EVENT_APPROVAL_STATUSES, EVENT_STATUSES, QUOTA_TYPES, STORY_MAX_CHARS,
} from "../../lib/constants.js";
import { audit } from "../../lib/audit.js";
import { canModerate, districtInScope } from "../../middleware/auth.js";
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

// "Create Event (Bajar Peth)". Stall availability is the event's total
// stalls; the EWS / reserved and sponsored stalls are carved out of it and
// the rest are general.
export const eventSchema = z
  .object({
    district_id: optionalId,
    title_mr: requiredString(160, "Event name"),
    title_en: cleanString(160).default(""),
    description_mr: cleanString(2000).default(""),
    description_en: cleanString(2000).default(""),
    venue_mr: requiredString(200, "Event venue"),
    venue_en: cleanString(200).default(""),
    city_mr: cleanString(100).default(""),
    city_en: cleanString(100).default(""),
    start_date: isoDate("From date"),
    end_date: isoDate("To date"),
    event_time: requiredString(80, "Time of event"),
    venue_map_link: httpUrl(500),
    contact_phone: mobileNumber,
    sponsor_name: cleanString(150).default(""),
    sponsor_logo_media_id: optionalId,
    status: z.enum(EVENT_STATUSES).default("published"),
    registration_open: z.boolean().default(true),
    cover_media_id: optionalId,
    total_stalls: z.coerce
      .number({ required_error: "Stall availability is required", invalid_type_error: "Stall availability must be a number" })
      .int("Stall availability must be a whole number")
      .min(1, "At least 1 stall")
      .max(10000, "At most 10000 stalls"),
    quotas: z.object({ ews: quotaCount.default(0), sponsored: quotaCount.default(0) }).default({}),
  })
  .refine((v) => v.end_date >= v.start_date, { message: "The to date cannot be before the from date", path: ["end_date"] })
  .refine((v) => v.quotas.ews + v.quotas.sponsored <= v.total_stalls, {
    message: "Reserved and sponsored stalls cannot exceed the stall availability",
    path: ["quotas.ews"],
  })
  .transform((v) => ({ ...v, quotas: { ...v.quotas, general: v.total_stalls - v.quotas.ews - v.quotas.sponsored } }));

export const reviewSchema = z
  .object({
    decision: z.enum(["approved", "rejected"], { errorMap: () => ({ message: "Approve or reject" }) }),
    note: cleanString(500).default(""),
  })
  .refine((v) => v.decision === "approved" || v.note.length > 0, { message: "Give a reason for rejecting", path: ["note"] });

const listQuery = z.object({
  ...paginationQuery,
  district: z.union([z.coerce.number().int().positive(), z.literal("")]).optional().default(""),
  status: z.union([z.enum(EVENT_STATUSES), z.literal("")]).optional().default(""),
  phase: z.union([z.enum(PHASES), z.literal("")]).optional().default(""),
  approval: z.union([z.enum(EVENT_APPROVAL_STATUSES), z.literal("")]).optional().default(""),
  sort: z.enum(["start_date", "created_at", "title_en", "submitted_at"]).optional().default("start_date"),
});

const SELECT = `SELECT e.*, ${PHASE_SQL} AS phase, ${QUOTAS_SQL} AS quotas,
    d.name_mr AS district_name_mr, d.name_en AS district_name_en, d.code AS district_code,
    m.url AS cover_url, sl.url AS sponsor_logo_url,
    (SELECT COALESCE(SUM(q.total), 0) FROM event_stall_quotas q WHERE q.event_id = e.id)::int AS total_stalls,
    (SELECT COUNT(*) FROM vendor_registrations r WHERE r.event_id = e.id AND r.deleted_at IS NULL)::int AS applicants,
    cu.name AS created_by_name, ru.name AS reviewed_by_name
  FROM events e
  JOIN districts d ON d.id = e.district_id
  LEFT JOIN media_assets m ON m.id = e.cover_media_id AND m.deleted_at IS NULL
  LEFT JOIN media_assets sl ON sl.id = e.sponsor_logo_media_id AND sl.deleted_at IS NULL
  LEFT JOIN admin_users cu ON cu.id = e.created_by
  LEFT JOIN admin_users ru ON ru.id = e.reviewed_by`;

export async function list(rawQuery, scope) {
  const q = parseOrThrow(listQuery, rawQuery);
  const where = [q.trash === "true" ? "e.deleted_at IS NOT NULL" : "e.deleted_at IS NULL"];
  const params = [];
  const add = (value, sql) => {
    params.push(value);
    where.push(sql.replaceAll("$?", `$${params.length}`));
  };
  if (scope) add(scope, "e.district_id = ANY($?)");
  if (q.district) add(q.district, "e.district_id = $?");
  if (q.status) add(q.status, "e.status = $?");
  if (q.approval) add(q.approval, "e.approval_status = $?");
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
    `${SELECT} WHERE e.id = $1 ${includeDeleted ? "" : "AND e.deleted_at IS NULL"} AND ($2::int[] IS NULL OR e.district_id = ANY($2))`,
    [id, scope]
  );
  if (!row) throw notFound("Event");
  return row;
}

async function resolveDistrict(data, scope) {
  // A manager always works in their own district, whatever the body says.
  const districtId = districtInScope(scope, data.district_id);
  if (!districtId) throw validation([{ field: "district_id", message: "Choose the district" }]);
  const d = await queryOne("SELECT id FROM districts WHERE id = $1 AND deleted_at IS NULL AND is_active = TRUE", [districtId]);
  if (!d) throw validation([{ field: "district_id", message: "Choose a valid district" }]);
  return districtId;
}

// A new cover must suit the success-story carousel. Covers already saved are
// left alone, so older events stay editable.
function coverError(cover) {
  if (!COVER_IMAGE_TYPES.includes(cover.mime_type)) return "Event photo must be a JPG, PNG or WebP image";
  if (Number(cover.size_bytes) > COVER_IMAGE_MAX_MB * 1024 * 1024) return `Event photo can be at most ${COVER_IMAGE_MAX_MB} MB`;
  return "";
}

async function assertImages(data, before) {
  const ids = [data.cover_media_id, data.sponsor_logo_media_id].filter(Boolean);
  if (!ids.length) return;
  const live = await liveMedia(ids);
  const errors = ["cover_media_id", "sponsor_logo_media_id"]
    .filter((k) => data[k] && !live.has(data[k]))
    .map((field) => ({ field, message: "Selected image no longer exists" }));
  const cover = live.get(data.cover_media_id);
  if (cover && data.cover_media_id !== before?.cover_media_id && coverError(cover)) {
    errors.push({ field: "cover_media_id", message: coverError(cover) });
  }
  if (errors.length) throw validation(errors);
}

const columnValues = (data) => [
  data.title_mr, data.title_en, data.description_mr, data.description_en, data.venue_mr, data.venue_en,
  data.city_mr, data.city_en, data.start_date, data.end_date, data.event_time, data.venue_map_link, data.contact_phone,
  data.sponsor_name, data.sponsor_logo_media_id, data.status, data.registration_open, data.cover_media_id,
];

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

// A district manager's event goes to the super admin's approval queue; one
// created by a super admin is approved at once.
export async function create(body, user, scope) {
  const data = parseOrThrow(eventSchema, body ?? {});
  const districtId = await resolveDistrict(data, scope);
  await assertImages(data);
  const approved = canModerate(user);
  const id = await transaction(async (tx) => {
    const row = await tx.queryOne(
      `INSERT INTO events (district_id, title_mr, title_en, description_mr, description_en, venue_mr, venue_en,
                           city_mr, city_en, start_date, end_date, event_time, venue_map_link, contact_phone,
                           sponsor_name, sponsor_logo_media_id, status, registration_open, cover_media_id,
                           approval_status, submitted_at, reviewed_by, reviewed_at, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
               $20, NOW(), $21, $22, $23, $23) RETURNING id`,
      [districtId, ...columnValues(data), approved ? "approved" : "pending", approved ? user.id : null,
        approved ? new Date() : null, user.id]
    );
    await applyQuotas(tx, row.id, data.quotas);
    await audit(user, "create", "events", row.id,
      `Created event "${data.title_en || data.title_mr}"${approved ? "" : " and sent it for approval"}`, tx);
    return row.id;
  });
  return getById(id, scope);
}

export async function update(id, body, user, scope) {
  const before = await getById(id, scope);
  const data = parseOrThrow(eventSchema, body ?? {});
  // Only a super admin may move an event to another district.
  const districtId = scope ? before.district_id : await resolveDistrict({ district_id: data.district_id ?? before.district_id }, null);
  await assertImages(data, before);
  // A manager's change goes back to the approval queue (the event leaves the
  // public site until it is approved again); bookings already made stay.
  const resubmit = !canModerate(user);
  await transaction(async (tx) => {
    await tx.query(
      `UPDATE events SET district_id = $1, title_mr = $2, title_en = $3, description_mr = $4, description_en = $5,
              venue_mr = $6, venue_en = $7, city_mr = $8, city_en = $9, start_date = $10, end_date = $11, event_time = $12,
              venue_map_link = $13, contact_phone = $14, sponsor_name = $15, sponsor_logo_media_id = $16, status = $17,
              registration_open = $18, cover_media_id = $19,
              updated_by = $20, updated_at = NOW(),
              approval_status = CASE WHEN $21 THEN 'pending' ELSE approval_status END,
              submitted_at = CASE WHEN $21 THEN NOW() ELSE submitted_at END,
              review_note = CASE WHEN $21 THEN '' ELSE review_note END
        WHERE id = $22 AND deleted_at IS NULL`,
      [districtId, ...columnValues(data), user.id, resubmit, id]
    );
    await applyQuotas(tx, id, data.quotas);
    await audit(user, "update", "events", id,
      `Updated event "${data.title_en || data.title_mr}"${resubmit ? " and sent it for approval" : ""}`, tx);
  });
  return getById(id, scope);
}

// A super admin's or divisional manager's decision on a submitted event.
export async function review(id, body, user, scope) {
  const data = parseOrThrow(reviewSchema, body ?? {});
  const before = await getById(id, scope);
  await query(
    `UPDATE events SET approval_status = $1, review_note = $2, reviewed_by = $3, reviewed_at = NOW(), updated_at = NOW()
      WHERE id = $4`,
    [data.decision, data.note, user.id, id]
  );
  await audit(user, "status", "events", id,
    `${data.decision === "approved" ? "Approved" : "Rejected"} event "${before.title_en || before.title_mr}"${data.note ? `: ${data.note}` : ""}`);
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
  if (scope && !scope.includes(before.district_id)) throw forbidden();
  await query("UPDATE events SET deleted_at = NULL, updated_by = $1, updated_at = NOW() WHERE id = $2", [user.id, id]);
  await audit(user, "restore", "events", id, `Restored event "${before.title_en || before.title_mr}"`);
  return getById(id, scope);
}

// ── Public ────────────────────────────────────────────────────────────────

const PUBLIC_COLUMNS = `e.id, e.district_id, e.title_mr, e.title_en, e.description_mr, e.description_en,
  e.venue_mr, e.venue_en, e.city_mr, e.city_en, e.start_date, e.end_date, e.event_time, e.venue_map_link,
  e.contact_phone, e.sponsor_name, e.registration_open, ${PHASE_SQL} AS phase, ${QUOTAS_SQL} AS quotas,
  d.code AS district_code, d.name_mr AS district_name_mr, d.name_en AS district_name_en,
  d.lat::float AS lat, d.lng::float AS lng, m.url AS cover_url, sl.url AS sponsor_logo_url,
  (SELECT COUNT(*) FROM vendor_registrations r WHERE r.event_id = e.id AND r.deleted_at IS NULL
     AND r.status IN ('pending', 'approved'))::int AS participants`;

// Public = published by its district and approved by a super admin.
export const PUBLIC_WHERE = "e.deleted_at IS NULL AND e.status = 'published' AND e.approval_status = 'approved'";

const PUBLIC_FROM = `FROM events e
  JOIN districts d ON d.id = e.district_id
  LEFT JOIN media_assets m ON m.id = e.cover_media_id AND m.deleted_at IS NULL
  LEFT JOIN media_assets sl ON sl.id = e.sponsor_logo_media_id AND sl.deleted_at IS NULL
  WHERE ${PUBLIC_WHERE}`;

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

// An event without a story uses the opening of its description.
const shortText = (text) =>
  text.length > STORY_MAX_CHARS ? `${text.slice(0, STORY_MAX_CHARS - 1).trimEnd()}…` : text;

// The home-page carousel, newest first: each approved story of a completed
// event, and completed events with none. Pending or rejected stories are not
// joined, so they can never reach the site.
export async function pastStories(limit = 12) {
  const rows = await query(
    `SELECT e.id AS event_id, e.title_mr, e.title_en, e.description_mr, e.description_en, e.start_date, e.end_date,
            d.name_mr AS district_name_mr, d.name_en AS district_name_en, m.url AS cover_url,
            s.id AS story_id, s.story_mr, s.story_en, sm.url AS story_image
       FROM events e
       JOIN districts d ON d.id = e.district_id
       LEFT JOIN media_assets m ON m.id = e.cover_media_id AND m.deleted_at IS NULL
       LEFT JOIN success_stories s ON s.event_id = e.id AND s.deleted_at IS NULL
         AND s.status = 'published' AND s.approval_status = 'approved'
       LEFT JOIN media_assets sm ON sm.id = (s.image->>'media_id')::int AND sm.deleted_at IS NULL
      WHERE ${PUBLIC_WHERE} AND (${PHASE_SQL}) = 'completed'
      ORDER BY e.end_date DESC, e.id DESC, s.id DESC LIMIT $1`,
    [limit]
  );
  return rows.map((e) => ({
    id: e.story_id ? `story-${e.story_id}` : `event-${e.event_id}`,
    event_id: e.event_id, title_mr: e.title_mr, title_en: e.title_en,
    story_mr: e.story_mr || shortText(e.description_mr), story_en: e.story_en || shortText(e.description_en),
    district_name_mr: e.district_name_mr, district_name_en: e.district_name_en,
    start_date: e.start_date, end_date: e.end_date, cover_url: e.story_image ?? e.cover_url,
  }));
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
