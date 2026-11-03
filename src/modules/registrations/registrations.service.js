import crypto from "crypto";
import { query, queryOne, transaction } from "../../db/pool.js";
import { conflict, notFound, parseOrThrow, validation } from "../../lib/errors.js";
import { likePattern } from "../../lib/validators.js";
import { audit } from "../../lib/audit.js";
import { decryptAadhaar, encryptAadhaar, hashAadhaar, maskAadhaar } from "../../lib/identity.js";
import {
  managerRegistrationSchema, publicRegistrationSchema, registrationListQuery, registrationUpdateSchema,
} from "./registrations.schema.js";
import { fillFromWaitlist, releaseSlot, slotTransition, takeSlot } from "./slots.js";
import { getForm, validateAnswers } from "../forms/forms.service.js";
import { consume as consumeOtp } from "../otp/otp.service.js";
import { PHASE_SQL } from "../events/events.service.js";

const DUPLICATE = "An application with this Aadhaar number is already open for this event";

const referenceNo = (eventId) =>
  `TBP-${String(eventId).padStart(4, "0")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

// Columns safe to show in the portal: never the Aadhaar cipher or hash.
const COLUMNS = `r.id, r.reference_no, r.event_id, r.quota_type, r.status, r.name, r.business_name,
  r.nature_of_business, r.category_id, r.category_label, r.aadhaar_last4, r.udyam_number, r.udyam_verified,
  r.caste_category, r.phone, r.phone_verified_at, r.email, r.extra, r.language, r.source, r.dm_notes,
  r.reviewed_by, r.reviewed_at, r.created_at, r.updated_at, r.deleted_at,
  e.title_mr AS event_title_mr, e.title_en AS event_title_en, e.district_id,
  d.name_en AS district_name_en, d.name_mr AS district_name_mr`;

const FROM = `FROM vendor_registrations r
  JOIN events e ON e.id = r.event_id
  JOIN districts d ON d.id = e.district_id`;

const present = (row) => row && { ...row, aadhaar_masked: maskAadhaar(row.aadhaar_last4) };

async function bookableEvent(eventId, { publicOnly }) {
  const e = await queryOne(
    `SELECT e.id, e.district_id, e.status, e.registration_open, ${PHASE_SQL} AS phase
       FROM events e WHERE e.id = $1 AND e.deleted_at IS NULL`,
    [eventId]
  );
  const open = e && e.status === "published" && e.registration_open && (e.phase === "upcoming" || e.phase === "live");
  if (!e || (publicOnly && !open)) {
    throw validation([{ field: "event_id", message: "Registration for this event is closed" }]);
  }
  return e;
}

async function categoryLabel(categoryId) {
  const c = await queryOne(
    "SELECT name_mr, name_en FROM categories WHERE id = $1 AND status = 'published' AND deleted_at IS NULL",
    [categoryId]
  );
  if (!c) throw validation([{ field: "category_id", message: "Choose a valid product category" }]);
  return c.name_en || c.name_mr;
}

// Inserts an application, taking a slot if one is free and waitlisting it
// otherwise. Runs inside the caller's transaction.
async function insertApplication(tx, data, extra, { label, verifiedAt, source, meta, notes = "" }) {
  const aadhaarHash = hashAadhaar(data.aadhaar);
  const dup = await tx.queryOne(
    `SELECT id FROM vendor_registrations
      WHERE event_id = $1 AND aadhaar_hash = $2 AND deleted_at IS NULL AND status NOT IN ('rejected', 'cancelled')`,
    [data.event_id, aadhaarHash]
  );
  if (dup) throw conflict(DUPLICATE, "aadhaar");

  const remaining = await takeSlot(tx, data.event_id, data.quota_type);
  const status = remaining === null ? "waitlisted" : "pending";
  try {
    const row = await tx.queryOne(
      `INSERT INTO vendor_registrations
         (reference_no, event_id, quota_type, status, name, business_name, nature_of_business, category_id, category_label,
          aadhaar_cipher, aadhaar_last4, aadhaar_hash, udyam_number, caste_category, phone, phone_verified_at, email,
          extra, language, source, dm_notes, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19, $20, $21, $22, $23)
       RETURNING id, reference_no, status, quota_type, event_id, created_at`,
      [
        referenceNo(data.event_id), data.event_id, data.quota_type, status, data.name, data.business_name,
        data.nature_of_business, data.category_id, label, encryptAadhaar(data.aadhaar), data.aadhaar.slice(-4),
        aadhaarHash, data.udyam_number, data.caste_category, data.phone, verifiedAt, data.email,
        JSON.stringify(extra), data.language, source, notes, meta.ip ?? null, String(meta.userAgent ?? "").slice(0, 300),
      ]
    );
    return { ...row, available: remaining ?? 0 };
  } catch (err) {
    if (err?.code === "23505" && String(err.constraint).includes("one_per_event")) throw conflict(DUPLICATE, "aadhaar");
    throw err;
  }
}

export async function submit(body, meta) {
  const data = parseOrThrow(publicRegistrationSchema, body ?? {});
  // Bots filling the honeypot get a success-shaped response; nothing is stored.
  if (data.website) return { reference_no: null, status: "pending" };

  await bookableEvent(data.event_id, { publicOnly: true });
  const label = await categoryLabel(data.category_id);
  const form = await getForm("vendor_registration");
  const extra = validateAnswers(form.fields, data.extra);

  return transaction(async (tx) => {
    const verifiedAt = await consumeOtp(tx, data.otp_token, data.phone);
    if (!verifiedAt) throw validation([{ field: "phone", message: "Verify your mobile number with the OTP first" }]);
    return insertApplication(tx, data, extra, { label, verifiedAt, source: "public", meta });
  });
}

export async function createByManager(body, user, scope) {
  const data = parseOrThrow(managerRegistrationSchema, body ?? {});
  const event = await bookableEvent(data.event_id, { publicOnly: false });
  if (scope && event.district_id !== scope) throw notFound("Event");
  const label = await categoryLabel(data.category_id);
  const form = await getForm("vendor_registration");
  const extra = validateAnswers(form.fields, data.extra);
  const row = await transaction(async (tx) => {
    const inserted = await insertApplication(tx, data, extra, {
      label, verifiedAt: null, source: "manager", meta: {}, notes: data.dm_notes,
    });
    await audit(user, "create", "vendor_registrations", inserted.id, `Added ${data.quota_type} application ${inserted.reference_no} for ${data.name}`, tx);
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
      "(r.name ILIKE $? OR r.business_name ILIKE $? OR r.phone ILIKE $? OR r.reference_no ILIKE $? OR r.udyam_number ILIKE $?)");
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
