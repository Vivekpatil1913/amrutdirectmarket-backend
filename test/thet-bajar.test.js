// End-to-end tests for the Thet Bajar Peth features (events, stall slots,
// OTP-verified registration, role-based portals, sponsors, form builder,
// analytics) against their own throwaway database.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "fs";
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
process.env.OTP_DEV_ECHO = "true";

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

let server, base, pool, verhoeffValid;
let admin, pune, nashik; // tokens
let districts, categoryId, eventId;

async function call(method, url, { body, auth = admin, form } = {}) {
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

async function otpToken(number) {
  const sent = await call("POST", "/public/otp/send", { auth: null, body: { phone: number } });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  const ok = await call("POST", "/public/otp/verify", {
    auth: null,
    body: { request_id: sent.body.data.request_id, phone: number, code: sent.body.data.dev_code },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  return ok.body.data.otp_token;
}

async function applicant(overrides = {}) {
  const number = overrides.phone ?? phone();
  return {
    event_id: eventId, quota_type: "general", name: "Asha Patil", business_name: "Asha Gruh Udyog",
    nature_of_business: "Homemade pickles", category_id: categoryId, aadhaar: aadhaar(),
    udyam_number: "UDYAM-MH-26-0012345", caste_category: "open", phone: number,
    otp_token: overrides.otp_token ?? (await otpToken(number)), consent: true, language: "en",
    ...overrides,
  };
}

const register = async (o) => call("POST", "/public/registrations", { auth: null, body: await applicant(o) });
const slots = async (id = eventId) => (await call("GET", `/public/events/${id}/slots`, { auth: null })).body.data;
const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

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
  categoryId = (await pool.query("SELECT id FROM categories WHERE status = 'published' ORDER BY id LIMIT 1")).rows[0].id;
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

test("events: a manager creates events only in their own district, with stall quotas", async () => {
  const invalid = await call("POST", "/admin/events", {
    auth: pune,
    body: { title_mr: "", venue_mr: "x", start_date: inDays(3), end_date: inDays(1), quotas: { general: -1 } },
  });
  assert.equal(invalid.status, 422);
  assert.deepEqual(fieldsOf(invalid), ["end_date", "quotas.general", "title_mr"]);

  const r = await call("POST", "/admin/events", {
    auth: pune,
    body: {
      district_id: district("nashik").id, // ignored for a manager
      title_mr: "पुणे थेट बाजार पेठ", title_en: "Pune Thet Bajar Peth", venue_mr: "शिवाजीनगर", venue_en: "Shivajinagar",
      start_date: today(), end_date: inDays(3), status: "published", quotas: { general: 2, ews: 1, sponsored: 1 },
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  eventId = r.body.data.id;
  assert.equal(r.body.data.district_id, district("pune").id);
  assert.equal(r.body.data.phase, "live");
  assert.deepEqual(r.body.data.quotas.general, { total: 2, available: 2 });

  assert.equal((await call("GET", `/admin/events/${eventId}`, { auth: nashik })).status, 404, "other districts cannot see it");
  assert.equal((await call("PUT", `/admin/events/${eventId}`, { auth: nashik, body: {} })).status, 404);
  const nashikList = await call("GET", "/admin/events", { auth: nashik });
  assert.equal(nashikList.body.meta.total, 0);
  const all = await call("GET", `/admin/events?district=${district("pune").id}`);
  assert.equal(all.body.meta.total, 1, "super admin sees every district");

  // Super admins must say which district.
  const noDistrict = await call("POST", "/admin/events", {
    body: { title_mr: "x", venue_mr: "y", start_date: today(), end_date: today() },
  });
  assert.deepEqual(fieldsOf(noDistrict), ["district_id"]);
});

test("public home data: counts, live events with availability, districts and the slot counter", async () => {
  const r = await call("GET", "/public/thet-bajar", { auth: null });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.stats.total_events, 1);
  assert.equal(r.body.data.stats.live_events, 1);
  assert.equal(r.body.data.events[0].id, eventId);
  assert.equal(r.body.data.events[0].bookable, true);
  assert.deepEqual(district("pune") && r.body.data.districts.find((d) => d.code === "pune").event_ids, [eventId]);

  const s = await slots();
  assert.deepEqual(s.quotas, { general: { total: 2, available: 2 }, ews: { total: 1, available: 1 } });
  assert.equal(s.available, 3);
  assert.equal(s.state, "open");
});

test("OTP: wrong code refused, attempts limited, token single-use", async () => {
  const number = phone();
  const sent = await call("POST", "/public/otp/send", { auth: null, body: { phone: number } });
  assert.match(sent.body.data.dev_code, /^\d{6}$/);
  assert.equal((await call("POST", "/public/otp/send", { auth: null, body: { phone: number } })).status, 429, "resend throttled");
  const wrong = await call("POST", "/public/otp/verify", {
    auth: null, body: { request_id: sent.body.data.request_id, phone: number, code: sent.body.data.dev_code === "000000" ? "111111" : "000000" },
  });
  assert.equal(wrong.status, 422);
  assert.equal(wrong.body.error.details[0].message, "Incorrect code");
  const otherPhone = await call("POST", "/public/otp/verify", {
    auth: null, body: { request_id: sent.body.data.request_id, phone: phone(), code: sent.body.data.dev_code },
  });
  assert.equal(otherPhone.status, 422, "code is bound to its number");
  const { rows } = await pool.query("SELECT code_hash FROM otp_verifications WHERE id = $1", [sent.body.data.request_id]);
  assert.notEqual(rows[0].code_hash, sent.body.data.dev_code, "only a hash is stored");

  const noOtp = await register({ otp_token: "00000000-0000-4000-8000-000000000000" });
  assert.equal(noOtp.status, 422);
  assert.deepEqual(fieldsOf(noOtp), ["phone"]);
});

test("registration validation: Aadhaar, Udyam, EWS eligibility, category, closed events", async () => {
  const bad = await register({ aadhaar: "234567890123", udyam_number: "UDYAM-12" });
  assert.equal(bad.status, 422);
  assert.deepEqual(fieldsOf(bad), ["aadhaar", "udyam_number"]);
  assert.deepEqual(fieldsOf(await register({ quota_type: "ews", caste_category: "open" })), ["quota_type"]);
  assert.deepEqual(fieldsOf(await register({ category_id: 999999 })), ["category_id"]);

  const draft = await call("POST", "/admin/events", {
    auth: pune, body: { title_mr: "मसुदा", venue_mr: "x", start_date: today(), end_date: today(), quotas: { general: 5 } },
  });
  assert.deepEqual(fieldsOf(await register({ event_id: draft.body.data.id })), ["event_id"], "drafts are not bookable");
});

test("slots decrement on every booking; a full quota waitlists; duplicates and OTP reuse refused", async () => {
  const first = await applicant();
  const r1 = await call("POST", "/public/registrations", { auth: null, body: first });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  assert.equal(r1.body.data.status, "pending");
  assert.equal(r1.body.data.available, 1);
  assert.match(r1.body.data.reference_no, /^TBP-\d{4}-[0-9A-F]{6}$/);
  assert.equal((await slots()).quotas.general.available, 1);

  const reuse = await call("POST", "/public/registrations", { auth: null, body: { ...first, aadhaar: aadhaar() } });
  assert.deepEqual(fieldsOf(reuse), ["phone"], "an OTP token books once");

  const dup = await register({ aadhaar: first.aadhaar });
  assert.equal(dup.status, 409);
  assert.deepEqual(fieldsOf(dup), ["aadhaar"]);
  assert.equal((await slots()).quotas.general.available, 1, "a refused booking does not consume a slot");

  const r2 = await register();
  assert.equal(r2.body.data.status, "pending");
  assert.equal(r2.body.data.available, 0);

  const r3 = await register();
  assert.equal(r3.body.data.status, "waitlisted");
  const s = await slots();
  assert.equal(s.quotas.general.available, 0);
  assert.equal(s.available, 1, "EWS stall still free");
  assert.equal(s.state, "open");

  const ews = await register({ quota_type: "ews", caste_category: "sc" });
  assert.equal(ews.body.data.status, "pending");
  const full = await slots();
  assert.equal(full.available, 0);
  assert.equal(full.state, "waitlist");

  const { rows } = await pool.query("SELECT aadhaar_cipher, aadhaar_last4 FROM vendor_registrations WHERE reference_no = $1", [r1.body.data.reference_no]);
  assert.ok(!rows[0].aadhaar_cipher.includes(first.aadhaar), "Aadhaar stored encrypted");
  assert.equal(rows[0].aadhaar_last4, first.aadhaar.slice(-4));
});

test("concurrent bookings never oversell the last slot", async () => {
  const e = await call("POST", "/admin/events", {
    auth: pune,
    body: { title_mr: "गर्दी", venue_mr: "x", start_date: inDays(5), end_date: inDays(6), status: "published", quotas: { general: 1 } },
  });
  const bodies = await Promise.all(Array.from({ length: 6 }, () => applicant({ event_id: e.body.data.id })));
  const results = await Promise.all(bodies.map((b) => call("POST", "/public/registrations", { auth: null, body: b })));
  const statuses = results.map((r) => r.body.data?.status).sort();
  assert.deepEqual(statuses, ["pending", "waitlisted", "waitlisted", "waitlisted", "waitlisted", "waitlisted"]);
  const s = await slots(e.body.data.id);
  assert.equal(s.quotas.general.available, 0);
  assert.equal(s.state, "waitlist");
  assert.equal(s.bookable, true, "upcoming events are bookable");
});

test("CRM: masked Aadhaar, scoped access, rejection promotes the waitlist, quotas guard allocations", async () => {
  const list = await call("GET", `/admin/registrations?event=${eventId}&quota=general&sort=created_at&order=asc`, { auth: pune });
  assert.equal(list.status, 200);
  const [a, b, c] = list.body.data;
  assert.deepEqual([a.status, b.status, c.status], ["pending", "pending", "waitlisted"]);
  assert.match(a.aadhaar_masked, /^XXXX XXXX \d{4}$/);
  assert.equal(a.aadhaar_cipher, undefined);
  assert.equal(a.aadhaar_hash, undefined);

  assert.equal((await call("GET", `/admin/registrations/${a.id}`, { auth: nashik })).status, 404);
  assert.equal((await call("PATCH", `/admin/registrations/${a.id}`, { auth: nashik, body: { status: "approved" } })).status, 404);
  assert.equal((await call("GET", "/admin/registrations", { auth: nashik })).body.meta.total, 0);

  const detail = await call("GET", `/admin/registrations/${c.id}`, { auth: pune });
  assert.equal(detail.body.data.waitlist_position, 1);

  // Waitlisted → approved needs a free slot.
  const noSlot = await call("PATCH", `/admin/registrations/${c.id}`, { auth: pune, body: { status: "approved" } });
  assert.equal(noSlot.status, 409);

  const approved = await call("PATCH", `/admin/registrations/${a.id}`, { auth: pune, body: { status: "approved", udyam_verified: true, dm_notes: "Docs checked" } });
  assert.equal(approved.body.data.status, "approved");
  assert.equal(approved.body.data.udyam_verified, true);

  const rejected = await call("PATCH", `/admin/registrations/${b.id}`, { auth: pune, body: { status: "rejected" } });
  assert.deepEqual(rejected.body.data.promoted_ids, [c.id], "oldest waitlisted takes the freed slot");
  assert.equal((await call("GET", `/admin/registrations/${c.id}`, { auth: pune })).body.data.status, "pending");
  assert.equal((await slots()).quotas.general.available, 0);

  // Quotas: cannot shrink below allocations; growing frees slots.
  const event = (await call("GET", `/admin/events/${eventId}`, { auth: pune })).body.data;
  const put = (quotas) => call("PUT", `/admin/events/${eventId}`, { auth: pune, body: { ...event, quotas } });
  const shrink = await put({ general: 1, ews: 1, sponsored: 1 });
  assert.equal(shrink.status, 422);
  assert.deepEqual(fieldsOf(shrink), ["quotas.general"]);
  const grow = await put({ general: 4, ews: 1, sponsored: 1 });
  assert.equal(grow.status, 200);
  assert.deepEqual(grow.body.data.quotas.general, { total: 4, available: 2 });

  // Releasing via cancel frees a slot again.
  await call("PATCH", `/admin/registrations/${c.id}`, { auth: pune, body: { status: "cancelled" } });
  assert.equal((await slots()).quotas.general.available, 3);
});

test("managers allocate sponsored stalls without OTP; super admins can reveal Aadhaar (audited)", async () => {
  const body = await applicant({ quota_type: "sponsored", otp_token: undefined });
  delete body.otp_token;
  const r = await call("POST", "/admin/registrations", { auth: pune, body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.status, "pending");
  assert.equal(r.body.data.source, "manager");
  const overflow = await call("POST", "/admin/registrations", { auth: pune, body: { ...body, aadhaar: aadhaar() } });
  assert.equal(overflow.body.data.status, "waitlisted", "sponsored quota of 1 is now full");

  assert.equal((await call("POST", `/admin/registrations/${r.body.data.id}/reveal-aadhaar`, { auth: pune })).status, 403);
  const reveal = await call("POST", `/admin/registrations/${r.body.data.id}/reveal-aadhaar`);
  assert.equal(reveal.body.data.aadhaar, body.aadhaar);
  const log = await call("GET", "/admin/activity?action=reveal");
  assert.equal(log.body.data.length, 1);
});

test("sponsors: manager drafts and requests approval; only a super admin approves; edits need re-approval", async () => {
  const publicNames = async () => (await call("GET", "/public/thet-bajar", { auth: null })).body.data.sponsors.map((s) => s.name);
  const created = await call("POST", "/admin/sponsors", {
    auth: pune, body: { name: "Pune Agro Co-op", tier: "gold", website: "https://example.org", event_id: eventId },
  });
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  assert.equal(created.body.data.status, "draft");
  assert.equal(created.body.data.district_id, district("pune").id);
  assert.ok(!(await publicNames()).includes("Pune Agro Co-op"));

  const foreign = await call("POST", "/admin/sponsors", { auth: nashik, body: { name: "X", event_id: eventId } });
  assert.deepEqual(fieldsOf(foreign), ["event_id"], "cannot attach another district's event");

  const req = await call("POST", `/admin/sponsors/${id}/request-approval`, { auth: pune });
  assert.equal(req.body.data.status, "pending");
  assert.equal((await call("POST", `/admin/sponsors/${id}/request-approval`, { auth: pune })).status, 409);
  assert.equal((await call("PUT", `/admin/sponsors/${id}`, { auth: pune, body: { name: "Changed" } })).status, 409, "locked while in review");
  assert.equal((await call("POST", `/admin/sponsors/${id}/review`, { auth: pune, body: { decision: "approved" } })).status, 403);

  const queue = await call("GET", "/admin/sponsors?status=pending");
  assert.deepEqual(queue.body.data.map((s) => s.id), [id]);
  assert.deepEqual(fieldsOf(await call("POST", `/admin/sponsors/${id}/review`, { body: { decision: "rejected" } })), ["note"]);
  const approved = await call("POST", `/admin/sponsors/${id}/review`, { body: { decision: "approved" } });
  assert.equal(approved.body.data.status, "approved");
  assert.ok((await publicNames()).includes("Pune Agro Co-op"));

  const edited = await call("PUT", `/admin/sponsors/${id}`, {
    auth: pune, body: { name: "Pune Agro Co-op Ltd", tier: "gold", website: "https://example.org", event_id: eventId },
  });
  assert.equal(edited.body.data.status, "draft");
  assert.ok(!(await publicNames()).some((n) => n.startsWith("Pune Agro")), "unapproved edits are not public");
});

test("form builder: custom fields are rendered publicly and enforced on submission", async () => {
  const save = await call("PUT", "/admin/forms/vendor_registration", {
    body: {
      title: "Stall registration form",
      fields: [{ key: "stall_size", label_mr: "स्टॉल आकार", label_en: "Stall size", type: "select", required: true,
        options: [{ value: "small", label_mr: "लहान", label_en: "Small" }, { value: "large", label_mr: "मोठा", label_en: "Large" }] }],
    },
  });
  assert.equal(save.status, 200, JSON.stringify(save.body));
  const pub = await call("GET", "/public/forms/vendor_registration", { auth: null });
  assert.equal(pub.body.data.fields[0].key, "stall_size");

  const missing = await register();
  assert.deepEqual(fieldsOf(missing), ["extra.stall_size"]);
  const ok = await register({ extra: { stall_size: "large", ignored: "x" } });
  assert.equal(ok.status, 201);
  const { rows } = await pool.query("SELECT extra FROM vendor_registrations WHERE reference_no = $1", [ok.body.data.reference_no]);
  assert.deepEqual(rows[0].extra, { stall_size: "large" });
  await call("PUT", "/admin/forms/vendor_registration", { body: { title: "Stall registration form", fields: [] } });
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
