import { Router } from "express";
import { requireSuperadmin } from "../../middleware/auth.js";
import { asyncHandler, success } from "../../lib/errors.js";
import * as service from "./forms.service.js";

export const publicForms = Router();
publicForms.get("/:key", asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-cache");
  const { key, title, fields } = await service.getForm(req.params.key);
  return success(res, { key, title, fields });
}));

export const adminForms = Router();
adminForms.use(requireSuperadmin);
adminForms.get("/:key", asyncHandler(async (req, res) => success(res, await service.getForm(req.params.key))));
adminForms.put("/:key", asyncHandler(async (req, res) => success(res, await service.saveForm(req.params.key, req.body, req.user))));
