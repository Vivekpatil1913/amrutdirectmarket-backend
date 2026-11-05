import { Router } from "express";
import rateLimit from "express-rate-limit";
import { env } from "../../config/env.js";
import { districtScope, requirePortal, requireSuperadmin } from "../../middleware/auth.js";
import { uploadBookingFiles } from "../../middleware/upload.js";
import { asyncHandler, paginated, parseOrThrow, success, validation } from "../../lib/errors.js";
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

// Multipart bookings carry the answers as a JSON `payload` field next to the
// uploaded files (one per file field, named by its key); plain JSON bodies
// are accepted for bookings without files.
function bookingBody(req) {
  if (!req.is("multipart/form-data")) return req.body;
  try {
    return JSON.parse(req.body?.payload ?? "{}");
  } catch {
    throw validation([{ field: "payload", message: "Malformed booking data" }]);
  }
}

export const publicRegistrations = Router();
publicRegistrations.post("/", submitLimit, uploadBookingFiles.any(), asyncHandler(async (req, res) => {
  const uploads = req.files ?? [];
  let body;
  try {
    body = bookingBody(req);
  } catch (err) {
    await service.discard(uploads);
    throw err;
  }
  const row = await service.submit(body, uploads, { ip: req.ip, userAgent: req.get("user-agent") });
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

adminRegistrations.get("/:id/files/:key", asyncHandler(async (req, res) => {
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(req.params.key)) return res.status(404).json({ error: { code: "NOT_FOUND", message: "File not found" } });
  const file = await service.getFile(id(req), req.params.key, req.user, districtScope(req));
  res.set("Cache-Control", "private, no-store");
  return res.download(file.path, file.name, { headers: { "Content-Type": file.mime } });
}));

adminRegistrations.post("/:id/reveal-aadhaar", requireSuperadmin, asyncHandler(async (req, res) =>
  success(res, await service.revealAadhaar(id(req), req.user))));
