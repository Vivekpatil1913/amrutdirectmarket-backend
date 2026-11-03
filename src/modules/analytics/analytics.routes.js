import { Router } from "express";
import { query } from "../../db/pool.js";
import { districtScope, requirePortal } from "../../middleware/auth.js";
import { asyncHandler, success } from "../../lib/errors.js";
import { PHASE_SQL } from "../events/events.service.js";

const router = Router();

// GIS / reporting dashboard. A super admin sees the whole state; a district
// manager gets the same report confined to their district. Every number is
// counted from the database at request time.
router.get("/", requirePortal, asyncHandler(async (req, res) => {
  const scope = districtScope(req);
  const [districts, statuses, castes, quotas, trend] = await Promise.all([
    query(
      `SELECT d.id, d.code, d.name_mr, d.name_en, d.lat::float AS lat, d.lng::float AS lng,
              COALESCE(ev.events, 0)::int AS events,
              COALESCE(ev.live, 0)::int AS live_events,
              COALESCE(ev.upcoming, 0)::int AS upcoming_events,
              COALESCE(st.total, 0)::int AS stalls_total,
              COALESCE(st.total - st.available, 0)::int AS stalls_booked,
              COALESCE(rg.applicants, 0)::int AS applicants,
              COALESCE(rg.approved, 0)::int AS approved,
              COALESCE(rg.waitlisted, 0)::int AS waitlisted,
              COALESCE(sp.sponsors, 0)::int AS sponsors
         FROM districts d
         LEFT JOIN (
           SELECT e.district_id, COUNT(*) AS events,
                  COUNT(*) FILTER (WHERE (${PHASE_SQL}) = 'live') AS live,
                  COUNT(*) FILTER (WHERE (${PHASE_SQL}) = 'upcoming') AS upcoming
             FROM events e WHERE e.deleted_at IS NULL AND e.status = 'published' AND e.approval_status = 'approved' GROUP BY e.district_id
         ) ev ON ev.district_id = d.id
         LEFT JOIN (
           SELECT e.district_id, SUM(q.total) AS total, SUM(q.available) AS available
             FROM event_stall_quotas q JOIN events e ON e.id = q.event_id
            WHERE e.deleted_at IS NULL AND e.status = 'published' AND e.approval_status = 'approved' GROUP BY e.district_id
         ) st ON st.district_id = d.id
         LEFT JOIN (
           SELECT e.district_id, COUNT(*) AS applicants,
                  COUNT(*) FILTER (WHERE r.status = 'approved') AS approved,
                  COUNT(*) FILTER (WHERE r.status = 'waitlisted') AS waitlisted
             FROM vendor_registrations r JOIN events e ON e.id = r.event_id
            WHERE r.deleted_at IS NULL AND e.deleted_at IS NULL GROUP BY e.district_id
         ) rg ON rg.district_id = d.id
         LEFT JOIN (
           SELECT district_id, COUNT(*) AS sponsors FROM sponsors
            WHERE deleted_at IS NULL AND status = 'approved' GROUP BY district_id
         ) sp ON sp.district_id = d.id
        WHERE d.deleted_at IS NULL AND ($1::int IS NULL OR d.id = $1)
        ORDER BY d.name_en`,
      [scope]
    ),
    query(
      `SELECT r.status, COUNT(*)::int AS total FROM vendor_registrations r JOIN events e ON e.id = r.event_id
        WHERE r.deleted_at IS NULL AND e.deleted_at IS NULL AND ($1::int IS NULL OR e.district_id = $1)
        GROUP BY r.status ORDER BY r.status`,
      [scope]
    ),
    query(
      `SELECT r.caste_category, COUNT(*)::int AS total FROM vendor_registrations r JOIN events e ON e.id = r.event_id
        WHERE r.deleted_at IS NULL AND e.deleted_at IS NULL AND ($1::int IS NULL OR e.district_id = $1)
        GROUP BY r.caste_category ORDER BY total DESC`,
      [scope]
    ),
    query(
      `SELECT q.quota_type, SUM(q.total)::int AS total, SUM(q.total - q.available)::int AS booked
         FROM event_stall_quotas q JOIN events e ON e.id = q.event_id
        WHERE e.deleted_at IS NULL AND e.status = 'published' AND e.approval_status = 'approved' AND ($1::int IS NULL OR e.district_id = $1)
        GROUP BY q.quota_type ORDER BY q.quota_type`,
      [scope]
    ),
    query(
      `SELECT TO_CHAR(date_trunc('month', r.created_at), 'YYYY-MM') AS month, COUNT(*)::int AS total
         FROM vendor_registrations r JOIN events e ON e.id = r.event_id
        WHERE r.deleted_at IS NULL AND e.deleted_at IS NULL AND ($1::int IS NULL OR e.district_id = $1)
          AND r.created_at >= date_trunc('month', NOW()) - INTERVAL '11 months'
        GROUP BY 1 ORDER BY 1`,
      [scope]
    ),
  ]);

  const sum = (key) => districts.reduce((n, d) => n + d[key], 0);
  return success(res, {
    scope: scope ? "district" : "state",
    totals: {
      events: sum("events"),
      liveEvents: sum("live_events"),
      upcomingEvents: sum("upcoming_events"),
      stallsTotal: sum("stalls_total"),
      stallsBooked: sum("stalls_booked"),
      applicants: sum("applicants"),
      approved: sum("approved"),
      waitlisted: sum("waitlisted"),
      sponsors: sum("sponsors"),
      districtsActive: districts.filter((d) => d.events > 0).length,
    },
    districts,
    statuses,
    castes,
    quotas,
    trend,
  });
}));

export default router;
