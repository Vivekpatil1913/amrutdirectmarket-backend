import { z } from "zod";

// Reusable zod building blocks. Admin text is always rendered by React as
// plain text (never as HTML), so these rules keep values sane rather than
// acting as an HTML sanitiser. Control characters are stripped everywhere.

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export const cleanString = (max) =>
  z
    .string({ invalid_type_error: "Must be text" })
    .transform((v) => v.replace(CONTROL_CHARS, "").trim())
    .pipe(z.string().max(max, `Must be at most ${max} characters`));

export const requiredString = (max, label = "This field") =>
  z
    .string({ required_error: `${label} is required`, invalid_type_error: `${label} must be text` })
    .transform((v) => v.replace(CONTROL_CHARS, "").trim())
    .pipe(z.string().min(1, `${label} is required`).max(max, `Must be at most ${max} characters`));

const isHttpUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

// An http(s) URL; javascript:, data: and other schemes are refused so a link
// saved in the CMS can never execute script on the public site.
export const httpUrl = (max = 500) =>
  cleanString(max).refine(isHttpUrl, "Enter a valid http(s) URL");

export const optionalHttpUrl = (max = 500) =>
  cleanString(max).refine((v) => v === "" || isHttpUrl(v), "Enter a valid http(s) URL");

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugify(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export const idParam = z
  .string()
  .regex(/^[1-9]\d{0,9}$/, "A positive record ID is required")
  .transform(Number);

export const paginationQuery = {
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().trim().max(100).optional().default(""),
  trash: z.enum(["true", "false"]).optional().default("false"),
  order: z.enum(["asc", "desc"]).optional(),
};
