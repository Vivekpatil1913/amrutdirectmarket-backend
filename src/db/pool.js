import pg from "pg";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

const { Pool } = pg;

// Keep DATE (oid 1082) as the plain 'YYYY-MM-DD' string Postgres sends, so a
// date never shifts a day when serialised from a local-midnight Date.
pg.types.setTypeParser(1082, (value) => value);
// COUNT(*) is BIGINT (oid 20); counts here always fit in a JS number.
pg.types.setTypeParser(20, (value) => Number.parseInt(value, 10));

export const pool = new Pool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  logger.error("Unexpected PostgreSQL pool error", { message: err.message });
});

export async function checkConnection() {
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
    logger.info(`PostgreSQL connected to ${env.db.database}`);
  } finally {
    client.release();
  }
}

export async function query(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

export async function queryOne(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows[0] ?? null;
}

// Runs fn inside BEGIN/COMMIT, rolling back on any error. fn receives the same
// query/queryOne helpers bound to the transaction's client.
export async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn({
      query: (sql, p = []) => client.query(sql, p).then((r) => r.rows),
      queryOne: (sql, p = []) => client.query(sql, p).then((r) => r.rows[0] ?? null),
    });
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
