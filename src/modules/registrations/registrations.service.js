import crypto from "crypto";
import path from "path";
import { env } from "../../config/env.js";
import { query, queryOne, transaction } from "../../db/pool.js";
import { AppError, conflict, notFound, parseOrThrow, validation } from "../../lib/errors.js";
import { likePattern } from "../../lib/validators.js";
import { audit } from "../../lib/audit.js";
import { decryptAadhaar, encryptAadhaar, hashAadhaar, maskAadhaar } from "../../lib/identity.js";
import { BOOKING_SUBDIR, detectImageType, discardFiles } from "../../middleware/upload.js";
import { bookingSchema, isReserved, registrationListQuery, registrationUpdateSchema } from "./registrations.schema.js";
import { fillFromWaitlist, releaseSlot, slotTransition, takeSlot } from "./slots.js";
import { getForm, missingFiles, validateAnswers } from "../forms/forms.service.js";
import { PHASE_SQL } from "../events/events.service.js";

const DUPLICATE = "An application with this Aadhaar number is already open for this event";

const referenceNo = (eventId) =>
  `TBP-${String(eventId).padStart(4, "0")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

// Columns safe to show in the portal: never the Aadhaar cipher or hash.
const COLUMNS = `r.id, r.reference_no, r.event_id, r.quota_type, r.status, r.name, r.business_name,
  r.nature_of_business, r.category_id, r.category_ids, r.category_label, r.aadhaar_last4, r.udyam_number, r.udyam_verified,
  r.caste_category, r.caste_name, r.files, r.phone, r.phone_verified_at, r.email, r.extra, r.language, r.source, r.dm_notes,
  r.reviewed_by, r.reviewed_at, r.created_at, r.updated_at, r.deleted_at,
  e.title_mr AS event_title_mr, e.title_en AS event_title_en, e.district_id,
  d.name_en AS district_name_en, d.name_mr AS district_name_mr`;

const FROM = `FROM vendor_registrations r
  JOIN events e ON e.id = r.event_id
  JOIN districts d ON d.id = e.district_id`;

// Password answers are stored as bcrypt hashes; they are never shown.
const BCRYPT_RE = /^\$2[aby]\$\d{2}\$/;
const maskExtra = (extra) =>
  Object.fromEntries(Object.entries(extra ?? {}).map(([k, v]) => [k, typeof v === "string" && BCRYPT_RE.test(v) ? "••••••••" : v]));

// Uploaded files are listed by name and size; the stored filename stays private.
const listFiles = (files) =>
  Object.fromEntries(
    Object.entries(files ?? {}).map(([k, f]) => [k, { original_name: f.original_name, mime_type: f.mime_type, size_bytes: f.size_bytes }])
  );

const present = (row) =>
  row && { ...row, extra: maskExtra(row.extra), files: listFiles(row.files), aadhaar_masked: maskAadhaar(row.aadhaar_last4) };

async function bookableEvent(eventId, { publicOnly }) {
  const e = await queryOne(
    `SELECT e.id, e.district_id, e.status, e.approval_status, e.registration_open, ${PHASE_SQL} AS phase
       FROM events e WHERE e.id = $1 AND e.deleted_at IS NULL`,
    [eventId]
  );
  const open = e && e.status === "published" && e.approval_status === "approved" && e.registration_open
    && (e.phase === "upcoming" || e.phase === "live");
  if (!e || (publicOnly && !open)) {
    throw validation([{ field: "event_id", message: "Registration for this event is closed" }]);
  }
  return e;
}

// Labels of the chosen product categories, at submission time.
async function categoryLabels(ids) {
  const rows = await query(
    "SELECT id, name_mr, name_en FROM categories WHERE id = ANY($1::int[]) AND status = 'published' AND deleted_at IS NULL",
    [ids]
  );
  if (rows.length !== ids.length) throw validation([{ field: "product_categories", message: "Choose valid product categories" }]);
  const byId = new Map(rows.map((c) => [c.id, c.name_en || c.name_mr]));
  return ids.map((id) => byId.get(id)).join(", ");
}

// The stored label of the chosen nature of business.
function natureLabel(form, value) {
  const o = form.fields.find((f) => f.key === "nature_of_business")?.options.find((x) => x.value === value);
  return o ? o.label_en || o.label_mr : value;
}

const fileField = (form, key) => (form.fields.find((f) => f.key === key)?.system ? key : `extra.${key}`);

// Uploaded files of a public booking, keyed by form field. Only enabled file
// fields are accepted, each file's content must match its declared type, and
// a required one (the caste certificate for reserved categories) must be there.
// `answers` is the raw booking body.
async function acceptFiles(form, uploads, answers) {
  const allowed = new Set(form.fields.filter((f) => f.type === "file" && f.enabled !== false).map((f) => f.key));
  const files = {};
  const errors = [];
  for (const u of uploads) {
    if (!allowed.has(u.fieldname) || files[u.fieldname]) continue;
    const detected = await detectImageType(u.path);
    if (!detected || detected !== u.mimetype) {
      errors.push({ field: fileField(form, u.fieldname), message: "This file is not a valid PDF, JPEG or PNG" });
      continue;
    }
    files[u.fieldname] = {
      filename: u.filename,
      original_name: u.originalname.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 200),
      mime_type: u.mimetype,
      size_bytes: u.size,
    };
  }
  errors.push(...missingFiles(form.fields, files, {
    isRequired: (f) => (f.key === "caste_certificate" ? isReserved(answers.caste_category) : f.required),
  }).filter((e) => !errors.some((x) => x.field === e.field)));
  if (errors.length) throw validation(errors);
  return files;
}

// Public bookings are given their stall type: an applicant of an EWS /
// reserved category takes a reserved stall while any is free, otherwise a
// general one. With neither free, they join the waitlist of their own type.
async function assignSlot(tx, eventId, reserved) {
  if (reserved) {
    const ews = await tx.queryOne("SELECT total FROM event_stall_quotas WHERE event_id = $1 AND quota_type = 'ews'", [eventId]);
    if (ews?.total > 0) {
      if ((await takeSlot(tx, eventId, "ews")) !== null) return { quota_type: "ews", held: true };
      if ((await takeSlot(tx, eventId, "general")) !== null) return { quota_type: "general", held: true };
      return { quota_type: "ews", held: false };
    }
  }
  return { quota_type: "general", held: (await takeSlot(tx, eventId, "general")) !== null };
}

// Inserts an application, taking a slot if one is free and waitlisting it
// otherwise. Runs inside the caller's transaction.
async function insertApplication(tx, data, extra, { label, nature, files = {}, source, meta, notes = "" }) {
  const aadhaarHash = hashAadhaar(data.aadhaar);
  const dup = await tx.queryOne(
    `SELECT id FROM vendor_registrations
      WHERE event_id = $1 AND aadhaar_hash = $2 AND deleted_at IS NULL AND status NOT IN ('rejected', 'cancelled')`,
    [data.event_id, aadhaarHash]
  );
  if (dup) throw conflict(DUPLICATE, "aadhaar");

  const slot = data.quota_type
    ? { quota_type: data.quota_type, held: (await takeSlot(tx, data.event_id, data.quota_type)) !== null }
    : await assignSlot(tx, data.event_id, isReserved(data.caste_category));
  const status = slot.held ? "pending" : "waitlisted";
  try {
    const row = await tx.queryOne(
      `INSERT INTO vendor_registrations
         (reference_no, event_id, quota_type, status, name, business_name, nature_of_business, category_id, category_ids,
          category_label, aadhaar_cipher, aadhaar_last4, aadhaar_hash, udyam_number, caste_category, caste_name, phone, email,
          extra, files, language, source, dm_notes, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::int[], $10, $11, $12, $13, $14, $15, $16, $17, $18,
               $19::jsonb, $20::jsonb, $21, $22, $23, $24, $25)
       RETURNING id, reference_no, status, quota_type, event_id, created_at`,
      [
        referenceNo(data.event_id), data.event_id, slot.quota_type, status, data.name, data.business_name,
        nature, data.product_categories[0], data.product_categories, label, encryptAadhaar(data.aadhaar), data.aadhaar.slice(-4),
        aadhaarHash, data.udyam_number, data.caste_category, isReserved(data.caste_category) ? data.caste_name : "",
        data.phone, data.email, JSON.stringify(extra), JSON.stringify(files), data.language, source, notes,
        meta.ip ?? null, String(meta.userAgent ?? "").slice(0, 300),
      ]
    );
    const left = await tx.queryOne(
      `SELECT COALESCE(SUM(available), 0)::int AS n FROM event_stall_quotas
        WHERE event_id = $1 AND quota_type IN ('general', 'ews')`,
      [data.event_id]
    );
    return { ...row, available: left.n };
  } catch (err) {
    if (err?.code === "23505" && String(err.constraint).includes("one_per_event")) throw conflict(DUPLICATE, "aadhaar");
    throw err;
  }
}

// Validation errors of the fixed fields and of the custom questions, together,
// so the applicant sees every problem at once.
function parseBooking(form, body, opts) {
  const errors = [];
  let data;
  let extra = {};
  try {
    data = parseOrThrow(bookingSchema(form.fields, opts), body ?? {});
  } catch (err) {
    if (err?.code !== "VALIDATION_ERROR") throw err;
    errors.push(...err.details);
  }
  try {
    extra = validateAnswers(form.fields, body?.extra);
  } catch (err) {
    if (err?.code !== "VALIDATION_ERROR") throw err;
    errors.push(...err.details);
  }
  if (errors.length) throw validation(errors);
  return { data, extra };
}

export const discard = discardFiles;

// A public stall booking: `body` is the JSON payload, `uploads` the multipart
// files keyed by form field. A refused submission removes its files.
export async function submit(body, uploads, meta) {
  let kept = new Set();
  try {
    const form = await getForm("vendor_registration");
    // Answers and uploads are checked together so every problem shows at once.
    const errors = [];
    const collect = async (fn) => {
      try {
        return await fn();
      } catch (err) {
        if (err?.code !== "VALIDATION_ERROR") throw err;
        errors.push(...err.details);
        return null;
      }
    };
    const parsed = await collect(() => parseBooking(form, body, { manager: false }));
    const files = await collect(() => acceptFiles(form, uploads, body ?? {}));
    if (errors.length) throw validation(errors);
    const { data, extra } = parsed;
    // Bots filling the honeypot get a success-shaped response; nothing is stored.
    if (data.website) return { reference_no: null, status: "pending" };
    await bookableEvent(data.event_id, { publicOnly: true });
    const label = await categoryLabels(data.product_categories);
    const row = await transaction((tx) =>
      insertApplication(tx, data, extra, { label, nature: natureLabel(form, data.nature_of_business), files, source: "public", meta }));
    kept = new Set(Object.values(files).map((f) => f.filename));
    return row;
  } finally {
    await discardFiles(uploads.filter((u) => !kept.has(u.filename)));
  }
}

export async function createByManager(body, user, scope) {
  const form = await getForm("vendor_registration");
  const { data, extra } = parseBooking(form, body, { manager: true });
  const event = await bookableEvent(data.event_id, { publicOnly: false });
  if (scope && event.district_id !== scope) throw notFound("Event");
  const label = await categoryLabels(data.product_categories);
  const row = await transaction(async (tx) => {
    const inserted = await insertApplication(tx, data, extra, {
      label, nature: natureLabel(form, data.nature_of_business), source: "manager", meta: {}, notes: data.dm_notes,
    });
    await audit(user, "create", "vendor_registrations", inserted.id, `Added ${inserted.quota_type} application ${inserted.reference_no} for ${data.name}`, tx);
    return inserted;
  });
  return getById(row.id, scope);
}

export async function list(rawQuery, scope) {
  const q = parseOrThrow(registrationListQuery, rawQuery);
  const where = [q.trash === "true" ? "r.deleted_at IS NOT NULL" : "r.deleted_at IS NULL"];
  const params = [];
  const add = (value, sql) => {
    params.push(value);
    where.push(sql.replaceAll("$?", `$${params.length}`));
  };
  if (scope) add(scope, "e.district_id = $?");
  else if (q.district) add(q.district, "e.district_id = $?");
  if (q.event) add(q.event, "r.event_id = $?");
  if (q.status) add(q.status, "r.status = $?");
  if (q.quota) add(q.quota, "r.quota_type = $?");
  if (q.search) {
    add(likePattern(q.search),
      "(r.name ILIKE $? OR r.business_name ILIKE $? OR r.phone ILIKE $? OR r.reference_no ILIKE $? OR r.udyam_number ILIKE $? OR r.caste_name ILIKE $?)");
  }
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const total = (await queryOne(`SELECT COUNT(*) AS count ${FROM} ${whereSql}`, params)).count;
  const order = (q.order ?? (q.sort === "created_at" ? "desc" : "asc")).toUpperCase();
  params.push(q.limit, (q.page - 1) * q.limit);
  const rows = await query(
    `SELECT ${COLUMNS} ${FROM} ${whereSql} ORDER BY r.${q.sort} ${order}, r.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { rows: rows.map(present), total, page: q.page, pageSize: q.limit };
}

export async function getById(id, scope, { includeDeleted = false } = {}) {
  const row = await queryOne(
    `SELECT ${COLUMNS}, u.name AS reviewed_by_name,
            (SELECT COUNT(*) FROM vendor_registrations w
              WHERE w.event_id = r.event_id AND w.quota_type = r.quota_type AND w.status = 'waitlisted'
                AND w.deleted_at IS NULL AND (w.created_at, w.id) <= (r.created_at, r.id))::int AS waitlist_position
       ${FROM} LEFT JOIN admin_users u ON u.id = r.reviewed_by
      WHERE r.id = $1 ${includeDeleted ? "" : "AND r.deleted_at IS NULL"} AND ($2::int IS NULL OR e.district_id = $2)`,
    [id, scope]
  );
  if (!row) throw notFound("Application");
  return present({ ...row, waitlist_position: row.status === "waitlisted" ? row.waitlist_position : null });
}

// Status changes keep the stall inventory exact: an application that starts
// holding a stall takes a slot (refused when none is free); one that stops
// holding releases it, and the oldest waitlisted applicant moves up.
export async function update(id, body, user, scope) {
  const data = parseOrThrow(registrationUpdateSchema, body ?? {});
  const before = await getById(id, scope);
  const promoted = await transaction(async (tx) => {
    const locked = await tx.queryOne(
      "SELECT status, event_id, quota_type FROM vendor_registrations WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
      [id]
    );
    if (!locked) throw notFound("Application");
    const next = data.status ?? locked.status;
    const move = slotTransition(locked.status, next);
    let moved = [];
    if (move === "take" && (await takeSlot(tx, locked.event_id, locked.quota_type)) === null) {
      throw conflict(`No ${locked.quota_type} stalls are free for this event. Increase the quota or keep the application waitlisted.`, "status");
    }
    await tx.query(
      `UPDATE vendor_registrations
          SET status = $1, dm_notes = COALESCE($2, dm_notes), udyam_verified = COALESCE($3, udyam_verified),
              reviewed_by = $4, reviewed_at = NOW(), updated_at = NOW()
        WHERE id = $5`,
      [next, data.dm_notes ?? null, data.udyam_verified ?? null, user.id, id]
    );
    if (move === "release") {
      await releaseSlot(tx, locked.event_id, locked.quota_type);
      moved = await fillFromWaitlist(tx, locked.event_id, locked.quota_type, next === "waitlisted" ? id : null);
    }
    const changes = [];
    if (next !== locked.status) changes.push(`status ${locked.status} → ${next}`);
    if (data.udyam_verified !== undefined && data.udyam_verified !== before.udyam_verified) {
      changes.push(data.udyam_verified ? "Udyam verified" : "Udyam unverified");
    }
    if (data.dm_notes !== undefined && data.dm_notes !== before.dm_notes) changes.push("notes");
    if (moved.length) changes.push(`${moved.length} promoted from waitlist`);
    await audit(user, "update", "vendor_registrations", id, `Updated application ${before.reference_no}${changes.length ? ` (${changes.join(", ")})` : ""}`, tx);
    return moved;
  });
  return { ...(await getById(id, scope)), promoted_ids: promoted };
}

// Soft delete releases the stall the application was holding.
export async function softDelete(id, user, scope) {
  const before = await getById(id, scope);
  await transaction(async (tx) => {
    await tx.query("UPDATE vendor_registrations SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1", [id]);
    if (slotTransition(before.status, "cancelled") === "release") {
      await releaseSlot(tx, before.event_id, before.quota_type);
      await fillFromWaitlist(tx, before.event_id, before.quota_type);
    }
    await audit(user, "delete", "vendor_registrations", id, `Deleted application ${before.reference_no}`, tx);
  });
  return { id, deleted: true };
}

// Full Aadhaar for a super admin verifying an applicant; always audited.
export async function revealAadhaar(id, user) {
  const row = await queryOne(
    "SELECT reference_no, aadhaar_cipher FROM vendor_registrations WHERE id = $1 AND deleted_at IS NULL",
    [id]
  );
  if (!row) throw notFound("Application");
  await audit(user, "reveal", "vendor_registrations", id, `Viewed full Aadhaar of application ${row.reference_no}`);
  return { aadhaar: decryptAadhaar(row.aadhaar_cipher) };
}

// An uploaded document of a booking (caste certificate, file question), for
// a manager of the event's district or a super admin. Always audited.
export async function getFile(id, key, user, scope) {
  const row = await queryOne(
    `SELECT r.reference_no, r.files -> $2 AS file ${FROM}
      WHERE r.id = $1 AND r.deleted_at IS NULL AND ($3::int IS NULL OR e.district_id = $3)`,
    [id, key, scope]
  );
  if (!row) throw notFound("Application");
  if (!row.file?.filename || !/^[\w.-]+$/.test(row.file.filename)) throw new AppError("NOT_FOUND", "File not found", 404);
  await audit(user, "download", "vendor_registrations", id, `Downloaded ${key} of application ${row.reference_no}`);
  return {
    path: path.join(env.upload.dir, BOOKING_SUBDIR, row.file.filename),
    name: row.file.original_name || `${key}${path.extname(row.file.filename)}`,
    mime: row.file.mime_type,
  };
}
