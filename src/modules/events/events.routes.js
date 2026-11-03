import { Router } from "express";
import { districtScope, requirePortal, requireSuperadmin } from "../../middleware/auth.js";
import { asyncHandler, paginated, parseOrThrow, success } from "../../lib/errors.js";
import { idParam } from "../../lib/validators.js";
import * as service from "./events.service.js";

// District managers manage their own district's events; super admins every
// district's. The scope is applied inside the service on every query.
const router = Router();
router.use(requirePortal);
const id = (req) => parseOrThrow(idParam, req.params.id);

router.get("/", asyncHandler(async (req, res) => {
  const { rows, total, page, pageSize } = await service.list(req.query, districtScope(req));
  return paginated(res, rows, total, page, pageSize);
}));

router.get("/:id", asyncHandler(async (req, res) =>
  success(res, await service.getById(id(req), districtScope(req), { includeDeleted: req.query.trash === "true" }))));

router.post("/", asyncHandler(async (req, res) =>
  success(res, await service.create(req.body, req.user, districtScope(req)), 201)));

router.put("/:id", asyncHandler(async (req, res) =>
  success(res, await service.update(id(req), req.body, req.user, districtScope(req)))));

// Super admin approval of a district manager's event.
router.post("/:id/review", requireSuperadmin, asyncHandler(async (req, res) =>
  success(res, await service.review(id(req), req.body, req.user))));

router.delete("/:id", asyncHandler(async (req, res) =>
  success(res, await service.softDelete(id(req), req.user, districtScope(req)))));

router.post("/:id/restore", asyncHandler(async (req, res) =>
  success(res, await service.restore(id(req), req.user, districtScope(req)))));

export default router;
