import { query, queryOne } from "../../db/pool.js";
import { notFound, parseOrThrow, validation } from "../../lib/errors.js";
import { audit } from "../../lib/audit.js";
import { enquiryListQuery, enquirySchema, enquiryUpdateSchema } from "./enquiries.schema.js";

export async function submit(body, meta) {
  const data = parseOrThrow(enquirySchema, body ?? {});
  // Bots filling the honeypot get the same success response, but nothing is stored.
  if (data.website) return { id: null };

  const subject = await queryOne(
    `SELECT code, label_mr, label_en FROM enquiry_subjects
      WHERE code = $1 AND status = 'published' AND deleted_at IS NULL`,
    [data.subject]
  );
  if (!subject) throw validation([{ field: "subject", message: "Please select a valid subject" }]);

  const row = await queryOne(
    `INSERT INTO enquiries (name, email, phone, subject_code, subject_label, message, consent, language, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7, $8, $9)
     RETURNING id, created_at`,
    [
      data.name, data.email, data.phone, subject.code,
      subject.label_en || subject.label_mr, data.message, data.language,
      meta.ip, String(meta.userAgent ?? "").slice(0, 300),
    ]
  );
  return row;
}

export async function list(rawQuery) {
  const q = parseOrThrow(enquiryListQuery, rawQuery);
  const where = [q.trash === "true" ? "e.deleted_at IS NOT NULL" : "e.deleted_at IS NULL"];
  const params = [];
  const add = (value, sql) => {
    params.push(value);
    where.push(sql.replaceAll("$?", `$${params.length}`));
  };
  if (q.search) {
    add(`%${q.search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`,
      "(e.name ILIKE $? OR e.email ILIKE $? OR e.phone ILIKE $? OR e.message ILIKE $?)");
  }
  if (q.status) add(q.status, "e.status = $?");
  if (q.subject) add(q.subject, "e.subject_code = $?");
  if (q.from) add(q.from, "e.created_at >= $?::date");
  if (q.to) add(q.to, "e.created_at < ($?::date + INTERVAL '1 day')");

  const whereSql = `WHERE ${where.join(" AND ")}`;
  const total = (await queryOne(`SELECT COUNT(*) AS count FROM enquiries e ${whereSql}`, params)).count;
  const order = q.order ?? (q.sort === "created_at" ? "desc" : "asc");
  params.push(q.limit, (q.page - 1) * q.limit);
  const rows = await query(
    `SELECT e.id, e.name, e.email, e.phone, e.subject_code, e.subject_label, e.message, e.status,
            e.language, e.created_at, e.updated_at, e.deleted_at
       FROM enquiries e ${whereSql}
      ORDER BY e.${q.sort} ${order.toUpperCase()}, e.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { rows, total, page: q.page, pageSize: q.limit };
}

export async function getById(id, { includeDeleted = false } = {}) {
  const row = await queryOne(
    `SELECT e.*, u.name AS reviewed_by_name
       FROM enquiries e LEFT JOIN admin_users u ON u.id = e.reviewed_by
      WHERE e.id = $1 ${includeDeleted ? "" : "AND e.deleted_at IS NULL"}`,
    [id]
  );
  if (!row) throw notFound("Enquiry");
  return row;
}

export async function update(id, body, user) {
  const data = parseOrThrow(enquiryUpdateSchema, body ?? {});
  const before = await getById(id);
  await query(
    `UPDATE enquiries
        SET status = COALESCE($1, status),
            admin_notes = COALESCE($2, admin_notes),
            reviewed_by = $3, reviewed_at = NOW(), updated_at = NOW()
      WHERE id = $4 AND deleted_at IS NULL`,
    [data.status ?? null, data.admin_notes ?? null, user.id, id]
  );
  const changes = [];
  if (data.status && data.status !== before.status) changes.push(`status ${before.status} → ${data.status}`);
  if (data.admin_notes !== undefined && data.admin_notes !== before.admin_notes) changes.push("notes");
  await audit(user, "update", "enquiries", id, `Updated enquiry from ${before.name}${changes.length ? ` (${changes.join(", ")})` : ""}`);
  return getById(id);
}

export async function softDelete(id, user) {
  const row = await queryOne(
    "UPDATE enquiries SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING id, name",
    [id]
  );
  if (!row) throw notFound("Enquiry");
  await audit(user, "delete", "enquiries", id, `Deleted enquiry from ${row.name}`);
  return { id: row.id, deleted: true };
}

export async function restore(id, user) {
  const row = await queryOne(
    "UPDATE enquiries SET deleted_at = NULL, updated_at = NOW() WHERE id = $1 AND deleted_at IS NOT NULL RETURNING id, name",
    [id]
  );
  if (!row) throw notFound("Deleted enquiry");
  await audit(user, "restore", "enquiries", id, `Restored enquiry from ${row.name}`);
  return getById(id);
}
