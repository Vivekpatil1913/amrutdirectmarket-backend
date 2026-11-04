import { Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { query, queryOne } from "../../db/pool.js";
import { env } from "../../config/env.js";
import { asyncHandler, notFound, parseOrThrow, success } from "../../lib/errors.js";
import { idParam } from "../../lib/validators.js";
import { COMPILED } from "../collections/collections.routes.js";
import * as crud from "../collections/crud.service.js";
import { publicSections } from "../sections/sections.service.js";
import { SECTION_KEYS } from "../sections/sections.config.js";
import * as events from "../events/events.service.js";
import { listDistricts } from "../districts/districts.routes.js";
import { publicSponsors } from "../sponsors/sponsors.routes.js";
import { ttlCached } from "../../lib/ttlCache.js";

const router = Router();

// Everything the single-page site renders, in one request: published section
// content plus the published records of every collection. Drafts and
// soft-deleted rows are never included.
export async function siteContent() {
  const [sections, ...lists] = await Promise.all([
    publicSections(),
    ...Object.values(COMPILED).map((c) => crud.listPublic(c)),
  ]);
  const collections = Object.fromEntries(Object.values(COMPILED).map((c, i) => [c.publicKey, lists[i]]));
  return { sections, collections };
}

router.get("/site", asyncHandler(async (_req, res) => {
  res.set("Cache-Control", "no-cache"); // revalidate via ETag: admin changes show on the next load
  return success(res, await siteContent());
}));

router.get("/sections/:key", asyncHandler(async (req, res) => {
  if (!SECTION_KEYS.includes(req.params.key)) throw notFound("Section");
  const sections = await publicSections();
  if (!sections[req.params.key]) throw notFound("Section");
  res.set("Cache-Control", "no-cache");
  return success(res, sections[req.params.key]);
}));

// ── Thet Bajar Peth ──────────────────────────────────────────────────────

// Home-page statistics. Total events counts the approved events completed
// to date; participants are the vendors whose stall was approved; visitors
// is the site counter (it starts at a base of one million).
async function homeStats() {
  return queryOne(
    `SELECT COUNT(*) FILTER (WHERE (${events.PHASE_SQL}) = 'completed')::int AS total_events,
            COUNT(*) FILTER (WHERE (${events.PHASE_SQL}) = 'live')::int AS live_events,
            COUNT(*) FILTER (WHERE (${events.PHASE_SQL}) = 'upcoming')::int AS upcoming_events,
            COUNT(DISTINCT e.district_id)::int AS districts_covered,
            (SELECT COUNT(*) FROM vendor_registrations r JOIN events x ON x.id = r.event_id
              WHERE r.deleted_at IS NULL AND x.deleted_at IS NULL AND r.status = 'approved')::int AS total_participants,
            (SELECT value FROM site_counters WHERE key = 'visitors')::bigint AS total_visitors
       FROM events e WHERE ${events.PUBLIC_WHERE}`
  );
}

// The counters change slowly and every home-page visit reads them, so they are
// kept for five minutes. A new visit still gets the live total from POST /visits.
const STATS_TTL_MS = 5 * 60 * 1000;
const cachedHomeStats = ttlCached(homeStats, env.isTest ? 0 : STATS_TTL_MS);

// Events organised per district (every approved event that was not
// cancelled, past or upcoming): the map's pointers show this count.
async function eventCountsByDistrict() {
  const rows = await query(
    `SELECT e.district_id, COUNT(*)::int AS n FROM events e
      WHERE ${events.PUBLIC_WHERE} GROUP BY e.district_id`
  );
  return new Map(rows.map((r) => [r.district_id, r.n]));
}

// The home page's live data: statistics, completed events' stories, the latest
// events' highlights, live
// and upcoming events with their stall availability, districts for the map
// and approved sponsors.
router.get("/thet-bajar", asyncHandler(async (_req, res) => {
  const [stats, stories, highlights, upcoming, districts, counts, sponsors] = await Promise.all([
    cachedHomeStats(),
    events.pastStories(),
    events.latestHighlights(2),
    events.listPublic({ limit: 24 }),
    listDistricts({ activeOnly: true }),
    eventCountsByDistrict(),
    publicSponsors(),
  ]);
  const byDistrict = new Map();
  for (const e of upcoming) byDistrict.set(e.district_id, [...(byDistrict.get(e.district_id) ?? []), e.id]);
  res.set("Cache-Control", "no-cache");
  return success(res, {
    stats: { ...stats, total_visitors: Number(stats.total_visitors ?? 0) },
    stories,
    highlights,
    events: upcoming,
    districts: districts.map((d) => ({ ...d, event_ids: byDistrict.get(d.id) ?? [], event_count: counts.get(d.id) ?? 0 })),
    sponsors,
  });
}));

// The site counts a visit once per browser session (the site remembers
// that it did); limited per connection so the counter cannot be pumped.
const visitLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: env.isTest ? 1000 : 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: async (_req, res) => {
    const row = await queryOne("SELECT value FROM site_counters WHERE key = 'visitors'");
    return success(res, { total_visitors: Number(row?.value ?? 0), counted: false });
  },
});

router.post("/visits", visitLimit, asyncHandler(async (_req, res) => {
  const row = await queryOne(
    `UPDATE site_counters SET value = value + 1, updated_at = NOW() WHERE key = 'visitors' RETURNING value`
  );
  res.set("Cache-Control", "no-store");
  return success(res, { total_visitors: Number(row?.value ?? 0), counted: true });
}));

const eventsQuery = z.object({
  district: z.string().trim().max(40).optional().default(""),
  phase: z.enum(["current", "past"]).optional().default("current"),
});

router.get("/events", asyncHandler(async (req, res) => {
  const q = parseOrThrow(eventsQuery, req.query);
  const phases = q.phase === "past" ? ["completed"] : ["live", "upcoming"];
  return success(res, await events.listPublic({ phases, district: q.district, limit: 100 }));
}));

router.get("/events/:id", asyncHandler(async (req, res) =>
  success(res, await events.getPublic(parseOrThrow(idParam, req.params.id)))));

// Polled by the registration form for its live slot counter.
router.get("/events/:id/slots", asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  return success(res, await events.slots(parseOrThrow(idParam, req.params.id)));
}));

export default router;
