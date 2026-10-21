import { z } from "zod";
import { query, queryOne, transaction } from "../../db/pool.js";
import { conflict, notFound, parseOrThrow } from "../../lib/errors.js";
import { buildObjectSchema, storedKeys } from "../../lib/fieldSchema.js";
import { paginationQuery, slugify } from "../../lib/validators.js";
import { audit } from "../../lib/audit.js";
import { COMMON_FIELDS } from "./collections.config.js";

// Generic data access for content collections. Table and column names are
// interpolated into SQL, but they only ever come from collections.config.js —
// never from the request. Every value is a bound parameter.

const SYSTEM_SORTS = ["display_order", "status", "created_at", "updated_at", "id"];

export function compile(name, def) {
  const fields = [...def.fields, ...COMMON_FIELDS];
  const columns = fields.flatMap(storedKeys);
  const slugFields = def.fields.filter((f) => f.type === "slug");
  const sorts = [...new Set([...SYSTEM_SORTS, def.titleField])];
  const filterShape = Object.fromEntries(
    def.filters.map((col) => {
      const field = def.fields.find((f) => f.key === col);
      const values = field.options.map((o) => (typeof o === "string" ? o : o.value));
      return [col, z.union([z.enum(values), z.literal("")]).optional().default("")];
    })
  );
  return {
    ...def,
    name,
    fields,
    columns,
    slugFields,
    schema: buildObjectSchema(fields),
    listQuery: z.object({
      ...paginationQuery,
      status: z.union([z.enum(["published", "draft"]), z.literal("")]).optional().default(""),
      sort: z.enum(sorts).optional().default("display_order"),
      ...filterShape,
    }),
    unique: def.unique ?? [],
  };
}

// Returns the id of a live row (other than excludeId) using value in column.
async function findLive(c, column, value, excludeId = null, db = { queryOne }) {
  return db.queryOne(
    `SELECT id FROM ${c.table} WHERE ${column} = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR id <> $2)`,
    [value, excludeId]
  );
}

// Fills empty slug fields from their source field and makes generated slugs
// unique by suffixing -2, -3…; an explicitly entered duplicate is a conflict.
async function prepareUnique(c, data, excludeId) {
  const out = { ...data };
  for (const f of c.slugFields) {
    if (out[f.key]) continue;
    const base = slugify(out[f.from]) || slugify(out[storedKeys(c.fields[0])[1]]) || `${f.key}-${Date.now().toString(36)}`;
    let candidate = base;
    for (let n = 2; await findLive(c, f.key, candidate, excludeId); n += 1) candidate = `${base}-${n}`;
    out[f.key] = candidate;
  }
  for (const u of c.unique) {
    if (await findLive(c, u.column, out[u.column], excludeId)) throw conflict(u.message, u.column);
  }
  return out;
}

const label = (c, row) => row?.[c.titleField] || row?.[storedKeys(c.fields[0])[0]] || `#${row?.id}`;

export async function list(c, rawQuery) {
  const q = parseOrThrow(c.listQuery, rawQuery);
  const trash = q.trash === "true";
  const where = [trash ? "t.deleted_at IS NOT NULL" : "t.deleted_at IS NULL"];
  const params = [];

  if (q.search) {
    params.push(`%${q.search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    where.push(`(${c.search.map((col) => `t.${col} ILIKE $${params.length}`).join(" OR ")})`);
  }
  if (q.status) {
    params.push(q.status);
    where.push(`t.status = $${params.length}`);
  }
  for (const col of c.filters) {
    if (!q[col]) continue;
    params.push(q[col]);
    where.push(`t.${col} = $${params.length}`);
  }

  const whereSql = `WHERE ${where.join(" AND ")}`;
  const total = (await queryOne(`SELECT COUNT(*) AS count FROM ${c.table} t ${whereSql}`, params)).count;
  const order = q.order ?? (q.sort === "created_at" || q.sort === "updated_at" ? "desc" : "asc");
  const offset = (q.page - 1) * q.limit;
  params.push(q.limit, offset);
  const rows = await query(
    `SELECT t.*, u.name AS updated_by_name
       FROM ${c.table} t LEFT JOIN admin_users u ON u.id = t.updated_by
       ${whereSql}
      ORDER BY t.${q.sort} ${order.toUpperCase()}, t.id ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { rows, total, page: q.page, pageSize: q.limit };
}

export async function getById(c, id, { includeDeleted = false } = {}) {
  const row = await queryOne(
    `SELECT t.*, cu.name AS created_by_name, uu.name AS updated_by_name
       FROM ${c.table} t
       LEFT JOIN admin_users cu ON cu.id = t.created_by
       LEFT JOIN admin_users uu ON uu.id = t.updated_by
      WHERE t.id = $1 ${includeDeleted ? "" : "AND t.deleted_at IS NULL"}`,
    [id]
  );
  if (!row) throw notFound(c.entity);
  return row;
}

export async function create(c, body, user) {
  const data = await prepareUnique(c, parseOrThrow(c.schema, body), null);
  const cols = [...c.columns, "created_by", "updated_by"];
  const values = [...c.columns.map((k) => data[k]), user.id, user.id];
  const row = await transaction(async (tx) => {
    const inserted = await tx.queryOne(
      `INSERT INTO ${c.table} (${cols.join(", ")})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      values
    );
    await audit(user, "create", c.table, inserted.id, `Created ${c.entity.toLowerCase()} "${label(c, data)}"`, tx);
    return inserted;
  });
  return getById(c, row.id);
}

export async function update(c, id, body, user) {
  await getById(c, id);
  const data = await prepareUnique(c, parseOrThrow(c.schema, body), id);
  const sets = c.columns.map((k, i) => `${k} = $${i + 1}`);
  await transaction(async (tx) => {
    await tx.query(
      `UPDATE ${c.table} SET ${sets.join(", ")}, updated_by = $${c.columns.length + 1}, updated_at = NOW()
        WHERE id = $${c.columns.length + 2} AND deleted_at IS NULL`,
      [...c.columns.map((k) => data[k]), user.id, id]
    );
    await audit(user, "update", c.table, id, `Updated ${c.entity.toLowerCase()} "${label(c, data)}"`, tx);
  });
  return getById(c, id);
}

export async function setStatus(c, id, status, user) {
  const row = await queryOne(
    `UPDATE ${c.table} SET status = $1, updated_by = $2, updated_at = NOW()
      WHERE id = $3 AND deleted_at IS NULL RETURNING *`,
    [status, user.id, id]
  );
  if (!row) throw notFound(c.entity);
  await audit(user, "status", c.table, id, `${status === "published" ? "Published" : "Unpublished"} ${c.entity.toLowerCase()} "${label(c, row)}"`);
  return getById(c, id);
}

// Soft delete: the row stays in the table with deleted_at set.
export async function softDelete(c, id, user) {
  const row = await queryOne(
    `UPDATE ${c.table} SET deleted_at = NOW(), updated_by = $1, updated_at = NOW()
      WHERE id = $2 AND deleted_at IS NULL RETURNING *`,
    [user.id, id]
  );
  if (!row) throw notFound(c.entity);
  await audit(user, "delete", c.table, id, `Deleted ${c.entity.toLowerCase()} "${label(c, row)}"`);
  return { id: row.id, deleted: true };
}

export async function restore(c, id, user) {
  const row = await getById(c, id, { includeDeleted: true });
  if (!row.deleted_at) throw notFound(`Deleted ${c.entity.toLowerCase()}`);
  // A live record may have taken this record's unique value meanwhile.
  for (const u of c.unique) {
    if (await findLive(c, u.column, row[u.column], id)) {
      throw conflict(`Cannot restore: ${u.message.charAt(0).toLowerCase()}${u.message.slice(1)} ("${row[u.column]}")`, u.column);
    }
  }
  await query(
    `UPDATE ${c.table} SET deleted_at = NULL, updated_by = $1, updated_at = NOW() WHERE id = $2`,
    [user.id, id]
  );
  await audit(user, "restore", c.table, id, `Restored ${c.entity.toLowerCase()} "${label(c, row)}"`);
  return getById(c, id);
}

// Published, live records in display order, without admin bookkeeping columns.
export async function listPublic(c) {
  const cols = ["id", ...c.columns.filter((k) => k !== "status")];
  return query(
    `SELECT ${cols.join(", ")} FROM ${c.table}
      WHERE deleted_at IS NULL AND status = 'published'
      ORDER BY display_order ASC, id ASC`
  );
}

export async function counts(c) {
  return queryOne(
    `SELECT COUNT(*) FILTER (WHERE status = 'published') AS published,
            COUNT(*) FILTER (WHERE status = 'draft') AS draft,
            COUNT(*) AS total
       FROM ${c.table} WHERE deleted_at IS NULL`
  );
}
