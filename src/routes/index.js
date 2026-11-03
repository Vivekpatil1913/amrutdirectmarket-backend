import { Router } from "express";
import { query } from "../db/pool.js";
import { asyncHandler, success } from "../lib/errors.js";
import { requireEditor, requirePortal } from "../middleware/auth.js";
import { env } from "../config/env.js";
import {
  CASTE_CATEGORIES, ENQUIRY_STATUSES, EVENT_STATUSES, EWS_ELIGIBLE_CASTES, FORM_FIELD_TYPES, ICONS, QUOTA_TYPES,
  REGISTRATION_STATUSES, ROLES, SECTION_TARGETS, SPONSOR_STATUSES, SPONSOR_TIERS,
} from "../lib/constants.js";
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
import districtRoutes from "../modules/districts/districts.routes.js";
import eventRoutes from "../modules/events/events.routes.js";
import otpRoutes from "../modules/otp/otp.routes.js";
import { adminRegistrations, publicRegistrations } from "../modules/registrations/registrations.routes.js";
import sponsorRoutes from "../modules/sponsors/sponsors.routes.js";
import eventMediaRoutes from "../modules/event-media/eventMedia.routes.js";
import analyticsRoutes from "../modules/analytics/analytics.routes.js";
import { adminForms, publicForms } from "../modules/forms/forms.routes.js";

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
  router.use("/public/otp", otpRoutes);
  router.use("/public/registrations", publicRegistrations);
  router.use("/public/forms", publicForms);
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

  // ── Thet Bajar Peth portal (district managers + super admins) ────────────
  router.get("/admin/portal/meta", requirePortal, (_req, res) =>
    success(res, {
      eventStatuses: EVENT_STATUSES,
      quotaTypes: QUOTA_TYPES,
      casteCategories: CASTE_CATEGORIES,
      ewsEligibleCastes: EWS_ELIGIBLE_CASTES,
      registrationStatuses: REGISTRATION_STATUSES,
      sponsorStatuses: SPONSOR_STATUSES,
      sponsorTiers: SPONSOR_TIERS,
      formFieldTypes: FORM_FIELD_TYPES,
      uploadMaxMb: env.upload.maxMb,
    })
  );
  router.use("/admin/districts", districtRoutes);
  router.use("/admin/events", eventRoutes);
  router.use("/admin/registrations", adminRegistrations);
  router.use("/admin/sponsors", sponsorRoutes);
  router.use("/admin/event-media", eventMediaRoutes);
  router.use("/admin/analytics", analyticsRoutes);
  router.use("/admin/forms", adminForms);

  return router;
}
