import { readdirSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import pg from "pg";
import { loadEnvFile } from "../src/config/loadEnv.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dir, "sql");

function pgConfig() {
  return {
    host: process.env.PGHOST || "localhost",
    port: Number.parseInt(process.env.PGPORT || "5432", 10),
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD || "",
  };
}

// Database names are interpolated into CREATE DATABASE (identifiers cannot be
// bound as parameters), so only a safe identifier is accepted.
function assertSafeDbName(name) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`Unsafe database name: ${name}`);
}

export async function ensureDatabase(dbName, log = console.log) {
  assertSafeDbName(dbName);
  const admin = new pg.Pool({ ...pgConfig(), database: "postgres" });
  try {
    const { rows } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (rows.length === 0) {
      await admin.query(`CREATE DATABASE "${dbName}" ENCODING 'UTF8'`);
      log(`✓ Created database ${dbName}`);
    } else {
      log(`✓ Database ${dbName} exists`);
    }
  } finally {
    await admin.end();
  }
}

// Applies every migrations/sql/NNN_*.sql file not yet recorded in
// schema_migrations, each in its own transaction, in filename order.
export async function runMigrations(dbName, log = console.log) {
  const pool = new pg.Pool({ ...pgConfig(), database: dbName });
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const { rows } = await pool.query("SELECT name FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.name));
    const files = readdirSync(SQL_DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(resolve(SQL_DIR, file), "utf-8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        log(`✓ Applied ${file}`);
        count += 1;
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`${file}: ${err.message}`);
      } finally {
        client.release();
      }
    }
    log(count ? `✓ ${count} migration(s) applied` : "✓ Schema is up to date");
  } finally {
    await pool.end();
  }
}

async function main() {
  loadEnvFile();
  const dbName = process.env.PGDATABASE || "amrit_peth_cms";
  await ensureDatabase(dbName);
  await runMigrations(dbName);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Migration failed:", err.message);
    process.exit(1);
  });
}
