import { copyFileSync, existsSync, mkdirSync, statSync } from "fs";
import { dirname, extname, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { env } from "../src/config/env.js";
import { pool } from "../src/db/pool.js";
import { MEDIA_SUBDIR } from "../src/middleware/upload.js";
import { SEED_COLLECTIONS, SEED_MEDIA, SEED_SECTIONS } from "./content.js";
import { SECTIONS, imageFields } from "../src/modules/sections/sections.config.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

// Idempotent baseline data. Safe to run repeatedly: it only inserts what is
// missing and never updates or removes anything an administrator has changed.

async function seedAdmin(log) {
  const { rows } = await pool.query("SELECT COUNT(*) AS count FROM admin_users WHERE deleted_at IS NULL");
  if (rows[0].count > 0) {
    log("✓ Admin users exist — none created");
    return;
  }
  const password = env.seed.adminPassword || crypto.randomBytes(9).toString("base64url");
  const hash = await bcrypt.hash(password, 12);
  await pool.query(
    "INSERT INTO admin_users (email, name, password_hash, role) VALUES ($1, $2, $3, 'superadmin')",
    [env.seed.adminEmail.toLowerCase(), env.seed.adminName, hash]
  );
  log(`✓ Super admin created: ${env.seed.adminEmail}`);
  if (!env.seed.adminPassword) log(`  Generated password: ${password}  (change it after first sign-in)`);
}

// Copies the original site photographs into the media library under fixed
// filenames, so re-running never duplicates them.
async function seedMedia(log) {
  const target = join(env.upload.dir, MEDIA_SUBDIR);
  mkdirSync(target, { recursive: true });
  const byFile = {};
  for (const { file, alt } of SEED_MEDIA) {
    const filename = `seed-${file}`;
    const src = resolve(__dir, "assets", file);
    const dest = join(target, filename);
    if (!existsSync(dest)) copyFileSync(src, dest);
    const { rows } = await pool.query(
      `INSERT INTO media_assets (filename, original_name, mime_type, size_bytes, url, alt_text)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (filename) DO UPDATE SET filename = EXCLUDED.filename
       RETURNING id, url`,
      [filename, file, MIME[extname(file)], statSync(dest).size, `/uploads/${MEDIA_SUBDIR}/${filename}`, alt]
    );
    byFile[file] = rows[0];
  }
  log(`✓ Media library has the ${SEED_MEDIA.length} original site images`);
  return byFile;
}

async function seedSections(media, log) {
  let created = 0;
  for (const def of SECTIONS) {
    const content = { ...SEED_SECTIONS[def.key] };
    for (const key of imageFields(def)) {
      const m = media[content[key]];
      content[key] = m ? { media_id: m.id, url: m.url } : { media_id: null, url: "" };
    }
    const json = JSON.stringify(content);
    const { rowCount } = await pool.query(
      `INSERT INTO page_sections (key, draft, published, published_at)
       VALUES ($1, $2::jsonb, $2::jsonb, NOW()) ON CONFLICT (key) DO NOTHING`,
      [def.key, json]
    );
    created += rowCount;
  }
  log(created ? `✓ Seeded ${created} page section(s)` : "✓ Page sections exist — left unchanged");
}

// A collection is seeded only while its table has never held a row (deleted
// rows included), so content an administrator removed does not come back.
async function seedCollections(log) {
  for (const [table, rows] of Object.entries(SEED_COLLECTIONS)) {
    const { rows: c } = await pool.query(`SELECT COUNT(*) AS count FROM ${table}`);
    if (c[0].count > 0) continue;
    for (const [i, row] of rows.entries()) {
      const record = { ...row, display_order: (i + 1) * 10, status: "published" };
      const cols = Object.keys(record);
      await pool.query(
        `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, n) => `$${n + 1}`).join(", ")})`,
        cols.map((k) => record[k])
      );
    }
    log(`✓ Seeded ${rows.length} row(s) into ${table}`);
  }
}

export async function runSeed(log = console.log) {
  await seedAdmin(log);
  const media = await seedMedia(log);
  await seedSections(media, log);
  await seedCollections(log);
  log("✓ Seed complete");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSeed()
    .then(() => pool.end())
    .catch(async (err) => {
      console.error("Seed failed:", err.message);
      await pool.end();
      process.exit(1);
    });
}
