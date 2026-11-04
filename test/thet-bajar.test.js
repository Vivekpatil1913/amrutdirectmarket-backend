// End-to-end tests for the Bajar Peth features (event creation with super
// admin approval, stall slots, the form-builder driven stall booking with
// document uploads, role-based portals, sponsors, home statistics,
// analytics) against their own throwaway database.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { loadEnvFile } from "../src/config/loadEnv.js";

loadEnvFile();
const TEST_DB = "amrit_peth_cms_tbp_test";
process.env.NODE_ENV = "test";
process.env.PGDATABASE = TEST_DB;
process.env.LOG_REQUESTS = "false";
process.env.SEED_ADMIN_EMAIL = "admin@test.local";
process.env.SEED_ADMIN_PASSWORD = "Admin@12345";
process.env.UPLOAD_DIR = mkdtempSync(path.join(os.tmpdir(), "ap-tbp-uploads-"));
const BOOKING_DIR = path.join(process.env.UPLOAD_DIR, "private", "bookings");

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");

let server, base, pool, verhoeffValid;
let admin, pune, nashik; // tokens
let districts, categoryIds, eventId;

async function call(method, url, { body, auth = admin, form } = {}) {
  const headers = {};
  if (auth) headers.Authorization = `Bearer ${auth}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(base + url, {
    method,
    headers,
    body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const type = res.headers.get("content-type") ?? "";
  const json = type.includes("json") ? await res.json().catch(() => ({})) : {};
  return { status: res.status, body: json, res };
}

const fieldsOf = (r) => (r.body.error?.details ?? []).map((d) => d.field).sort();

// A unique, checksum-valid Aadhaar number and mobile number per applicant.
let seq = 0;
function aadhaar() {
  seq += 1;
  const eleven = `2${String(1000000000 + seq).slice(-10)}`;
  for (let d = 0; d <= 9; d += 1) if (verhoeffValid(`${eleven}${d}`)) return `${eleven}${d}`;
  throw new Error("unreachable");
}
let phoneSeq = 0;
const phone = () => `98${String(10000000 + (phoneSeq += 1)).slice(-8)}`;

const applicant = (overrides = {}) => ({
  event_id: eventId, name: "Asha Patil", business_name: "Asha Gruh Udyog", nature_of_business: "food_processing",
  product_categories: [categoryIds[0]], aadhaar: aadhaar(), caste_category: "open", phone: phone(),
  consent: true, language: "en",
  ...overrides,
});

// A booking as the site sends it: JSON answers in `payload`, files by field key.
async function book(overrides = {}, files = {}) {
  const payload = applicant(overrides);
  const form = new FormData();
  form.append("payload", JSON.stringify(payload));
  for (const [key, f] of Object.entries(files)) form.append(key, new Blob([f.data], { type: f.type }), f.name);
  const r = await call("POST", "/public/registrations", { auth: null, form });
  return { ...r, payload };
}
const certificate = { caste_certificate: { data: PDF, type: "application/pdf", name: "certificate.pdf" } };
const reserved = (o = {}) => book({ caste_category: "sc", caste_name: "Mahar", ...o }, certificate);

const slots = async (id = eventId) => (await call("GET", `/public/events/${id}/slots`, { auth: null })).body.data;
const home = async () => (await call("GET", "/public/thet-bajar", { auth: null })).body.data;
const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const eventBody = (o = {}) => ({
  title_mr: "पुणे बाजार पेठ", title_en: "Pune Bajar Peth", venue_mr: "शिवाजीनगर", venue_en: "Shivajinagar",
  city_mr: "पुणे", city_en: "Pune", start_date: today(), end_date: inDays(3), event_time: "10:00 AM – 8:00 PM",
  venue_map_link: "https://maps.google.com/?q=Shivajinagar", contact_phone: "9822012345", total_stalls: 4,
  quotas: { ews: 1, sponsored: 1 }, ...o,
});

// A district manager's event, approved by the super admin.
async function approvedEvent(o = {}, auth = pune) {
  const r = await call("POST", "/admin/events", { auth, body: eventBody(o) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const ok = await call("POST", `/admin/events/${r.body.data.id}/review`, { body: { decision: "approved" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  return ok.body.data;
}

before(async () => {
  const cfg = {
    host: process.env.PGHOST || "localhost",
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD || "",
  };
  const c = new pg.Client({ ...cfg, database: "postgres" });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await c.end();

  const { ensureDatabase, runMigrations } = await import("../migrations/migrate.js");
  await ensureDatabase(TEST_DB, () => {});
  await runMigrations(TEST_DB, () => {});
  const { runSeed } = await import("../seeds/seed.js");
  await runSeed(() => {});
  ({ verhoeffValid } = await import("../src/lib/identity.js"));

  ({ pool } = await import("../src/db/pool.js"));
  const { createApp } = await import("../src/app.js");
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}/api/v1`;

  admin = (await call("POST", "/auth/login", { auth: null, body: { email: "admin@test.local", password: "Admin@12345" } })).body.data.token;
  districts = (await call("GET", "/admin/districts")).body.data;
  categoryIds = (await pool.query("SELECT id FROM categories WHERE status = 'published' ORDER BY id LIMIT 3")).rows.map((r) => r.id);
});

after(async () => {
  server?.close();
  await pool?.end();
});

const district = (code) => districts.find((d) => d.code === code);

test("all 36 Maharashtra districts are seeded with coordinates", () => {
  assert.equal(districts.length, 36);
  const p = district("pune");
  assert.equal(p.name_mr, "पुणे");
  assert.ok(p.lat > 18 && p.lat < 19 && p.lng > 73 && p.lng < 74);
});

test("RBAC: district managers need a district and get the portal, not the CMS", async () => {
  const noDistrict = await call("POST", "/admin/users", {
    body: { name: "DM Pune", email: "dm.pune@test.local", role: "district_manager", password: "Manager123" },
  });
  assert.equal(noDistrict.status, 422);
  assert.deepEqual(fieldsOf(noDistrict), ["district_id"]);

  for (const [code, email] of [["pune", "dm.pune@test.local"], ["nashik", "dm.nashik@test.local"]]) {
    const r = await call("POST", "/admin/users", {
      body: { name: `DM ${code}`, email, role: "district_manager", password: "Manager123", district_id: district(code).id },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.district_id, district(code).id);
  }
  // An editor's district is dropped: other roles are statewide.
  const editor = await call("POST", "/admin/users", {
    body: { name: "Ed Itor", email: "ed@test.local", role: "editor", password: "Editor123", district_id: district("pune").id },
  });
  assert.equal(editor.body.data.district_id, null);

  const login = async (email) => (await call("POST", "/auth/login", { auth: null, body: { email, password: "Manager123" } })).body.data;
  const p = await login("dm.pune@test.local");
  assert.equal(p.user.role, "district_manager");
  assert.equal(p.user.districtId, district("pune").id);
  pune = p.token;
  nashik = (await login("dm.nashik@test.local")).token;

  assert.equal((await call("GET", "/admin/categories", { auth: pune })).status, 403, "no website CMS");
  assert.equal((await call("GET", "/admin/dashboard", { auth: pune })).status, 403);
  assert.equal((await call("GET", "/admin/users", { auth: pune })).status, 403);
  assert.equal((await call("GET", "/admin/forms/vendor_registration", { auth: pune })).status, 403, "form builder is super admin only");
  assert.equal((await call("GET", "/admin/events", { auth: pune })).status, 200);
  assert.equal((await call("GET", "/admin/portal/meta", { auth: pune })).status, 200);

  const editorToken = (await call("POST", "/auth/login", { auth: null, body: { email: "ed@test.local", password: "Editor123" } })).body.data.token;
  assert.equal((await call("GET", "/admin/events", { auth: editorToken })).status, 403, "CMS editors have no portal");
  assert.equal((await call("GET", "/admin/events", { auth: null })).status, 401);
});

test("create event: mandatory fields, stall availability split, own district only", async () => {
  const invalid = await call("POST", "/admin/events", {
    auth: pune, body: { title_mr: "", venue_mr: "x", start_date: inDays(3), end_date: inDays(1) },
  });
  assert.equal(invalid.status, 422);
  assert.deepEqual(fieldsOf(invalid), ["contact_phone", "event_time", "title_mr", "total_stalls", "venue_map_link"]);

  const dates = await call("POST", "/admin/events", { auth: pune, body: eventBody({ start_date: inDays(3), end_date: inDays(1) }) });
  assert.deepEqual(fieldsOf(dates), ["end_date"]);
  const tooMany = await call("POST", "/admin/events", { auth: pune, body: eventBody({ total_stalls: 2, quotas: { ews: 2, sponsored: 1 } }) });
  assert.deepEqual(fieldsOf(tooMany), ["quotas.ews"]);
  const badLink = await call("POST", "/admin/events", { auth: pune, body: eventBody({ venue_map_link: "javascript:alert(1)", contact_phone: "12345" }) });
  assert.deepEqual(fieldsOf(badLink), ["contact_phone", "venue_map_link"]);

  const r = await call("POST", "/admin/events", {
    auth: pune, body: eventBody({ district_id: district("nashik").id /* ignored for a manager */, sponsor_name: "Pune Agro Co-op" }),
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  eventId = r.body.data.id;
  const e = r.body.data;
  assert.equal(e.district_id, district("pune").id);
  assert.equal(e.phase, "live");
  assert.equal(e.total_stalls, 4);
  assert.deepEqual(e.quotas, { general: { total: 2, available: 2 }, ews: { total: 1, available: 1 }, sponsored: { total: 1, available: 1 } });
  assert.equal(e.event_time, "10:00 AM – 8:00 PM");
  assert.equal(e.contact_phone, "9822012345");

  assert.equal((await call("GET", `/admin/events/${eventId}`, { auth: nashik })).status, 404, "other districts cannot see it");
  assert.equal((await call("PUT", `/admin/events/${eventId}`, { auth: nashik, body: eventBody() })).status, 404);
  assert.equal((await call("GET", "/admin/events", { auth: nashik })).body.meta.total, 0);
  const noDistrict = await call("POST", "/admin/events", { body: eventBody() });
  assert.deepEqual(fieldsOf(noDistrict), ["district_id"], "super admins must say which district");
});

test("approval: a manager's event is public and bookable only after a super admin approves it", async () => {
  const created = (await call("GET", `/admin/events/${eventId}`, { auth: pune })).body.data;
  assert.equal(created.approval_status, "pending");
  assert.equal((await home()).events.length, 0, "pending events are not on the site");
  assert.equal((await call("GET", `/public/events/${eventId}`, { auth: null })).status, 404);
  assert.deepEqual(fieldsOf(await book()), ["event_id"], "pending events cannot be booked");
  assert.ok(!(await home()).sponsors.some((s) => s.name === "Pune Agro Co-op"), "nor is their sponsor shown");

  const queue = await call("GET", "/admin/events?approval=pending&sort=submitted_at");
  assert.deepEqual(queue.body.data.map((e) => e.id), [eventId]);
  assert.equal((await call("POST", `/admin/events/${eventId}/review`, { auth: pune, body: { decision: "approved" } })).status, 403);
  assert.deepEqual(fieldsOf(await call("POST", `/admin/events/${eventId}/review`, { body: { decision: "rejected" } })), ["note"]);

  const rejected = await call("POST", `/admin/events/${eventId}/review`, { body: { decision: "rejected", note: "Add the venue map" } });
  assert.equal(rejected.body.data.approval_status, "rejected");
  assert.equal((await home()).events.length, 0);

  // Editing sends it back to the queue.
  const resubmitted = await call("PUT", `/admin/events/${eventId}`, { auth: pune, body: { ...eventBody(), sponsor_name: "Pune Agro Co-op" } });
  assert.equal(resubmitted.body.data.approval_status, "pending");
  assert.equal(resubmitted.body.data.review_note, "");

  const approved = await call("POST", `/admin/events/${eventId}/review`, { body: { decision: "approved" } });
  assert.equal(approved.body.data.approval_status, "approved");
  assert.equal(approved.body.data.reviewed_by_name, "Super Admin");
  const data = await home();
  assert.deepEqual(data.events.map((e) => e.id), [eventId]);
  assert.equal(data.events[0].city_en, "Pune");
  assert.ok(data.sponsors.some((s) => s.name === "Pune Agro Co-op" && s.id === `event-${eventId}`), "an approved event's sponsor is shown");

  const log = await call("GET", "/admin/activity?action=status");
  assert.ok(log.body.data.some((a) => a.summary.startsWith("Approved event")), "approvals are audited");

  // A super admin's own event needs no approval.
  const own = await call("POST", "/admin/events", { body: eventBody({ district_id: district("nashik").id, start_date: inDays(10), end_date: inDays(11) }) });
  assert.equal(own.body.data.approval_status, "approved");
  await call("DELETE", `/admin/events/${own.body.data.id}`);
});

test("event photos are limited by type and size, and a long description is cut for the carousel", async () => {
  const long = await approvedEvent({
    title_en: "Story from description", description_en: "x".repeat(150), start_date: inDays(-9), end_date: inDays(-8),
  });
  const { stories } = await home();
  assert.equal(stories.find((s) => s.event_id === long.id).story_en.length, 100, "a long description is cut to 100 characters");

  const media = async (mime, bytes) => (await pool.query(
    `INSERT INTO media_assets (filename, original_name, mime_type, size_bytes, url, alt_text)
     VALUES ($1, 'cover', $2, $3, $4, '') RETURNING id`,
    [`cover-${mime.replace("/", "-")}-${bytes}`, mime, bytes, `/uploads/media/cover-${bytes}`]
  )).rows[0].id;
  const withCover = async (id) => call("POST", "/admin/events", { body: eventBody({ district_id: district("nashik").id, cover_media_id: id }) });
  const big = await withCover(await media("image/webp", 3 * 1024 * 1024 + 1));
  assert.equal(big.status, 422);
  assert.match(JSON.stringify(big.body), /at most 3 MB/);
  const gif = await withCover(await media("image/gif", 1000));
  assert.equal(gif.status, 422);
  assert.match(JSON.stringify(gif.body), /JPG, PNG or WebP/);
  const ok = await withCover(await media("image/webp", 3 * 1024 * 1024));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));

  for (const id of [long.id, ok.body.data.id]) await call("DELETE", `/admin/events/${id}`);
});

test("public home data: statistics, highlights, district event counts and the slot counter", async () => {
  const past = await approvedEvent({ title_en: "Pune Diwali Bajar", start_date: inDays(-20), end_date: inDays(-18) });
  const data = await home();
  assert.equal(data.stats.total_events, 1, "only completed events count");
  assert.equal(data.stats.live_events, 1);
  assert.equal(data.stats.total_participants, 0);
  assert.ok(data.stats.total_visitors >= 1000000, "visitors start at a base of one million");
  assert.deepEqual(data.highlights.map((e) => e.id), [eventId], "highlights are the events running today");
  assert.deepEqual(data.events.map((e) => e.id), [eventId], "completed events are not bookable cards");
  assert.deepEqual(data.stories.map((e) => e.event_id), [past.id], "stories come from completed events only");
  const p = data.districts.find((d) => d.code === "pune");
  assert.equal(p.event_count, 2, "the map counts every event organised in the district");
  assert.deepEqual(p.event_ids, [], "the map's upcoming list leaves out an event already running");
  assert.equal(data.districts.find((d) => d.code === "akola").event_count, 0);

  const s = await slots();
  assert.deepEqual(s.quotas, { general: { total: 2, available: 2 }, ews: { total: 1, available: 1 } });
  assert.equal(s.available, 3);
  assert.equal(s.state, "open");
});

test("visitor counter counts up from its base", async () => {
  const before = (await home()).stats.total_visitors;
  const r = await call("POST", "/public/visits", { auth: null });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.total_visitors, before + 1);
  assert.equal((await home()).stats.total_visitors, before + 1);
});

test("booking validation: mandatory fields, numeric Aadhaar, categories, reserved-category documents", async () => {
  const empty = await call("POST", "/public/registrations", { auth: null, body: { event_id: eventId } });
  assert.equal(empty.status, 422);
  assert.deepEqual(fieldsOf(empty), ["aadhaar", "business_name", "caste_category", "consent", "name", "nature_of_business", "phone", "product_categories"]);

  assert.deepEqual(fieldsOf(await book({ aadhaar: "2345 6789 01AB" })), ["aadhaar"], "digits only");
  assert.deepEqual(fieldsOf(await book({ aadhaar: "234567890123" })), ["aadhaar"], "checksum");
  assert.deepEqual(fieldsOf(await book({ product_categories: [] })), ["product_categories"]);
  assert.deepEqual(fieldsOf(await book({ product_categories: [999999] })), ["product_categories"]);
  assert.deepEqual(fieldsOf(await book({ nature_of_business: "smuggling" })), ["nature_of_business"]);

  // EWS / reserved categories need the caste name and a caste certificate.
  assert.deepEqual(fieldsOf(await book({ caste_category: "sc" })), ["caste_certificate", "caste_name"]);
  assert.deepEqual(fieldsOf(await book({ caste_category: "sc", caste_name: "Mahar" })), ["caste_certificate"]);
  const fake = await book({ caste_category: "sc", caste_name: "Mahar" },
    { caste_certificate: { data: Buffer.from("MZ not a pdf"), type: "application/pdf", name: "x.pdf" } });
  assert.deepEqual(fieldsOf(fake), ["caste_certificate"], "content must match the declared type");
  const exe = await book({ caste_category: "sc", caste_name: "Mahar" },
    { caste_certificate: { data: Buffer.from("MZ"), type: "application/x-msdownload", name: "x.exe" } });
  assert.equal(exe.status, 422);
  assert.equal(readdirSync(BOOKING_DIR).length, 0, "refused bookings leave no files behind");
  assert.equal((await slots()).available, 3, "refused bookings take no stall");
});

test("slots: every booking decrements; reserved categories take EWS stalls first; full quotas waitlist", async () => {
  const r1 = await book({ product_categories: [categoryIds[0], categoryIds[1], categoryIds[1]] });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  assert.equal(r1.body.data.status, "pending");
  assert.equal(r1.body.data.available, 2);
  assert.match(r1.body.data.reference_no, /^TBP-\d{4}-[0-9A-F]{6}$/);
  const { rows: [stored] } = await pool.query(
    "SELECT quota_type, category_ids, category_label, nature_of_business, aadhaar_cipher, aadhaar_last4 FROM vendor_registrations WHERE reference_no = $1",
    [r1.body.data.reference_no]
  );
  assert.equal(stored.quota_type, "general");
  assert.deepEqual(stored.category_ids, [categoryIds[0], categoryIds[1]]);
  assert.match(stored.category_label, /, /);
  assert.equal(stored.nature_of_business, "Food processing");
  assert.ok(!stored.aadhaar_cipher.includes(r1.payload.aadhaar), "Aadhaar stored encrypted");
  assert.equal(stored.aadhaar_last4, r1.payload.aadhaar.slice(-4));

  const dup = await book({ aadhaar: r1.payload.aadhaar });
  assert.equal(dup.status, 409);
  assert.deepEqual(fieldsOf(dup), ["aadhaar"]);

  const ews = await reserved();
  assert.equal(ews.status, 201, JSON.stringify(ews.body));
  assert.equal(readdirSync(BOOKING_DIR).length, 1, "the certificate is stored privately");
  assert.equal((await slots()).quotas.ews.available, 0, "a reserved applicant takes the EWS stall");

  const ews2 = await reserved();
  assert.equal(ews2.body.data.status, "pending");
  const s = await slots();
  assert.deepEqual([s.quotas.general.available, s.quotas.ews.available], [0, 0], "with EWS full, a general stall");
  assert.equal(s.state, "waitlist");

  const late = await book();
  assert.equal(late.body.data.status, "waitlisted");
  assert.equal(late.body.data.available, 0);
});

test("concurrent bookings never oversell the last slot", async () => {
  const e = await approvedEvent({ title_en: "Crowd", start_date: inDays(5), end_date: inDays(6), total_stalls: 1, quotas: {} });
  const results = await Promise.all(Array.from({ length: 6 }, () => book({ event_id: e.id })));
  const statuses = results.map((r) => r.body.data?.status).sort();
  assert.deepEqual(statuses, ["pending", "waitlisted", "waitlisted", "waitlisted", "waitlisted", "waitlisted"]);
  const s = await slots(e.id);
  assert.equal(s.quotas.general.available, 0);
  assert.equal(s.state, "waitlist");
  assert.equal(s.bookable, true, "upcoming events are bookable");
});

test("CRM: masked Aadhaar, documents, scoped access, rejection promotes the waitlist, quotas guard allocations", async () => {
  const list = await call("GET", `/admin/registrations?event=${eventId}&quota=general&sort=created_at&order=asc`, { auth: pune });
  assert.equal(list.status, 200);
  const [a, b, c] = list.body.data;
  assert.deepEqual([a.status, b.status, c.status], ["pending", "pending", "waitlisted"]);
  assert.match(a.aadhaar_masked, /^XXXX XXXX \d{4}$/);
  assert.equal(a.aadhaar_cipher, undefined);
  assert.equal(a.aadhaar_hash, undefined);
  assert.equal(b.caste_name, "Mahar");
  assert.deepEqual(Object.keys(b.files), ["caste_certificate"]);
  assert.equal(b.files.caste_certificate.filename, undefined, "the stored filename stays private");

  // Documents: own district only, audited.
  const doc = await call("GET", `/admin/registrations/${b.id}/files/caste_certificate`, { auth: pune });
  assert.equal(doc.status, 200);
  assert.equal(doc.res.headers.get("content-type"), "application/pdf");
  assert.match(doc.res.headers.get("content-disposition"), /certificate\.pdf/);
  assert.equal(Buffer.from(await doc.res.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
  assert.equal((await call("GET", `/admin/registrations/${b.id}/files/caste_certificate`, { auth: nashik })).status, 404);
  assert.equal((await call("GET", `/admin/registrations/${a.id}/files/caste_certificate`, { auth: pune })).status, 404);
  assert.equal((await call("GET", `/admin/registrations/${b.id}/files/caste_certificate`, { auth: null })).status, 401);
  assert.equal((await call("GET", "/admin/activity?action=download")).body.data.length, 1);

  assert.equal((await call("GET", `/admin/registrations/${a.id}`, { auth: nashik })).status, 404);
  assert.equal((await call("PATCH", `/admin/registrations/${a.id}`, { auth: nashik, body: { status: "approved" } })).status, 404);

  assert.equal((await call("GET", `/admin/registrations/${c.id}`, { auth: pune })).body.data.waitlist_position, 1);
  assert.equal((await call("PATCH", `/admin/registrations/${c.id}`, { auth: pune, body: { status: "approved" } })).status, 409, "needs a free slot");

  const approved = await call("PATCH", `/admin/registrations/${a.id}`, { auth: pune, body: { status: "approved", dm_notes: "Docs checked" } });
  assert.equal(approved.body.data.status, "approved");
  assert.equal((await home()).stats.total_participants, 1, "approved vendors are participants");

  const rejected = await call("PATCH", `/admin/registrations/${b.id}`, { auth: pune, body: { status: "rejected" } });
  assert.deepEqual(rejected.body.data.promoted_ids, [c.id], "oldest waitlisted takes the freed slot");
  assert.equal((await call("GET", `/admin/registrations/${c.id}`, { auth: pune })).body.data.status, "pending");

  // Stall availability cannot shrink below allocations; growing frees slots.
  const put = (total_stalls) =>
    call("PUT", `/admin/events/${eventId}`, { auth: pune, body: eventBody({ total_stalls, quotas: { ews: 1, sponsored: 1 } }) });
  const shrink = await put(3);
  assert.equal(shrink.status, 422);
  assert.deepEqual(fieldsOf(shrink), ["quotas.general"]);
  const grow = await put(6);
  assert.equal(grow.status, 200);
  assert.deepEqual(grow.body.data.quotas.general, { total: 4, available: 2 });
  await call("POST", `/admin/events/${eventId}/review`, { body: { decision: "approved" } });
});

test("managers allocate sponsored stalls; super admins can reveal Aadhaar (audited)", async () => {
  const body = applicant({ quota_type: "sponsored" });
  delete body.consent;
  const r = await call("POST", "/admin/registrations", { auth: pune, body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.status, "pending");
  assert.equal(r.body.data.source, "manager");
  const overflow = await call("POST", "/admin/registrations", { auth: pune, body: { ...body, aadhaar: aadhaar() } });
  assert.equal(overflow.body.data.status, "waitlisted", "sponsored quota of 1 is now full");

  assert.equal((await call("POST", `/admin/registrations/${r.body.data.id}/reveal-aadhaar`, { auth: pune })).status, 403);
  const reveal = await call("POST", `/admin/registrations/${r.body.data.id}/reveal-aadhaar`);
  assert.equal(reveal.body.data.aadhaar, body.aadhaar);
  assert.equal((await call("GET", "/admin/activity?action=reveal")).body.data.length, 1);
});

test("sponsors: manager drafts and requests approval; only a super admin approves; edits need re-approval", async () => {
  const publicNames = async () => (await home()).sponsors.map((s) => s.name);
  const created = await call("POST", "/admin/sponsors", {
    auth: pune, body: { name: "Pune Bank", tier: "gold", website: "https://example.org", event_id: eventId },
  });
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  assert.equal(created.body.data.status, "draft");
  assert.ok(!(await publicNames()).includes("Pune Bank"));

  const foreign = await call("POST", "/admin/sponsors", { auth: nashik, body: { name: "X", event_id: eventId } });
  assert.deepEqual(fieldsOf(foreign), ["event_id"], "cannot attach another district's event");

  assert.equal((await call("POST", `/admin/sponsors/${id}/request-approval`, { auth: pune })).body.data.status, "pending");
  assert.equal((await call("PUT", `/admin/sponsors/${id}`, { auth: pune, body: { name: "Changed" } })).status, 409, "locked while in review");
  assert.equal((await call("POST", `/admin/sponsors/${id}/review`, { auth: pune, body: { decision: "approved" } })).status, 403);
  assert.deepEqual((await call("GET", "/admin/sponsors?status=pending")).body.data.map((s) => s.id), [id]);
  assert.equal((await call("POST", `/admin/sponsors/${id}/review`, { body: { decision: "approved" } })).body.data.status, "approved");
  assert.ok((await publicNames()).includes("Pune Bank"));

  const edited = await call("PUT", `/admin/sponsors/${id}`, {
    auth: pune, body: { name: "Pune Bank Ltd", tier: "gold", website: "https://example.org", event_id: eventId },
  });
  assert.equal(edited.body.data.status, "draft");
  assert.ok(!(await publicNames()).some((n) => n.startsWith("Pune Bank")), "unapproved edits are not public");
});

test("form builder: system fields are kept and locked; optional ones can be switched", async () => {
  const form = (await call("GET", "/admin/forms/vendor_registration")).body.data;
  const keys = form.fields.map((f) => f.key);
  assert.deepEqual(keys.slice(0, 9), [
    "name", "business_name", "nature_of_business", "product_categories", "aadhaar", "caste_category", "caste_name", "caste_certificate", "phone",
  ]);
  assert.ok(form.fields.find((f) => f.key === "name").locked);
  assert.equal(form.fields.find((f) => f.key === "nature_of_business").options.length, 9);

  // Dropping locked fields or making them optional is undone; phone becomes optional.
  const fields = form.fields
    .filter((f) => f.key !== "aadhaar")
    .map((f) => (f.key === "name" ? { ...f, required: false, type: "textarea" } : f.key === "phone" ? { ...f, required: false } : f));
  const saved = await call("PUT", "/admin/forms/vendor_registration", { body: { title: form.title, fields } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const after = Object.fromEntries(saved.body.data.fields.map((f) => [f.key, f]));
  assert.ok(after.aadhaar && after.aadhaar.required, "locked fields cannot be removed");
  assert.deepEqual([after.name.required, after.name.type], [true, "text"]);
  assert.equal(after.phone.required, false);
  const noPhone = await book({ phone: "" });
  assert.equal(noPhone.status, 201, JSON.stringify(noPhone.body));

  const reservedKey = await call("PUT", "/admin/forms/vendor_registration", {
    body: { title: form.title, fields: [...form.fields, { key: "event_id", label_mr: "x", type: "text" }] },
  });
  assert.deepEqual(fieldsOf(reservedKey), [`fields.${form.fields.length}.key`]);
  const noOptions = await call("PUT", "/admin/forms/vendor_registration", {
    body: { title: form.title, fields: [...form.fields, { key: "size", label_mr: "x", type: "radio" }] },
  });
  assert.deepEqual(fieldsOf(noOptions), [`fields.${form.fields.length}.options`]);
});

test("form builder: every field type is validated and stored safely", async () => {
  const form = (await call("GET", "/admin/forms/vendor_registration")).body.data;
  const opts = [{ value: "a", label_mr: "अ", label_en: "A" }, { value: "b", label_mr: "ब", label_en: "B" }];
  const q = (key, type, extra = {}) => ({ key, label_mr: key, label_en: key, type, required: true, ...extra });
  const custom = [
    q("q_text", "text"), q("q_email", "email"), q("q_phone", "phone"), q("q_number", "number"), q("q_pan", "pan"),
    q("q_date", "date"), q("q_area", "textarea"), q("q_select", "select", { options: opts }), q("q_radio", "radio", { options: opts }),
    q("q_checks", "checkbox", { options: opts }), q("q_tick", "checkbox"), q("q_file", "file"), q("q_password", "password"), q("q_url", "url"),
    q("q_optional", "email", { required: false }),
  ];
  const saved = await call("PUT", "/admin/forms/vendor_registration", { body: { title: form.title, fields: [...form.fields, ...custom] } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const pub = await call("GET", "/public/forms/vendor_registration", { auth: null });
  assert.deepEqual(pub.body.data.fields.slice(-15).map((f) => f.type), custom.map((f) => f.type));

  const missing = await book();
  assert.deepEqual(fieldsOf(missing), custom.filter((f) => f.required).map((f) => `extra.${f.key}`).sort());
  assert.equal(missing.body.error.details.find((d) => d.field === "extra.q_file").message, "Upload the q_file");

  const bad = await book({
    extra: {
      q_text: "x", q_email: "nope", q_phone: "123", q_number: "abc", q_pan: "ABC123", q_date: "31-12-2026", q_area: "x",
      q_select: "z", q_radio: "z", q_checks: ["a", "z"], q_tick: false, q_password: "short", q_url: "ftp://x", q_optional: "bad",
    },
  }, { q_file: { data: PNG_1PX, type: "image/png", name: "photo.png" } });
  assert.deepEqual(fieldsOf(bad), [
    "extra.q_checks", "extra.q_date", "extra.q_email", "extra.q_number", "extra.q_optional", "extra.q_pan", "extra.q_password",
    "extra.q_phone", "extra.q_radio", "extra.q_select", "extra.q_tick", "extra.q_url",
  ]);

  const good = await book({
    extra: {
      q_text: "Hello", q_email: "Asha@Example.org", q_phone: "98765 43210", q_number: "12", q_pan: "abcde1234f", q_date: "2026-12-31",
      q_area: "Long answer", q_select: "a", q_radio: "b", q_checks: ["a", "b", "a"], q_tick: true, q_password: "Secret123", q_url: "https://example.org",
      q_optional: "", unknown: "dropped",
    },
  }, { q_file: { data: PNG_1PX, type: "image/png", name: "photo.png" } });
  assert.equal(good.status, 201, JSON.stringify(good.body));
  const { rows: [row] } = await pool.query("SELECT id, extra, files FROM vendor_registrations WHERE reference_no = $1", [good.body.data.reference_no]);
  assert.deepEqual({ ...row.extra, q_password: "hash" }, {
    q_text: "Hello", q_email: "asha@example.org", q_phone: "9876543210", q_number: 12, q_pan: "ABCDE1234F", q_date: "2026-12-31",
    q_area: "Long answer", q_select: "a", q_radio: "b", q_checks: ["a", "b"], q_tick: true, q_password: "hash", q_url: "https://example.org", q_optional: "",
  });
  assert.match(row.extra.q_password, /^\$2[aby]\$/, "passwords are stored hashed");
  assert.equal(row.files.q_file.mime_type, "image/png");
  assert.ok(existsSync(path.join(BOOKING_DIR, row.files.q_file.filename)));
  const shown = (await call("GET", `/admin/registrations/${row.id}`)).body.data;
  assert.equal(shown.extra.q_password, "••••••••");

  await call("PUT", "/admin/forms/vendor_registration", { body: { title: form.title, fields: form.fields } });
});

test("media CMS: managers upload gallery photos to their own events only", async () => {
  const form = () => {
    const f = new FormData();
    f.append("file", new Blob([PNG_1PX], { type: "image/png" }), "stall.png");
    f.append("event_id", String(eventId));
    f.append("caption", "Opening day");
    return f;
  };
  assert.equal((await call("POST", "/admin/event-media/upload", { auth: nashik, form: form() })).status, 422);
  const up = await call("POST", "/admin/event-media/upload", { auth: pune, form: form() });
  assert.equal(up.status, 201);
  const pub = await call("GET", `/public/events/${eventId}`, { auth: null });
  assert.equal(pub.body.data.gallery[0].caption, "Opening day");
  assert.equal((await call("DELETE", `/admin/event-media/${up.body.data.id}`, { auth: nashik })).status, 404);
  assert.equal((await call("DELETE", `/admin/event-media/${up.body.data.id}`, { auth: pune })).status, 200);
});

test("GIS analytics: statewide for super admins, own district for managers", async () => {
  const state = await call("GET", "/admin/analytics");
  assert.equal(state.body.data.scope, "state");
  assert.equal(state.body.data.districts.length, 36);
  const p = state.body.data.districts.find((d) => d.code === "pune");
  assert.ok(p.applicants >= 5);
  assert.equal(p.sponsors, 0, "the edited sponsor is back in draft");
  assert.equal(state.body.data.totals.districtsActive, 1);
  assert.ok(state.body.data.totals.stallsBooked > 0);

  const mine = await call("GET", "/admin/analytics", { auth: pune });
  assert.equal(mine.body.data.scope, "district");
  assert.deepEqual(mine.body.data.districts.map((d) => d.code), ["pune"]);
  const theirs = await call("GET", "/admin/analytics", { auth: nashik });
  assert.equal(theirs.body.data.totals.applicants, 0);
});

test("events with applications are cancelled, not deleted", async () => {
  assert.equal((await call("DELETE", `/admin/events/${eventId}`, { auth: pune })).status, 409);
});

// ── Moderation matrix ─────────────────────────────────────────────────────

let divisional;
const stayed = [];

test("divisional manager: needs a division, and works only inside it", async () => {
  const body = { name: "Div Pune", email: "div.pune@test.local", role: "divisional_manager", password: "Manager123" };
  assert.equal((await call("POST", "/admin/users", { body })).status, 422, "a division is required");
  assert.equal((await call("POST", "/admin/users", { body: { ...body, division: "pune" } })).status, 201);
  const login = await call("POST", "/auth/login", { auth: null, body: { email: body.email, password: body.password } });
  divisional = login.body.data.token;
  assert.equal(login.body.data.user.division, "pune");

  const own = await call("POST", "/admin/events", {
    auth: divisional, body: eventBody({ district_id: district("kolhapur").id, start_date: inDays(30), end_date: inDays(31) }),
  });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  assert.equal(own.body.data.approval_status, "approved", "a divisional manager publishes without approval");
  assert.equal(own.body.data.moderation_status, "APPROVED");
  stayed.push(own.body.data.id);

  const outside = await call("POST", "/admin/events", {
    auth: divisional, body: eventBody({ district_id: district("nashik").id, start_date: inDays(30), end_date: inDays(31) }),
  });
  assert.equal(outside.status, 422, "a district outside the division is refused");

  const list = (await call("GET", "/admin/events?limit=100", { auth: divisional })).body.data;
  const division = ["pune", "satara", "sangli", "solapur", "kolhapur"].map((c) => district(c).id);
  assert.ok(list.length > 0 && list.every((e) => division.includes(e.district_id)), "only the division's events are listed");
  assert.equal((await call("GET", "/admin/users", { auth: divisional })).status, 403, "no CMS access");
});

test("events: a district manager's event waits; divisional managers approve only their division's", async () => {
  const mine = await call("POST", "/admin/events", { auth: pune, body: eventBody({ start_date: inDays(40), end_date: inDays(41) }) });
  const other = await call("POST", "/admin/events", { auth: nashik, body: eventBody({ start_date: inDays(40), end_date: inDays(41) }) });
  assert.equal(mine.body.data.moderation_status, "PENDING_APPROVAL");
  const eventId = mine.body.data.id;
  const shown = async (id) => (await home()).events.some((e) => e.id === id);
  assert.equal(await shown(eventId), false, "unapproved events stay off the site");

  const review = (id, auth, body = { decision: "approved" }) => call("POST", `/admin/events/${id}/review`, { auth, body });
  assert.equal((await review(eventId, pune)).status, 403, "a district manager cannot approve");
  assert.equal((await review(other.body.data.id, divisional)).status, 404, "another division's event does not exist");
  assert.equal((await review(eventId, divisional)).status, 200);
  assert.equal(await shown(eventId), true);

  const edited = await call("PUT", `/admin/events/${eventId}`, { auth: pune, body: eventBody({ title_en: "Edited", start_date: inDays(40), end_date: inDays(41) }) });
  assert.equal(edited.body.data.moderation_status, "PENDING_APPROVAL", "a manager's edit goes back for approval");
  assert.equal(await shown(eventId), false);
  stayed.push(eventId, other.body.data.id);
});

test("success stories: moderated, tied to a completed event, and hidden until approved", async () => {
  const past = await approvedEvent({ title_en: "Story fair", start_date: inDays(-5), end_date: inDays(-4) });
  stayed.push(past.id);
  const story = (auth, body, method = "POST", path = "/admin/success-stories") => call(method, path, { auth, body });
  const text = "Forty sellers sold out";

  assert.equal((await story(pune, { event_id: stayed[0], story_en: text })).status, 404, "an event outside the district");
  const upcoming = (await call("GET", "/admin/events?phase=upcoming&limit=100", { auth: pune })).body.data[0];
  assert.equal((await story(pune, { event_id: upcoming.id, story_en: text })).status, 422, "the event must be completed");
  assert.equal((await story(pune, { event_id: past.id, story_en: "x".repeat(101) })).status, 422, "100 characters at most");

  const created = await story(pune, { event_id: past.id, story_en: text });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const row = created.body.data;
  assert.equal(row.moderation_status, "PENDING_APPROVAL");
  assert.equal(row.district_id, past.district_id);
  const publicText = async () => (await home()).stories.find((s) => s.event_id === past.id)?.story_en;
  assert.notEqual(await publicText(), text, "a pending story is not public");

  const path = `/admin/success-stories/${row.id}`;
  assert.equal((await call("GET", path, { auth: nashik })).status, 404, "another district's story does not exist");
  assert.equal((await story(pune, { decision: "approved" }, "POST", `${path}/review`)).status, 403);
  assert.equal((await story(divisional, { decision: "rejected" }, "POST", `${path}/review`)).status, 422, "rejecting needs a reason");
  assert.equal((await story(divisional, { decision: "rejected", note: "Unclear" }, "POST", `${path}/review`)).body.data.moderation_status, "REJECTED");
  assert.notEqual(await publicText(), text, "a rejected story is not public");

  assert.equal((await story(divisional, { decision: "approved" }, "POST", `${path}/review`)).status, 200);
  assert.equal(await publicText(), text, "an approved story is public");

  const edited = await story(pune, { event_id: past.id, story_en: "Changed text" }, "PUT", path);
  assert.equal(edited.body.data.moderation_status, "PENDING_APPROVAL", "a manager's edit goes back for approval");
  assert.notEqual(await publicText(), "Changed text");

  const { rows: [log] } = await pool.query(
    `SELECT user_id, user_role, ip_address, created_at FROM activity_logs
      WHERE entity = 'success_stories' AND entity_id = $1 AND action = 'status' ORDER BY id DESC LIMIT 1`,
    [String(row.id)]
  );
  assert.equal(log.user_role, "divisional_manager");
  assert.ok(log.user_id > 0 && log.ip_address && log.created_at, "the audit row says who, from where and when");
  const { rows: [edit] } = await pool.query(
    "SELECT user_role, ip_address FROM activity_logs WHERE entity = 'success_stories' AND entity_id = $1 AND action = 'update'",
    [String(row.id)]
  );
  assert.equal(edit.user_role, "district_manager");
  assert.ok(edit.ip_address);
});

test("success stories: photos are stored as WebP, and other types and large files are refused", async () => {
  const { default: sharp } = await import("sharp");
  const upload = (buffer, type) => {
    const form = new FormData();
    form.append("file", new Blob([buffer], { type }), "photo");
    return fetch(`${base}/admin/success-stories/upload`, { method: "POST", headers: { Authorization: `Bearer ${pune}` }, body: form });
  };
  const png = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#c60" } }).png().toBuffer();
  const res = await upload(png, "image/png");
  assert.equal(res.status, 201);
  const { data } = await res.json();
  assert.match(data.url, /\.webp$/);
  const { rows: [media] } = await pool.query("SELECT mime_type, filename FROM media_assets WHERE id = $1", [data.media_id]);
  assert.equal(media.mime_type, "image/webp");
  const { env } = await import("../src/config/env.js");
  const meta = await sharp(`${env.upload.dir}/media/${media.filename}`).metadata();
  assert.equal(meta.format, "webp");
  assert.equal(meta.width, 1600, "large photos are scaled down");

  assert.equal((await upload(Buffer.concat([png, Buffer.alloc(3 * 1024 * 1024)]), "image/png")).status, 422, "over 3 MB");
  assert.equal((await upload(await sharp(png).gif().toBuffer(), "image/gif")).status, 422, "GIF is refused");
});
