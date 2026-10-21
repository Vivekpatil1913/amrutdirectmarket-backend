import jwt from "jsonwebtoken";
import { query, queryOne } from "../db/pool.js";
import { env } from "../config/env.js";
import { asyncHandler, forbidden, unauthorized } from "../lib/errors.js";

export function tokenFrom(req) {
  return req.cookies?.[env.auth.cookieName] || req.headers.authorization?.replace(/^Bearer\s+/i, "") || null;
}

// Resolves the session behind the request's token (cookie or bearer header)
// and attaches req.user. Never rejects: routes decide whether auth is needed.
export async function attachUser(req, _res, next) {
  try {
    const token = tokenFrom(req);
    if (!token) return next();

    const payload = jwt.verify(token, env.jwt.secret);
    const session = await queryOne(
      `SELECT s.id, s.expires_at, u.id AS user_id, u.email, u.name, u.role, u.avatar_url
         FROM admin_sessions s
         JOIN admin_users u ON u.id = s.user_id
        WHERE s.id = $1 AND s.revoked_at IS NULL
          AND u.is_active = TRUE AND u.deleted_at IS NULL`,
      [payload.sid]
    );
    if (!session || new Date(session.expires_at) <= new Date()) return next();

    // Sliding expiry, written at most once every 5 minutes per session.
    const fresh = Date.now() + env.jwt.sessionHours * 3600 * 1000;
    if (fresh - new Date(session.expires_at).getTime() > 5 * 60 * 1000) {
      await query("UPDATE admin_sessions SET expires_at = $1 WHERE id = $2", [new Date(fresh), session.id]);
    }

    req.sessionId = session.id;
    req.user = {
      id: session.user_id,
      email: session.email,
      name: session.name,
      role: session.role,
      avatarUrl: session.avatar_url,
    };
  } catch {
    // Invalid / expired token — continue unauthenticated.
  }
  next();
}

export const requireAuth = asyncHandler(async (req, _res, next) => {
  if (!req.user) throw unauthorized();
  next();
});

// Role hierarchy: superadmin > admin > editor.
const RANK = { editor: 1, admin: 2, superadmin: 3 };

export function requireRole(minRole) {
  return asyncHandler(async (req, _res, next) => {
    if (!req.user) throw unauthorized();
    if ((RANK[req.user.role] ?? 0) < RANK[minRole]) throw forbidden();
    next();
  });
}

// Any signed-in CMS user may edit content; deleting and settings need admin.
export const requireEditor = requireRole("editor");
export const requireAdmin = requireRole("admin");
export const requireSuperadmin = requireRole("superadmin");
