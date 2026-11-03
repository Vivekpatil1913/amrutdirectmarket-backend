import crypto from "crypto";
import { z } from "zod";
import { queryOne } from "../../db/pool.js";
import { env } from "../../config/env.js";
import { AppError, parseOrThrow, validation } from "../../lib/errors.js";
import { mobileNumber } from "../../lib/validators.js";
import { hashOtp, newOtpCode } from "../../lib/identity.js";
import { logger } from "../../lib/logger.js";

// One-time codes proving an applicant controls the mobile number they enter.
// The verification id doubles as the token the registration form submits; it
// is only ever returned to the browser that requested the code.

const sendSchema = z.object({ phone: mobileNumber });
const verifySchema = z.object({
  request_id: z.string().uuid("Request a new code"),
  phone: mobileNumber,
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code"),
});

// No SMS gateway is integrated yet. Plug the provider in here.
async function deliver(phone, code) {
  if (env.otp.devEcho) {
    logger.debug("OTP generated (dev echo)", { phone: `XXXXXX${phone.slice(-4)}`, code });
    return;
  }
  logger.warn("OTP_DEV_ECHO is off but no SMS gateway is configured; the code was not delivered", {
    phone: `XXXXXX${phone.slice(-4)}`,
  });
}

export async function send(body, meta) {
  const { phone } = parseOrThrow(sendSchema, body ?? {});
  const recent = await queryOne(
    `SELECT COUNT(*) AS n, MAX(created_at) AS last FROM otp_verifications
      WHERE phone = $1 AND created_at > NOW() - INTERVAL '15 minutes'`,
    [phone]
  );
  if (recent.n >= 5) throw new AppError("RATE_LIMITED", "Too many codes requested for this number. Try again in 15 minutes.", 429);
  if (recent.last && Date.now() - new Date(recent.last).getTime() < 30 * 1000) {
    throw new AppError("RATE_LIMITED", "Please wait 30 seconds before requesting another code.", 429);
  }

  const id = crypto.randomUUID();
  const code = newOtpCode();
  const row = await queryOne(
    `INSERT INTO otp_verifications (id, phone, code_hash, expires_at, ip_address)
     VALUES ($1, $2, $3, NOW() + ($4 || ' minutes')::INTERVAL, $5) RETURNING id, expires_at`,
    [id, phone, hashOtp(id, code), String(env.otp.ttlMinutes), meta.ip]
  );
  await deliver(phone, code);
  return { request_id: row.id, expires_at: row.expires_at, ...(env.otp.devEcho ? { dev_code: code } : {}) };
}

export async function verify(body) {
  const data = parseOrThrow(verifySchema, body ?? {});
  const row = await queryOne(
    "SELECT * FROM otp_verifications WHERE id = $1 AND phone = $2 AND consumed_at IS NULL",
    [data.request_id, data.phone]
  );
  const fail = (message) => validation([{ field: "code", message }]);
  if (!row || new Date(row.expires_at) <= new Date()) throw fail("This code has expired. Request a new one.");
  if (row.verified_at) return { otp_token: row.id, phone: row.phone };
  if (row.attempts >= env.otp.maxAttempts) throw fail("Too many wrong attempts. Request a new code.");

  const expected = Buffer.from(row.code_hash, "hex");
  const actual = Buffer.from(hashOtp(row.id, data.code), "hex");
  if (!crypto.timingSafeEqual(expected, actual)) {
    await queryOne("UPDATE otp_verifications SET attempts = attempts + 1 WHERE id = $1", [row.id]);
    throw fail("Incorrect code");
  }
  await queryOne("UPDATE otp_verifications SET verified_at = NOW() WHERE id = $1", [row.id]);
  return { otp_token: row.id, phone: row.phone };
}

// Marks a verified token as used by a registration (inside its transaction).
// Returns the verification time, or null if the token is not usable.
export async function consume(db, token, phone) {
  if (!z.string().uuid().safeParse(token).success) return null;
  const row = await db.queryOne(
    `UPDATE otp_verifications SET consumed_at = NOW()
      WHERE id = $1 AND phone = $2 AND verified_at IS NOT NULL AND consumed_at IS NULL
        AND verified_at > NOW() - ($3 || ' minutes')::INTERVAL
      RETURNING verified_at`,
    [token, phone, String(env.otp.verifiedMinutes)]
  );
  return row?.verified_at ?? null;
}
