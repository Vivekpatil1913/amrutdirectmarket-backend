import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { query, queryOne } from "../../db/pool.js";
import { requireSuperadmin } from "../../middleware/auth.js";
import { AppError, asyncHandler, conflict, notFound, paginated, parseOrThrow, success } from "../../lib/errors.js";
import { idParam, paginationQuery, requiredString } from "../../lib/validators.js";
import { ROLES } from "../../lib/constants.js";
import { audit } from "../../lib/audit.js";
import { passwordRule } from "../auth/auth.routes.js";

const router = Router();
router.use(requireSuperadmin);

const id = (req) => parseOrThrow(idParam, req.params.id);
const COLUMNS = "id, email, name, role, is_active, last_login_at, locked_until, created_at, updated_at, deleted_at";

const base = {
  name: requiredString(100, "Name").refine((v) => v.length >= 2, "Name must contain at least 2 characters"),
  email: z.string({ required_error: "Email is required" }).trim().toLowerCase().email("Enter a valid email address").max(255),
  role: z.enum(ROLES, { errorMap: () => ({ message: "Choose a valid role" }) }),
  is_active: z.boolean().default(true),
};
const createSchema = z.object({ ...base, password: passwordRule });
const updateSchema = z.object({
  ...base,
  password: z.union([passwordRule, z.literal("")]).optional().default(""),
});
const listQuery = z.object({
  ...paginationQuery,
  role: z.union([z.enum(ROLES), z.literal("")]).optional().default(""),
  active: z.enum(["true", "false", ""]).optional().default(""),
});

async function assertEmailFree(email, excludeId = null) {
  const taken = await queryOne(
    "SELECT id FROM admin_users WHERE LOWER(email) = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR id <> $2)",
    [email, excludeId]
  );
  if (taken) throw conflict("Another user already uses this email", "email");
}

// The last active superadmin cannot be demoted, disabled or deleted, or no one
// could manage users any more.
async function assertNotLastSuperadmin(userId) {
  const row = await queryOne(
    `SELECT COUNT(*) AS count FROM admin_users
      WHERE role = 'superadmin' AND is_active = TRUE AND deleted_at IS NULL AND id <> $1`,
    [userId]
  );
  if (row.count === 0) throw new AppError("FORBIDDEN", "At least one active super admin must remain", 403);
}

router.get("/", asyncHandler(async (req, res) => {
  const q = parseOrThrow(listQuery, req.query);
  const where = [q.trash === "true" ? "deleted_at IS NOT NULL" : "deleted_at IS NULL"];
  const params = [];
  if (q.search) {
    params.push(`%${q.search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    where.push(`(name ILIKE $${params.length} OR email ILIKE $${params.length})`);
  }
  if (q.role) {
    params.push(q.role);
    where.push(`role = $${params.length}`);
  }
  if (q.active) {
    params.push(q.active === "true");
    where.push(`is_active = $${params.length}`);
  }
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const total = (await queryOne(`SELECT COUNT(*) AS count FROM admin_users ${whereSql}`, params)).count;
  params.push(q.limit, (q.page - 1) * q.limit);
  const rows = await query(
    `SELECT ${COLUMNS} FROM admin_users ${whereSql} ORDER BY created_at ASC, id ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return paginated(res, rows, total, q.page, q.limit);
}));

router.get("/:id", asyncHandler(async (req, res) => {
  const row = await queryOne(`SELECT ${COLUMNS} FROM admin_users WHERE id = $1`, [id(req)]);
  if (!row) throw notFound("User");
  return success(res, row);
}));

router.post("/", asyncHandler(async (req, res) => {
  const data = parseOrThrow(createSchema, req.body);
  await assertEmailFree(data.email);
  const hash = await bcrypt.hash(data.password, 12);
  const row = await queryOne(
    `INSERT INTO admin_users (email, name, password_hash, role, is_active)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
    [data.email, data.name, hash, data.role, data.is_active]
  );
  await audit(req.user, "create", "admin_users", row.id, `Created ${row.role} ${row.email}`);
  return success(res, row, 201);
}));

router.put("/:id", asyncHandler(async (req, res) => {
  const userId = id(req);
  const data = parseOrThrow(updateSchema, req.body);
  const existing = await queryOne("SELECT * FROM admin_users WHERE id = $1 AND deleted_at IS NULL", [userId]);
  if (!existing) throw notFound("User");
  if (existing.role === "superadmin" && (data.role !== "superadmin" || !data.is_active)) {
    await assertNotLastSuperadmin(userId);
  }
  await assertEmailFree(data.email, userId);
  const hash = data.password ? await bcrypt.hash(data.password, 12) : null;
  const row = await queryOne(
    `UPDATE admin_users
        SET name = $1, email = $2, role = $3, is_active = $4,
            password_hash = COALESCE($5, password_hash),
            failed_attempts = CASE WHEN $5 IS NULL THEN failed_attempts ELSE 0 END,
            locked_until = CASE WHEN $5 IS NULL THEN locked_until ELSE NULL END,
            updated_at = NOW()
      WHERE id = $6 RETURNING ${COLUMNS}`,
    [data.name, data.email, data.role, data.is_active, hash, userId]
  );
  // Disabling an account or resetting its password ends its open sessions.
  if (!data.is_active || hash) {
    await query("UPDATE admin_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
  }
  await audit(req.user, "update", "admin_users", userId, `Updated user ${row.email}${hash ? " (password reset)" : ""}`);
  return success(res, row);
}));

router.delete("/:id", asyncHandler(async (req, res) => {
  const userId = id(req);
  if (userId === req.user.id) throw new AppError("FORBIDDEN", "You cannot delete your own account", 403);
  const existing = await queryOne("SELECT role FROM admin_users WHERE id = $1 AND deleted_at IS NULL", [userId]);
  if (!existing) throw notFound("User");
  if (existing.role === "superadmin") await assertNotLastSuperadmin(userId);
  const row = await queryOne(
    "UPDATE admin_users SET deleted_at = NOW(), is_active = FALSE, updated_at = NOW() WHERE id = $1 RETURNING id, email",
    [userId]
  );
  await query("UPDATE admin_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
  await audit(req.user, "delete", "admin_users", userId, `Deleted user ${row.email}`);
  return success(res, { id: row.id, deleted: true });
}));

router.post("/:id/restore", asyncHandler(async (req, res) => {
  const userId = id(req);
  const existing = await queryOne("SELECT email FROM admin_users WHERE id = $1 AND deleted_at IS NOT NULL", [userId]);
  if (!existing) throw notFound("Deleted user");
  await assertEmailFree(existing.email.toLowerCase(), userId);
  const row = await queryOne(
    `UPDATE admin_users SET deleted_at = NULL, updated_at = NOW() WHERE id = $1 RETURNING ${COLUMNS}`,
    [userId]
  );
  await audit(req.user, "restore", "admin_users", userId, `Restored user ${row.email} (left inactive)`);
  return success(res, row);
}));

export default router;
