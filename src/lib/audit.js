import { query } from "../db/pool.js";
import { logger } from "./logger.js";

// Records an admin action in activity_logs. Auditing must never break the
// action itself, so a failed insert is logged and swallowed.
export async function audit(user, action, entity, entityId, summary = "", db = { query }) {
  try {
    await db.query(
      `INSERT INTO activity_logs (user_id, user_name, action, entity, entity_id, summary)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [user?.id ?? null, user?.name ?? "", action, entity, entityId == null ? null : String(entityId), summary.slice(0, 300)]
    );
  } catch (err) {
    logger.warn("Audit log write failed", { action, entity, message: err.message });
  }
}
