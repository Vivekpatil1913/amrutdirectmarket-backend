import crypto from "crypto";
import { env } from "../config/env.js";

// Identity documents of stall applicants. The full Aadhaar number never leaves
// this module unencrypted: it is stored as AES-256-GCM ciphertext, shown only
// as its last four digits, and matched for duplicates through a keyed hash.

// Verhoeff checksum tables (UIDAI uses Verhoeff for the 12th Aadhaar digit).
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export function verhoeffValid(digits) {
  let c = 0;
  const rev = String(digits).split("").reverse();
  for (let i = 0; i < rev.length; i += 1) c = D[c][P[i % 8][Number(rev[i])]];
  return c === 0;
}

export const normalizeAadhaar = (value) => String(value ?? "").replace(/[\s-]/g, "");

// 12 digits, not starting with 0 or 1 (never issued), valid Verhoeff checksum.
export function isValidAadhaar(value) {
  const v = normalizeAadhaar(value);
  return /^[2-9]\d{11}$/.test(v) && verhoeffValid(v);
}

export const maskAadhaar = (last4) => `XXXX XXXX ${last4}`;

// Udyam Registration Number, e.g. UDYAM-MH-26-0012345.
export const UDYAM_RE = /^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/;
export const normalizeUdyam = (value) => String(value ?? "").trim().toUpperCase().replace(/\s+/g, "");

function keyBytes() {
  if (env.identity.aadhaarKey) return Buffer.from(env.identity.aadhaarKey, "hex");
  return crypto.createHash("sha256").update(`aadhaar:${env.jwt.secret}`).digest();
}

export function encryptAadhaar(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBytes(), iv);
  const data = Buffer.concat([cipher.update(normalizeAadhaar(value), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(".");
}

export function decryptAadhaar(payload) {
  const [version, iv, tag, data] = String(payload).split(".");
  if (version !== "v1") throw new Error("Unknown Aadhaar cipher version");
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyBytes(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

// Deterministic, keyed: equal numbers give equal hashes, but the hash cannot
// be reversed by enumerating the 10^12 possible numbers without the key.
export function hashAadhaar(value) {
  return crypto.createHmac("sha256", keyBytes()).update(normalizeAadhaar(value)).digest("hex");
}

