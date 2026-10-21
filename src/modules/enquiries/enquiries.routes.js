import { Router } from "express";
import rateLimit from "express-rate-limit";
import { env } from "../../config/env.js";
import { requireAdmin, requireEditor } from "../../middleware/auth.js";
import { asyncHandler, paginated, parseOrThrow, success } from "../../lib/errors.js";
import { idParam } from "../../lib/validators.js";
import * as service from "./enquiries.service.js";

const id = (req) => parseOrThrow(idParam, req.params.id);

const submitLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.isTest ? 1000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many enquiries from this connection. Please try again later." } },
});

export const publicEnquiries = Router();
publicEnquiries.post("/", submitLimit, asyncHandler(async (req, res) => {
  const row = await service.submit(req.body, { ip: req.ip, userAgent: req.get("user-agent") });
  return success(res, { received: true, id: row.id }, 201);
}));

export const adminEnquiries = Router();

adminEnquiries.get("/", requireEditor, asyncHandler(async (req, res) => {
  const { rows, total, page, pageSize } = await service.list(req.query);
  return paginated(res, rows, total, page, pageSize);
}));

adminEnquiries.get("/:id", requireEditor, asyncHandler(async (req, res) =>
  success(res, await service.getById(id(req), { includeDeleted: req.query.trash === "true" }))));

adminEnquiries.patch("/:id", requireEditor, asyncHandler(async (req, res) =>
  success(res, await service.update(id(req), req.body, req.user))));

adminEnquiries.delete("/:id", requireAdmin, asyncHandler(async (req, res) =>
  success(res, await service.softDelete(id(req), req.user))));

adminEnquiries.post("/:id/restore", requireAdmin, asyncHandler(async (req, res) =>
  success(res, await service.restore(id(req), req.user))));
