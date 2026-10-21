import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { query, queryOne } from "../../db/pool.js";
import { env } from "../../config/env.js";
import { requireAuth, tokenFrom } from "../../middleware/auth.js";
import { asyncHandler, AppError, conflict, parseOrThrow, success, unauthorized } from "../../lib/errors.js";
import { requiredString } from "../../lib/validators.js";
import { audit } from "../../lib/audit.js";

const router = Router();

const loginLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.isTest ? 1000 : 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many sign-in attempts. Please try again later." } },
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address").max(255),
  password: z.string().min(1, "Password is required").max(128),
});

const profileSchema = z.object({
  name: requiredString(100, "Name").refine((v) => v.length >= 2, "Name must contain at least 2 characters"),
  email: z.string().trim().toLowerCase().email("Enter a valid email address").max(255),
});

export const passwordRule = z
  .string()
  .min(8, "Password must contain at least 8 characters")
  .max(128)
  .regex(/[A-Za-z]/, "Password must contain a letter")
  .regex(/[0-9]/, "Password must contain a number");

const passwordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: passwordRule,
});

export const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  avatarUrl: u.avatar_url ?? null,
});

// A real bcrypt hash compared when the email is unknown, so response time does
// not reveal whether an account exists.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

router.post(
  "/login",
  loginLimit,
  asyncHandler(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) throw unauthorized("Invalid email or password");
    const { email, password } = parsed.data;

    const user = await queryOne(
      `SELECT id, email, name, role, avatar_url, password_hash, is_active, failed_attempts, locked_until
         FROM admin_users WHERE LOWER(email) = $1 AND deleted_at IS NULL`,
      [email]
    );

    if (!user) {
      await bcrypt.compare(password, DUMMY_HASH);
      throw unauthorized("Invalid email or password");
    }
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const minutes = Math.ceil((new Date(user.locked_until) - Date.now()) / 60000);
      throw new AppError("ACCOUNT_LOCKED", `Too many failed attempts. Try again in ${minutes} minute(s).`, 423);
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      const attempts = user.failed_attempts + 1;
      const lock = attempts >= env.auth.maxAttempts;
      await query(
        `UPDATE admin_users
            SET failed_attempts = $1,
                locked_until = CASE WHEN $2 THEN NOW() + ($3 || ' minutes')::INTERVAL ELSE locked_until END
          WHERE id = $4`,
        [lock ? 0 : attempts, lock, String(env.auth.lockMinutes), user.id]
      );
      throw unauthorized("Invalid email or password");
    }
    if (!user.is_active) throw unauthorized("This account is disabled. Contact a super admin.");

    await query(
      "UPDATE admin_users SET failed_attempts = 0, locked_until = NULL, last_login_at = NOW() WHERE id = $1",
      [user.id]
    );

    const expiresAt = new Date(Date.now() + env.jwt.sessionHours * 3600 * 1000);
    const session = await queryOne(
      `INSERT INTO admin_sessions (user_id, expires_at, ip_address, user_agent)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [user.id, expiresAt, req.ip, String(req.get("user-agent") ?? "").slice(0, 300)]
    );
    const token = jwt.sign({ sid: session.id }, env.jwt.secret, { expiresIn: `${env.jwt.sessionHours}h` });

    res.cookie(env.auth.cookieName, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: env.isProd,
      maxAge: env.jwt.sessionHours * 3600 * 1000,
    });
    await audit(user, "login", "auth", user.id, `Signed in from ${req.ip}`);
    return success(res, { token, expiresAt, user: publicUser(user) });
  })
);

router.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const token = tokenFrom(req);
    if (token) {
      try {
        const payload = jwt.verify(token, env.jwt.secret);
        await query("UPDATE admin_sessions SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL", [payload.sid]);
      } catch {
        // already invalid — nothing to revoke
      }
    }
    res.clearCookie(env.auth.cookieName);
    return success(res, { message: "Signed out" });
  })
);

router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => success(res, { ...req.user }))
);

router.put(
  "/profile",
  requireAuth,
  asyncHandler(async (req, res) => {
    const data = parseOrThrow(profileSchema, req.body);
    const taken = await queryOne(
      "SELECT id FROM admin_users WHERE LOWER(email) = $1 AND id <> $2 AND deleted_at IS NULL",
      [data.email, req.user.id]
    );
    if (taken) throw conflict("That email address is already in use", "email");
    const user = await queryOne(
      `UPDATE admin_users SET name = $1, email = $2, updated_at = NOW()
        WHERE id = $3 RETURNING id, email, name, role, avatar_url`,
      [data.name, data.email, req.user.id]
    );
    await audit(req.user, "update", "profile", req.user.id, "Updated own profile");
    return success(res, publicUser(user));
  })
);

router.post(
  "/change-password",
  requireAuth,
  asyncHandler(async (req, res) => {
    const data = parseOrThrow(passwordSchema, req.body);
    const user = await queryOne("SELECT password_hash FROM admin_users WHERE id = $1", [req.user.id]);
    if (!user || !(await bcrypt.compare(data.currentPassword, user.password_hash))) {
      throw new AppError("VALIDATION_ERROR", "Current password is incorrect", 422, [
        { field: "currentPassword", message: "Current password is incorrect" },
      ]);
    }
    const hash = await bcrypt.hash(data.newPassword, 12);
    await query("UPDATE admin_users SET password_hash = $1, updated_at = NOW() WHERE id = $2", [hash, req.user.id]);
    // Sign out every other session for this account.
    await query(
      "UPDATE admin_sessions SET revoked_at = NOW() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL",
      [req.user.id, req.sessionId]
    );
    await audit(req.user, "update", "profile", req.user.id, "Changed password");
    return success(res, { message: "Password changed" });
  })
);

export default router;
