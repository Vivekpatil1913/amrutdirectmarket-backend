import { buildObjectSchema } from "../../lib/fieldSchema.js";

const cache = new Map();

// Validation schema for a page section, built once from its field specs.
export function sectionSchema(section) {
  if (!cache.has(section.key)) cache.set(section.key, buildObjectSchema(section.fields));
  return cache.get(section.key);
}
