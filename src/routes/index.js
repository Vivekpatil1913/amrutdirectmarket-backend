import { Router } from "express";
import { query } from "../db/pool.js";
import { asyncHandler, success } from "../lib/errors.js";
import { requireEditor } from "../middleware/auth.js";
import { env } from "../config/env.js";
import { ENQUIRY_STATUSES, ICONS, ROLES, SECTION_TARGETS } from "../lib/constants.js";
import authRoutes from "../modules/auth/auth.routes.js";
import sectionRoutes from "../modules/sections/sections.routes.js";
import { SECTIONS } from "../modules/sections/sections.config.js";
import { COMPILED, adminRouter, publicRouter } from "../modules/collections/collections.routes.js";
import { adminEnquiries, publicEnquiries } from "../modules/enquiries/enquiries.routes.js";
import mediaRoutes from "../modules/media/media.routes.js";
import userRoutes from "../modules/users/users.routes.js";
import activityRoutes from "../modules/activity/activity.routes.js";
import dashboardRoutes from "../modules/dashboard/dashboard.routes.js";
import publicRoutes from "../modules/public/public.routes.js";

const startedAt = Date.now();

export function buildRouter() {
  const router = Router();

  router.get("/health", asyncHandler(async (_req, res) => {
    await query("SELECT 1");
    return success(res, {
      status: "ok",
      database: "connected",
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      time: new Date().toISOString(),
    });
  }));

  router.use("/auth", authRoutes);

  // ── Public (website) ─────────────────────────────────────────────────────
  router.use("/public", publicRoutes);
  router.use("/public/enquiries", publicEnquiries);
  for (const [name, c] of Object.entries(COMPILED)) router.use(`/public/${name}`, publicRouter(c));

  // ── Admin (CMS) ──────────────────────────────────────────────────────────
  // Everything the admin forms are rendered from: field specs and option lists.
  router.get("/admin/meta", requireEditor, (_req, res) =>
    success(res, {
      icons: ICONS,
      sectionTargets: SECTION_TARGETS,
      roles: ROLES,
      enquiryStatuses: ENQUIRY_STATUSES,
      uploadMaxMb: env.upload.maxMb,
      sections: SECTIONS,
      collections: Object.fromEntries(
        Object.entries(COMPILED).map(([name, c]) => [
          name,
          { entity: c.entity, fields: c.fields, filters: c.filters, titleField: c.titleField },
        ])
      ),
    })
  );
  router.use("/admin/dashboard", dashboardRoutes);
  router.use("/admin/sections", sectionRoutes);
  for (const [name, c] of Object.entries(COMPILED)) router.use(`/admin/${name}`, adminRouter(c));
  router.use("/admin/enquiries", adminEnquiries);
  router.use("/admin/media", mediaRoutes);
  router.use("/admin/users", userRoutes);
  router.use("/admin/activity", activityRoutes);

  return router;
}
