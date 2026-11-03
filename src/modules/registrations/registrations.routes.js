import { Router } from "express";
import rateLimit from "express-rate-limit";
import { env } from "../../config/env.js";
import { districtScope, requirePortal, requireSuperadmin } from "../../middleware/auth.js";
import { asyncHandler, paginated, parseOrThrow, success } from "../../lib/errors.js";
import { idParam } from "../../lib/validators.js";
import * as service from "./registrations.service.js";

const id = (req) => parseOrThrow(idParam, req.params.id);

const submitLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.isTest ? 1000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many applications from this connection. Please try again later." } },
});

export const publicRegistrations = Router();
publicRegistrations.post("/", submitLimit, asyncHandler(async (req, res) => {
  const row = await service.submit(req.body, { ip: req.ip, userAgent: req.get("user-agent") });
  return success(res, { reference_no: row.reference_no, status: row.status, available: row.available ?? null }, 201);
}));

// Applicant CRM for district managers (own district) and super admins.
export const adminRegistrations = Router();
adminRegistrations.use(requirePortal);

adminRegistrations.get("/", asyncHandler(async (req, res) => {
  const { rows, total, page, pageSize } = await service.list(req.query, districtScope(req));
  return paginated(res, rows, total, page, pageSize);
}));

adminRegistrations.get("/:id", asyncHandler(async (req, res) =>
  success(res, await service.getById(id(req), districtScope(req), { includeDeleted: req.query.trash === "true" }))));

adminRegistrations.post("/", asyncHandler(async (req, res) =>
  success(res, await service.createByManager(req.body, req.user, districtScope(req)), 201)));

adminRegistrations.patch("/:id", asyncHandler(async (req, res) =>
  success(res, await service.update(id(req), req.body, req.user, districtScope(req)))));

adminRegistrations.delete("/:id", asyncHandler(async (req, res) =>
  success(res, await service.softDelete(id(req), req.user, districtScope(req)))));

adminRegistrations.post("/:id/reveal-aadhaar", requireSuperadmin, asyncHandler(async (req, res) =>
  success(res, await service.revealAadhaar(id(req), req.user))));
