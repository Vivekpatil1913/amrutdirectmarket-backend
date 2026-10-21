import { resolve, isAbsolute } from "path";
import { loadEnvFile, ROOT_DIR } from "./loadEnv.js";

loadEnvFile();

function optional(name, fallback = "") {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function int(name, fallback) {
  const value = Number.parseInt(optional(name, String(fallback)), 10);
  return Number.isFinite(value) ? value : fallback;
}

const nodeEnv = optional("NODE_ENV", "development");
const isProd = nodeEnv === "production";

const jwtSecret = optional("JWT_SECRET", isProd ? "" : "dev_only_secret_change_me");
if (isProd && jwtSecret.length < 32) {
  throw new Error("JWT_SECRET must be set to at least 32 characters in production");
}

const uploadDir = optional("UPLOAD_DIR", "uploads");

export const env = {
  nodeEnv,
  isProd,
  isDev: nodeEnv === "development",
  isTest: nodeEnv === "test",
  port: int("PORT", 4200),

  db: {
    host: optional("PGHOST", "localhost"),
    port: int("PGPORT", 5432),
    user: optional("PGUSER", "postgres"),
    password: optional("PGPASSWORD", ""),
    database: optional("PGDATABASE", "amrit_peth_cms"),
  },

  jwt: {
    secret: jwtSecret,
    sessionHours: int("SESSION_HOURS", 8),
  },

  auth: {
    maxAttempts: int("LOGIN_MAX_ATTEMPTS", 5),
    lockMinutes: int("LOGIN_LOCK_MINUTES", 15),
    cookieName: "ap_admin_session",
  },

  cors: {
    // Comma-separated list of browser origins allowed to call the API.
    origins: optional("CORS_ORIGINS", "http://localhost:5173,http://localhost:4173")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  },

  upload: {
    dir: isAbsolute(uploadDir) ? uploadDir : resolve(ROOT_DIR, uploadDir),
    maxMb: int("MAX_FILE_SIZE_MB", 5),
  },

  seed: {
    adminEmail: optional("SEED_ADMIN_EMAIL", "admin@amritpeth.local"),
    adminPassword: optional("SEED_ADMIN_PASSWORD", ""),
    adminName: optional("SEED_ADMIN_NAME", "Super Admin"),
  },

  logRequests: optional("LOG_REQUESTS", isProd ? "false" : "true") === "true",
};
