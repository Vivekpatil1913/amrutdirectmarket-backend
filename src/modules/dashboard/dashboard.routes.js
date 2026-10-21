import { Router } from "express";
import { query, queryOne } from "../../db/pool.js";
import { requireEditor } from "../../middleware/auth.js";
import { asyncHandler, success } from "../../lib/errors.js";
import { COMPILED } from "../collections/collections.routes.js";
import * as crud from "../collections/crud.service.js";
import { listSections } from "../sections/sections.service.js";

const router = Router();

// Every number here is counted from the database at request time.
router.get("/", requireEditor, asyncHandler(async (_req, res) => {
  const [enq, media, users, trend, statuses, daily, recentEnquiries, recentActivity, sections, collectionCounts] =
    await Promise.all([
      queryOne(
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE status = 'new') AS new,
                COUNT(*) FILTER (WHERE created_at >= date_trunc('month', NOW())) AS this_month,
                COUNT(*) FILTER (WHERE created_at >= date_trunc('month', NOW()) - INTERVAL '1 month'
                                   AND created_at < date_trunc('month', NOW())) AS last_month
           FROM enquiries WHERE deleted_at IS NULL`
      ),
      queryOne("SELECT COUNT(*) AS total FROM media_assets WHERE deleted_at IS NULL"),
      queryOne("SELECT COUNT(*) AS total FROM admin_users WHERE deleted_at IS NULL AND is_active = TRUE"),
      query(
        `SELECT TO_CHAR(date_trunc('month', created_at), 'YYYY-MM') AS month,
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'new')::int AS new
           FROM enquiries
          WHERE deleted_at IS NULL AND created_at >= date_trunc('month', NOW()) - INTERVAL '11 months'
          GROUP BY 1 ORDER BY 1`
      ),
      query("SELECT status, COUNT(*)::int AS total FROM enquiries WHERE deleted_at IS NULL GROUP BY status ORDER BY status"),
      query(
        `SELECT TO_CHAR(days.day, 'YYYY-MM-DD') AS day, COUNT(e.id)::int AS total
           FROM generate_series(CURRENT_DATE - INTERVAL '6 days', CURRENT_DATE, INTERVAL '1 day') AS days(day)
           LEFT JOIN enquiries e
             ON e.deleted_at IS NULL AND e.created_at >= days.day AND e.created_at < days.day + INTERVAL '1 day'
          GROUP BY days.day ORDER BY days.day`
      ),
      query(
        `SELECT id, name, email, subject_label, status, created_at FROM enquiries
          WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 6`
      ),
      query("SELECT id, user_name, action, entity, summary, created_at FROM activity_logs ORDER BY created_at DESC LIMIT 8"),
      listSections(),
      Promise.all(
        Object.values(COMPILED).map(async (c) => ({ name: c.name, entity: c.entity, ...(await crud.counts(c)) }))
      ),
    ]);

  const published = collectionCounts.reduce((n, c) => n + c.published, 0);
  const draft = collectionCounts.reduce((n, c) => n + c.draft, 0);

  return success(res, {
    stats: {
      totalEnquiries: enq.total,
      newEnquiries: enq.new,
      enquiriesThisMonth: enq.this_month,
      enquiriesLastMonth: enq.last_month,
      publishedRecords: published,
      draftRecords: draft,
      totalRecords: published + draft,
      contentModules: collectionCounts.length + sections.length,
      sectionsPublished: sections.filter((s) => s.is_published && !s.has_unpublished_changes).length,
      sectionsPending: sections.filter((s) => s.has_unpublished_changes).length,
      mediaAssets: media.total,
      activeUsers: users.total,
    },
    collections: collectionCounts,
    sections,
    enquiryTrend: trend,
    enquiryStatuses: statuses,
    dailyEnquiries: daily,
    recentEnquiries,
    recentActivity,
  });
}));

export default router;
