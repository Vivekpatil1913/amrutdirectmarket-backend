import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { buildObjectSchema } from "./fieldSchema.js";
import { slugify } from "./validators.js";
import { detectImageType } from "../middleware/upload.js";
import { enquirySchema } from "../modules/enquiries/enquiries.schema.js";
import { SECTIONS } from "../modules/sections/sections.config.js";
import { sectionSchema } from "../modules/sections/sections.schema.js";
import { SEED_SECTIONS } from "../../seeds/content.js";

test("slugify makes URL-safe slugs", () => {
  assert.equal(slugify("Food & Agriculture"), "food-and-agriculture");
  assert.equal(slugify("  Jewellery -- Accessories! "), "jewellery-accessories");
  assert.equal(slugify("अन्न व कृषी"), "");
});

test("field specs: bilingual required applies to Marathi only", () => {
  const schema = buildObjectSchema([{ key: "title", label: "Title", type: "text", bi: true, required: true, max: 10 }]);
  assert.equal(schema.safeParse({ title_mr: "शीर्षक", title_en: "" }).success, true);
  assert.equal(schema.safeParse({ title_mr: "  ", title_en: "Title" }).success, false);
  assert.equal(schema.safeParse({ title_mr: "x".repeat(11) }).success, false);
});

test("field specs: URLs must be http(s)", () => {
  const schema = buildObjectSchema([{ key: "url", label: "URL", type: "url", required: true }]);
  assert.equal(schema.safeParse({ url: "https://mahaamrut.org.in" }).success, true);
  assert.equal(schema.safeParse({ url: "javascript:alert(1)" }).success, false);
  assert.equal(schema.safeParse({ url: "" }).success, false);
});

test("field specs: slug format, select options and number range", () => {
  const schema = buildObjectSchema([
    { key: "slug", label: "Slug", type: "slug" },
    { key: "icon", label: "Icon", type: "select", options: ["a", "b"], default: "a" },
    { key: "display_order", label: "Order", type: "number", min: 0, max: 9999 },
  ]);
  assert.deepEqual(schema.parse({}), { slug: "", icon: "a", display_order: 0 });
  assert.equal(schema.safeParse({ slug: "Bad Slug" }).success, false);
  assert.equal(schema.safeParse({ icon: "c" }).success, false);
  assert.equal(schema.safeParse({ display_order: -1 }).success, false);
});

test("enquiry schema mirrors the public form rules", () => {
  const valid = {
    name: "Asha Patil", email: "Asha@Example.com", phone: "98765 43210",
    subject: "stall", message: "I make handloom sarees in Solapur.", consent: true,
  };
  const parsed = enquirySchema.parse(valid);
  assert.equal(parsed.email, "asha@example.com");
  assert.equal(parsed.phone, "9876543210");
  assert.equal(enquirySchema.safeParse({ ...valid, phone: "12345" }).success, false);
  assert.equal(enquirySchema.safeParse({ ...valid, message: "too short" }).success, false);
  assert.equal(enquirySchema.safeParse({ ...valid, consent: false }).success, false);
  assert.equal(enquirySchema.safeParse({ ...valid, phone: "" }).success, true);
});

test("seed content satisfies every section's validation rules", () => {
  for (const def of SECTIONS) {
    const content = { ...SEED_SECTIONS[def.key] };
    for (const f of def.fields) if (f.type === "image") content[f.key] = { media_id: content[f.key] ? 1 : null, url: "" };
    const result = sectionSchema(def).safeParse(content);
    assert.equal(result.success, true, `${def.key}: ${JSON.stringify(result.error?.issues)}`);
  }
});

test("uploads are recognised by content, not by name", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ap-upload-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const png = path.join(dir, "a.png");
  await writeFile(png, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]));
  assert.equal(await detectImageType(png), "image/png");
  const fake = path.join(dir, "shell.php.jpg");
  await writeFile(fake, "<?php echo 1; ?>");
  assert.equal(await detectImageType(fake), "");
});
