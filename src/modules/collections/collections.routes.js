import { Router } from "express";
import { z } from "zod";
import { requireAdmin, requireEditor } from "../../middleware/auth.js";
import { asyncHandler, paginated, parseOrThrow, success } from "../../lib/errors.js";
import { idParam } from "../../lib/validators.js";
import { COLLECTIONS } from "./collections.config.js";
import * as crud from "./crud.service.js";

export const COMPILED = Object.fromEntries(
  Object.entries(COLLECTIONS).map(([name, def]) => [name, crud.compile(name, def)])
);

const statusBody = z.object({ status: z.enum(["published", "draft"]) });
const id = (req) => parseOrThrow(idParam, req.params.id);

// Admin CRUD router for one collection. Editors create/edit/publish; deleting
// and restoring require the admin role.
export function adminRouter(c) {
  const router = Router();

  router.get("/", requireEditor, asyncHandler(async (req, res) => {
    const { rows, total, page, pageSize } = await crud.list(c, req.query);
    return paginated(res, rows, total, page, pageSize);
  }));

  router.get("/:id", requireEditor, asyncHandler(async (req, res) =>
    success(res, await crud.getById(c, id(req), { includeDeleted: req.query.trash === "true" }))));

  router.post("/", requireEditor, asyncHandler(async (req, res) =>
    success(res, await crud.create(c, req.body, req.user), 201)));

  router.put("/:id", requireEditor, asyncHandler(async (req, res) =>
    success(res, await crud.update(c, id(req), req.body, req.user))));

  router.patch("/:id/status", requireEditor, asyncHandler(async (req, res) => {
    const { status } = parseOrThrow(statusBody, req.body);
    return success(res, await crud.setStatus(c, id(req), status, req.user));
  }));

  router.delete("/:id", requireAdmin, asyncHandler(async (req, res) =>
    success(res, await crud.softDelete(c, id(req), req.user))));

  router.post("/:id/restore", requireAdmin, asyncHandler(async (req, res) =>
    success(res, await crud.restore(c, id(req), req.user))));

  return router;
}

export function publicRouter(c) {
  const router = Router();
  router.get("/", asyncHandler(async (_req, res) => {
    res.set("Cache-Control", "no-cache");
    return success(res, await crud.listPublic(c));
  }));
  return router;
}
