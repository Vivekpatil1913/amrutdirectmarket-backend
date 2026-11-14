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

// Express "trust proxy": a hop count, true/false, or a list of addresses,
// subnets and names (loopback, linklocal, uniquelocal).
function trustProxy(value) {
  if (/^\d+$/.test(value)) return Number(value);
  if (value === "true" || value === "false") return value === "true";
  return value;
}

const nodeEnv = optional("NODE_ENV", "development");
const isProd = nodeEnv === "production";

const jwtSecret = optional("JWT_SECRET", isProd ? "" : "dev_only_secret_change_me");
if (isProd && jwtSecret.length < 32) {
  throw new Error("JWT_SECRET must be set to at least 32 characters in production");
}

// Key for encrypting Aadhaar numbers at rest (64 hex chars = 32 bytes).
const aadhaarKey = optional("AADHAAR_ENC_KEY", "");
if (isProd && !/^[0-9a-f]{64}$/i.test(aadhaarKey)) {
  throw new Error("AADHAAR_ENC_KEY must be 64 hex characters in production");
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

  // Sign-in protection counts wrong passwords only; a correct password is never
  // counted. See src/modules/auth/loginGuard.js.
  auth: {
    lockMinutes: int("LOGIN_LOCK_MINUTES", 15), // window, and how long a pause/lock lasts
    maxAttempts: int("LOGIN_MAX_ATTEMPTS", 10), // per account, from one address
    ipMaxAttempts: int("LOGIN_IP_MAX_ATTEMPTS", 100), // per address, across all accounts
    accountMaxAttempts: int("LOGIN_ACCOUNT_MAX_ATTEMPTS", 50), // per account, all addresses, in a row (0 = off)
    cookieName: "ap_admin_session",
  },

  http: {
    // Which proxies may report the client address (X-Forwarded-For). The
    // default trusts nginx on this host and an AWS load balancer in the VPC,
    // and stops at the first public address, which is the visitor's.
    trustProxy: trustProxy(optional("TRUST_PROXY", "loopback, linklocal, uniquelocal")),
    // General API requests per 15 minutes: per signed-in account, otherwise
    // per address.
    rateLimit: int("API_RATE_LIMIT", 1000),
  },

  cors: {
    // Comma-separated list of browser origins allowed to call the API.
    origins: optional("CORS_ORIGINS", "http://localhost:5173,http://localhost:4173")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  },

  identity: {
    // Outside production a key is derived from JWT_SECRET so a fresh checkout
    // works; production refuses to start without a real one (above).
    aadhaarKey,
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
