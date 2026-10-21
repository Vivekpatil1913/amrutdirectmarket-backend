import { Router } from "express";
import { requireAdmin, requireEditor } from "../../middleware/auth.js";
import { asyncHandler, success } from "../../lib/errors.js";
import { SECTIONS } from "./sections.config.js";
import * as service from "./sections.service.js";

const router = Router();

// "settings" and "contact" drive the whole site's chrome; only admins change them.
const guardFor = (key) => (key === "settings" || key === "contact" ? requireAdmin : requireEditor);
const guard = (req, res, next) => guardFor(req.params.key)(req, res, next);

router.get("/", requireEditor, asyncHandler(async (_req, res) => success(res, await service.listSections())));

router.get("/meta", requireEditor, asyncHandler(async (_req, res) => success(res, SECTIONS)));

router.get("/:key", requireEditor, asyncHandler(async (req, res) => success(res, await service.getSection(req.params.key))));

// Saves the working copy. ?publish=true also publishes it in the same transaction.
router.put(
  "/:key",
  guard,
  asyncHandler(async (req, res) => {
    const publish = req.query.publish === "true";
    return success(res, await service.saveDraft(req.params.key, req.body, req.user, { publish }));
  })
);

router.post("/:key/publish", guard, asyncHandler(async (req, res) =>
  success(res, await service.publishSection(req.params.key, req.user))));

router.post("/:key/discard", guard, asyncHandler(async (req, res) =>
  success(res, await service.discardDraft(req.params.key, req.user))));

export default router;
