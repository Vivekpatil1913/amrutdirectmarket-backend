import { Router } from "express";
import { asyncHandler, notFound, success } from "../../lib/errors.js";
import { COMPILED } from "../collections/collections.routes.js";
import * as crud from "../collections/crud.service.js";
import { publicSections } from "../sections/sections.service.js";
import { SECTION_KEYS } from "../sections/sections.config.js";

const router = Router();

// Everything the single-page site renders, in one request: published section
// content plus the published records of every collection. Drafts and
// soft-deleted rows are never included.
export async function siteContent() {
  const [sections, ...lists] = await Promise.all([
    publicSections(),
    ...Object.values(COMPILED).map((c) => crud.listPublic(c)),
  ]);
  const collections = Object.fromEntries(Object.values(COMPILED).map((c, i) => [c.publicKey, lists[i]]));
  return { sections, collections };
}

router.get("/site", asyncHandler(async (_req, res) => {
  res.set("Cache-Control", "no-cache"); // revalidate via ETag: admin changes show on the next load
  return success(res, await siteContent());
}));

router.get("/sections/:key", asyncHandler(async (req, res) => {
  if (!SECTION_KEYS.includes(req.params.key)) throw notFound("Section");
  const sections = await publicSections();
  if (!sections[req.params.key]) throw notFound("Section");
  res.set("Cache-Control", "no-cache");
  return success(res, sections[req.params.key]);
}));

export default router;
