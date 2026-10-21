import { Router } from "express";
import { z } from "zod";
import { query, queryOne } from "../../db/pool.js";
import { requireAdmin } from "../../middleware/auth.js";
import { asyncHandler, paginated, parseOrThrow } from "../../lib/errors.js";
import { paginationQuery } from "../../lib/validators.js";

const router = Router();

const listQuery = z.object({
  ...paginationQuery,
  limit: z.coerce.number().int().min(1).max(100).default(25),
  action: z.string().trim().max(30).optional().default(""),
  entity: z.string().trim().max(40).optional().default(""),
});

// Read-only audit trail of admin actions.
router.get("/", requireAdmin, asyncHandler(async (req, res) => {
  const q = parseOrThrow(listQuery, req.query);
  const where = ["TRUE"];
  const params = [];
  if (q.search) {
    params.push(`%${q.search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    where.push(`(summary ILIKE $${params.length} OR user_name ILIKE $${params.length})`);
  }
  if (q.action) {
    params.push(q.action);
    where.push(`action = $${params.length}`);
  }
  if (q.entity) {
    params.push(q.entity);
    where.push(`entity = $${params.length}`);
  }
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const total = (await queryOne(`SELECT COUNT(*) AS count FROM activity_logs ${whereSql}`, params)).count;
  params.push(q.limit, (q.page - 1) * q.limit);
  const rows = await query(
    `SELECT * FROM activity_logs ${whereSql} ORDER BY created_at DESC, id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return paginated(res, rows, total, q.page, q.limit);
}));

export default router;
