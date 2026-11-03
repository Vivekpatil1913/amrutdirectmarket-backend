import { Router } from "express";
import { z } from "zod";
import { queryOne } from "../../db/pool.js";
import { asyncHandler, notFound, parseOrThrow, success } from "../../lib/errors.js";
import { idParam } from "../../lib/validators.js";
import { COMPILED } from "../collections/collections.routes.js";
import * as crud from "../collections/crud.service.js";
import { publicSections } from "../sections/sections.service.js";
import { SECTION_KEYS } from "../sections/sections.config.js";
import * as events from "../events/events.service.js";
import { listDistricts } from "../districts/districts.routes.js";
import { publicSponsors } from "../sponsors/sponsors.routes.js";

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

// The home page's live data: headline counts, live and upcoming events with
// their stall availability, districts for the map and approved sponsors.
router.get("/thet-bajar", asyncHandler(async (_req, res) => {
  const [stats, upcoming, districts, sponsors] = await Promise.all([
    queryOne(
      `SELECT COUNT(*)::int AS total_events,
              COUNT(*) FILTER (WHERE (${events.PHASE_SQL}) = 'live')::int AS live_events,
              COUNT(*) FILTER (WHERE (${events.PHASE_SQL}) = 'upcoming')::int AS upcoming_events,
              COUNT(DISTINCT e.district_id)::int AS districts_covered,
              (SELECT COUNT(*) FROM vendor_registrations r JOIN events x ON x.id = r.event_id
                WHERE r.deleted_at IS NULL AND x.deleted_at IS NULL AND r.status IN ('pending', 'approved'))::int AS vendors
         FROM events e WHERE e.deleted_at IS NULL AND e.status = 'published'`
    ),
    events.listPublic({ limit: 12 }),
    listDistricts({ activeOnly: true }),
    publicSponsors(),
  ]);
  const byDistrict = new Map();
  for (const e of upcoming) byDistrict.set(e.district_id, [...(byDistrict.get(e.district_id) ?? []), e.id]);
  res.set("Cache-Control", "no-cache");
  return success(res, {
    stats,
    events: upcoming,
    districts: districts.map((d) => ({ ...d, event_ids: byDistrict.get(d.id) ?? [] })),
    sponsors,
  });
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
