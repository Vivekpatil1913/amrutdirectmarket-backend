// End-to-end API test against a throwaway database (amrit_peth_cms_test).
// It is dropped and recreated on every run, so development data is untouched.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { loadEnvFile } from "../src/config/loadEnv.js";

loadEnvFile();
const TEST_DB = "amrit_peth_cms_test";
process.env.NODE_ENV = "test";
process.env.PGDATABASE = TEST_DB;
process.env.LOG_REQUESTS = "false";
process.env.SEED_ADMIN_EMAIL = "admin@test.local";
process.env.SEED_ADMIN_PASSWORD = "Admin@12345";
process.env.UPLOAD_DIR = mkdtempSync(path.join(os.tmpdir(), "ap-uploads-"));
process.env.LOGIN_MAX_ATTEMPTS = "3";

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

let server, base, pool, token, editorToken;

async function call(method, url, { body, auth = token, form } = {}) {
  const headers = {};
  if (auth) headers.Authorization = `Bearer ${auth}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(base + url, {
    method,
    headers,
    body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

before(async () => {
  const cfg = {
    host: process.env.PGHOST || "localhost",
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD || "",
  };
  const admin = new pg.Client({ ...cfg, database: "postgres" });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.end();

  const { ensureDatabase, runMigrations } = await import("../migrations/migrate.js");
  await ensureDatabase(TEST_DB, () => {});
  await runMigrations(TEST_DB, () => {});
  const { runSeed } = await import("../seeds/seed.js");
  await runSeed(() => {});

  ({ pool } = await import("../src/db/pool.js"));
  const { createApp } = await import("../src/app.js");
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
});

after(async () => {
  server?.close();
  await pool?.end();
});

test("health check reports the database", async () => {
  const r = await call("GET", "/health", { auth: null });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.database, "connected");
});

test("seeding is idempotent and never overwrites data", async () => {
  await pool.query("UPDATE categories SET name_en = 'Edited' WHERE slug = 'processed-food'");
  const { runSeed } = await import("../seeds/seed.js");
  await runSeed(() => {});
  const { rows } = await pool.query("SELECT COUNT(*) AS n FROM categories");
  assert.equal(rows[0].n, 8);
  const { rows: e } = await pool.query("SELECT name_en FROM categories WHERE slug = 'processed-food'");
  assert.equal(e[0].name_en, "Edited");
  const { rows: u } = await pool.query("SELECT COUNT(*) AS n FROM admin_users");
  assert.equal(u[0].n, 1);
});

test("authentication: protected routes, bad login, login, me", async () => {
  assert.equal((await call("GET", "/admin/categories", { auth: null })).status, 401);
  assert.equal((await call("GET", "/admin/categories", { auth: "garbage" })).status, 401);
  const bad = await call("POST", "/auth/login", { auth: null, body: { email: "admin@test.local", password: "nope" } });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error.message, "Invalid email or password");
  assert.equal(bad.body.error.stack, undefined);

  const ok = await call("POST", "/auth/login", { auth: null, body: { email: "ADMIN@test.local", password: "Admin@12345" } });
  assert.equal(ok.status, 200);
  token = ok.body.data.token;
  const me = await call("GET", "/auth/me");
  assert.equal(me.body.data.role, "superadmin");
  const { rows } = await pool.query("SELECT password_hash FROM admin_users LIMIT 1");
  assert.match(rows[0].password_hash, /^\$2[aby]\$/);
});

test("public site endpoint serves the seeded, published content", async () => {
  const r = await call("GET", "/public/site", { auth: null });
  assert.equal(r.status, 200);
  const { sections, collections } = r.body.data;
  assert.equal(sections.hero.title_mr, "अमृत पेठ");
  assert.match(sections.settings.logo, /^\/uploads\/media\//);
  assert.equal(collections.navItems.length, 5);
  assert.equal(collections.enquirySubjects.length, 6);
  assert.equal(collections.categories[0].deleted_at, undefined, "no admin columns leak");
});

test("collection workflow: create → publish → edit → unpublish → soft delete → restore", async () => {
  // Create as draft, with an auto-generated slug
  const created = await call("POST", "/admin/categories", {
    body: { name_mr: "मसाले", name_en: "Spices & Masala", status: "draft", display_order: 5 },
  });
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  assert.equal(created.body.data.slug, "spices-and-masala");
  const { rows } = await pool.query("SELECT * FROM categories WHERE id = $1", [id]);
  assert.equal(rows.length, 1, "stored in the database");

  const publicNames = async () =>
    (await call("GET", "/public/site", { auth: null })).body.data.collections.categories.map((c) => c.name_en);
  assert.ok(!(await publicNames()).includes("Spices & Masala"), "drafts are not public");

  // Publish
  assert.equal((await call("PATCH", `/admin/categories/${id}/status`, { body: { status: "published" } })).status, 200);
  assert.ok((await publicNames()).includes("Spices & Masala"));
  assert.equal((await publicNames())[0], "Spices & Masala", "display order respected");

  // Edit
  const edited = await call("PUT", `/admin/categories/${id}`, {
    body: { name_mr: "मसाले", name_en: "Spices", slug: "spices", status: "published", display_order: 5 },
  });
  assert.equal(edited.status, 200);
  assert.ok((await publicNames()).includes("Spices"));

  // Duplicate slug → 409 with field detail
  const dup = await call("POST", "/admin/categories", { body: { name_mr: "अ", slug: "spices" } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.details[0].field, "slug");

  // Unpublish
  await call("PATCH", `/admin/categories/${id}/status`, { body: { status: "draft" } });
  assert.ok(!(await publicNames()).includes("Spices"));

  // Soft delete: row remains, excluded from listings and public API
  assert.equal((await call("DELETE", `/admin/categories/${id}`)).status, 200);
  const { rows: still } = await pool.query("SELECT deleted_at FROM categories WHERE id = $1", [id]);
  assert.ok(still[0].deleted_at, "row kept with deleted_at");
  const list = await call("GET", "/admin/categories?limit=100");
  assert.ok(!list.body.data.some((c) => c.id === id));
  assert.equal((await call("GET", `/admin/categories/${id}`)).status, 404);
  const trash = await call("GET", "/admin/categories?trash=true");
  assert.ok(trash.body.data.some((c) => c.id === id));

  // The slug of a deleted record can be reused…
  const reuse = await call("POST", "/admin/categories", { body: { name_mr: "नवीन", slug: "spices" } });
  assert.equal(reuse.status, 201);
  // …and then restoring the old one is refused instead of creating a duplicate
  const blocked = await call("POST", `/admin/categories/${id}/restore`);
  assert.equal(blocked.status, 409);
  await call("DELETE", `/admin/categories/${reuse.body.data.id}`);
  assert.equal((await call("POST", `/admin/categories/${id}/restore`)).status, 200);
});

test("listing: search, filters, sorting and pagination", async () => {
  const page = await call("GET", "/admin/categories?limit=3&page=2&sort=display_order&order=asc");
  assert.equal(page.body.data.length, 3);
  assert.equal(page.body.meta.page, 2);
  assert.ok(page.body.meta.total >= 8);
  const search = await call("GET", "/admin/categories?search=textile");
  assert.equal(search.body.data.length, 1);
  const filtered = await call("GET", "/admin/nav-items?section=about");
  assert.equal(filtered.body.data.length, 1);
  const asc = (await call("GET", "/admin/categories?sort=name_en&order=asc&limit=100")).body.data.map((c) => c.name_en);
  const desc = (await call("GET", "/admin/categories?sort=name_en&order=desc&limit=100")).body.data.map((c) => c.name_en);
  assert.ok(asc.length > 1);
  assert.deepEqual(desc, [...asc].reverse());
  assert.equal((await call("GET", "/admin/categories?sort=password_hash")).status, 422, "unknown sort column rejected");
  assert.equal((await call("GET", "/admin/categories?search=%27%3B%20DROP%20TABLE%20categories%3B--")).status, 200);
  const { rows } = await pool.query("SELECT COUNT(*) AS n FROM categories");
  assert.ok(rows[0].n > 0, "injection attempt is inert");
});

test("validation errors return 422 with field details", async () => {
  const r = await call("POST", "/admin/social-links", { body: { label: "", url: "javascript:alert(1)", icon: "nope" } });
  assert.equal(r.status, 422);
  const fields = r.body.error.details.map((d) => d.field).sort();
  assert.deepEqual(fields, ["icon", "label", "url"]);
  assert.equal((await call("GET", "/admin/categories/abc")).status, 422);
});

test("sections: draft does not change the site until published; discard restores", async () => {
  const current = await call("GET", "/admin/sections/hero");
  const draft = { ...current.body.data.draft, title_en: "AMRUT Peth Draft" };
  const saved = await call("PUT", "/admin/sections/hero", { body: draft });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.has_unpublished_changes, true);
  let site = await call("GET", "/public/site", { auth: null });
  assert.equal(site.body.data.sections.hero.title_en, "AMRUT Peth");

  await call("POST", "/admin/sections/hero/publish");
  site = await call("GET", "/public/site", { auth: null });
  assert.equal(site.body.data.sections.hero.title_en, "AMRUT Peth Draft");

  await call("PUT", "/admin/sections/hero", { body: { ...draft, title_en: "Discard me" } });
  const discarded = await call("POST", "/admin/sections/hero/discard");
  assert.equal(discarded.body.data.draft.title_en, "AMRUT Peth Draft");

  const invalid = await call("PUT", "/admin/sections/hero", { body: { ...draft, title_mr: "" } });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.error.details[0].field, "title_mr");
});

test("media: upload, use in a section, protected from deletion while used", async () => {
  const form = new FormData();
  form.append("file", new Blob([PNG_1PX], { type: "image/png" }), "pixel.png");
  form.append("alt_text", "One pixel");
  const up = await call("POST", "/admin/media/upload", { form });
  assert.equal(up.status, 201);
  const media = up.body.data;
  assert.match(media.filename, /^\d+-[0-9a-f]{16}\.png$/);
  const img = await fetch(base.replace("/api/v1", "") + media.url);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("x-content-type-options"), "nosniff");

  // Fake image (script content) is rejected
  const fake = new FormData();
  fake.append("file", new Blob(["<script>alert(1)</script>"], { type: "image/png" }), "evil.png");
  assert.equal((await call("POST", "/admin/media/upload", { form: fake })).status, 422);
  // Non-image types are rejected
  const exe = new FormData();
  exe.append("file", new Blob(["MZ"], { type: "application/x-msdownload" }), "a.exe");
  assert.equal((await call("POST", "/admin/media/upload", { form: exe })).status, 422);

  // Use it as the about image and publish
  const about = (await call("GET", "/admin/sections/about")).body.data.draft;
  const pub = await call("PUT", "/admin/sections/about?publish=true", {
    body: { ...about, image: { media_id: media.id, url: "/ignored/by/server" } },
  });
  assert.equal(pub.body.data.published.image.url, media.url, "url comes from the library, not the client");
  const site = await call("GET", "/public/site", { auth: null });
  assert.equal(site.body.data.sections.about.image, media.url);

  const del = await call("DELETE", `/admin/media/${media.id}`);
  assert.equal(del.status, 409, "in-use image cannot be deleted");
  // A reference to a missing media id is refused
  const bad = await call("PUT", "/admin/sections/about", { body: { ...about, image: { media_id: 999999, url: "" } } });
  assert.equal(bad.status, 422);
});

test("enquiries: public submission, validation, admin follow-up, soft delete", async () => {
  const valid = {
    name: "Asha Patil", email: "asha@example.com", phone: "9876543210",
    subject: "stall", message: "I would like a stall at the Pune exhibition.", consent: true, language: "en",
  };
  const r = await call("POST", "/public/enquiries", { auth: null, body: valid });
  assert.equal(r.status, 201);
  const id = r.body.data.id;

  const bad = await call("POST", "/public/enquiries", { auth: null, body: { ...valid, subject: "nope", consent: false } });
  assert.equal(bad.status, 422);

  // Unpublished subject is no longer accepted
  const subj = (await call("GET", "/admin/enquiry-subjects?search=other")).body.data[0];
  await call("PATCH", `/admin/enquiry-subjects/${subj.id}/status`, { body: { status: "draft" } });
  assert.equal((await call("POST", "/public/enquiries", { auth: null, body: { ...valid, subject: "other" } })).status, 422);

  // Honeypot submissions are accepted silently but not stored
  const before = (await pool.query("SELECT COUNT(*) AS n FROM enquiries")).rows[0].n;
  await call("POST", "/public/enquiries", { auth: null, body: { ...valid, website: "http://spam" } });
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM enquiries")).rows[0].n, before);

  const listed = await call("GET", "/admin/enquiries?status=new&search=asha");
  assert.equal(listed.body.data[0].id, id);
  const upd = await call("PATCH", `/admin/enquiries/${id}`, { body: { status: "reviewed", admin_notes: "Called back" } });
  assert.equal(upd.body.data.status, "reviewed");
  assert.equal(upd.body.data.reviewed_by_name, "Super Admin");

  await call("DELETE", `/admin/enquiries/${id}`);
  const { rows } = await pool.query("SELECT deleted_at FROM enquiries WHERE id = $1", [id]);
  assert.ok(rows[0].deleted_at);
  const dash = await call("GET", "/admin/dashboard");
  assert.equal(dash.body.data.stats.totalEnquiries, 0, "deleted enquiries are not counted");
});

test("roles: editors edit content but cannot delete, change settings or manage users", async () => {
  const created = await call("POST", "/admin/users", {
    body: { name: "Editor One", email: "editor@test.local", role: "editor", password: "Editor123" },
  });
  assert.equal(created.status, 201);
  const weak = await call("POST", "/admin/users", { body: { name: "X Y", email: "x@test.local", role: "editor", password: "short" } });
  assert.equal(weak.status, 422);

  const login = await call("POST", "/auth/login", { auth: null, body: { email: "editor@test.local", password: "Editor123" } });
  editorToken = login.body.data.token;
  const nav = (await call("GET", "/admin/nav-items", { auth: editorToken })).body.data[0];
  assert.equal((await call("PATCH", `/admin/nav-items/${nav.id}/status`, { auth: editorToken, body: { status: "published" } })).status, 200);
  assert.equal((await call("DELETE", `/admin/nav-items/${nav.id}`, { auth: editorToken })).status, 403);
  assert.equal((await call("POST", "/admin/sections/settings/publish", { auth: editorToken })).status, 403);
  assert.equal((await call("GET", "/admin/users", { auth: editorToken })).status, 403);

  // Disabling the account ends its session immediately
  await call("PUT", `/admin/users/${created.body.data.id}`, {
    body: { name: "Editor One", email: "editor@test.local", role: "editor", is_active: false },
  });
  assert.equal((await call("GET", "/auth/me", { auth: editorToken })).status, 401);

  // The last super admin cannot delete themselves
  const me = (await call("GET", "/auth/me")).body.data;
  assert.equal((await call("DELETE", `/admin/users/${me.id}`)).status, 403);
});

test("login lockout after repeated failures", async () => {
  await call("POST", "/admin/users", { body: { name: "Lock Test", email: "lock@test.local", role: "editor", password: "Lockme123" } });
  for (let i = 0; i < 3; i += 1) {
    await call("POST", "/auth/login", { auth: null, body: { email: "lock@test.local", password: "wrong-pass-1" } });
  }
  const locked = await call("POST", "/auth/login", { auth: null, body: { email: "lock@test.local", password: "Lockme123" } });
  assert.equal(locked.status, 423);
});

test("audit log records admin actions; logout revokes the session", async () => {
  const log = await call("GET", "/admin/activity?action=delete");
  assert.ok(log.body.data.length > 0);
  assert.equal((await call("POST", "/auth/logout")).status, 200);
  assert.equal((await call("GET", "/auth/me")).status, 401);
});
