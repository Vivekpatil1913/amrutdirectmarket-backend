import { z } from "zod";
import bcrypt from "bcryptjs";
import { queryOne } from "../../db/pool.js";
import { notFound, parseOrThrow, validation } from "../../lib/errors.js";
import { cleanString, requiredString } from "../../lib/validators.js";
import { audit } from "../../lib/audit.js";
import { FORM_FIELD_TYPES } from "../../lib/constants.js";

// Form builder: a super admin manages every field of a public form. The
// definition is data; the public form renders it in order, and answers are
// validated here against the very same definition.
//
// "System" fields map to columns of the booking record: they cannot be
// deleted or change type. Locked ones are always mandatory (the brief's core
// fields); the others (mobile, email, Udyam) may be made optional or hidden.
// Every other field is a custom question whose answer is stored in `extra`.

export const FORM_KEYS = ["vendor_registration"];

const opt = (value, label_mr, label_en) => ({ value, label_mr, label_en });

const DEFAULT_SYSTEM_FIELDS = [
  { key: "name", type: "text", locked: true, label_mr: "व्यक्तीचे नाव", label_en: "Name of individual" },
  { key: "business_name", type: "text", locked: true, label_mr: "व्यवसायाचे नाव", label_en: "Name of business" },
  {
    key: "nature_of_business", type: "select", locked: true, ownOptions: true,
    label_mr: "व्यवसायाचे स्वरूप", label_en: "Nature of business",
    options: [
      opt("manufacturer", "उत्पादक", "Manufacturer"),
      opt("artisan", "कारागीर / हस्तकला", "Artisan / handicrafts"),
      opt("farmer", "शेतकरी / शेतकरी उत्पादक कंपनी", "Farmer / FPO"),
      opt("shg", "स्वयं-सहायता गट", "Self-help group"),
      opt("food_processing", "अन्न प्रक्रिया", "Food processing"),
      opt("retailer", "किरकोळ विक्रेता", "Retailer"),
      opt("wholesaler", "घाऊक विक्रेता", "Wholesaler"),
      opt("service", "सेवा", "Service provider"),
      opt("other", "इतर", "Other"),
    ],
  },
  // Options are the site's published product categories.
  { key: "product_categories", type: "checkbox", locked: true, label_mr: "उत्पादन श्रेणी", label_en: "Product category" },
  { key: "aadhaar", type: "number", locked: true, label_mr: "आधार क्रमांक", label_en: "Aadhaar number" },
  { key: "caste_category", type: "select", locked: true, label_mr: "जात प्रवर्ग", label_en: "Caste category" },
  // Required for EWS / reserved categories only (see registrations.schema.js).
  { key: "caste_name", type: "text", locked: true, label_mr: "जातीचे नाव", label_en: "Caste name" },
  { key: "caste_certificate", type: "file", locked: true, label_mr: "जात प्रमाणपत्र", label_en: "Caste certificate" },
  { key: "phone", type: "phone", label_mr: "मोबाईल क्रमांक", label_en: "Mobile number", required: true, enabled: true },
  { key: "email", type: "email", label_mr: "ईमेल", label_en: "Email", required: false, enabled: false },
  { key: "udyam_number", type: "text", label_mr: "उद्यम नोंदणी क्रमांक", label_en: "Udyam Registration Number", required: false, enabled: false },
];
export const SYSTEM_FIELDS = Object.fromEntries(DEFAULT_SYSTEM_FIELDS.map((f) => [f.key, f]));

// Keys a custom question may not use: system fields and request plumbing.
const RESERVED = [
  ...Object.keys(SYSTEM_FIELDS),
  "event_id", "quota_type", "category_id", "consent", "language", "extra", "website", "payload", "dm_notes",
];

// Types whose answer is one of the field's options.
export const CHOICE_TYPES = ["select", "radio"];

const optionSchema = z.object({
  value: z.string().trim().regex(/^[a-z0-9_-]{1,40}$/, "Option values use lowercase letters, numbers, - and _"),
  label_mr: requiredString(80, "Option label"),
  label_en: cleanString(80).default(""),
});

const fieldSchema = z
  .object({
    key: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]{1,39}$/, "Keys start with a letter and use lowercase letters, numbers and _"),
    label_mr: requiredString(120, "Marathi label"),
    label_en: cleanString(120).default(""),
    type: z.enum(FORM_FIELD_TYPES, { errorMap: () => ({ message: "Choose a valid field type" }) }),
    required: z.boolean().default(false),
    enabled: z.boolean().default(true),
    placeholder: cleanString(120).default(""),
    max: z.coerce.number().int().min(1).max(2000).optional(),
    options: z.array(optionSchema).max(40).default([]),
  })
  .refine((f) => SYSTEM_FIELDS[f.key] || !RESERVED.includes(f.key), { message: "This key is used by a built-in field", path: ["key"] })
  .refine((f) => SYSTEM_FIELDS[f.key] || !CHOICE_TYPES.includes(f.type) || f.options.length > 0, {
    message: "A dropdown or radio group needs at least one option",
    path: ["options"],
  })
  .refine((f) => new Set(f.options.map((o) => o.value)).size === f.options.length, {
    message: "Option values must be unique",
    path: ["options"],
  });

// Applies the fixed parts of a system field over what is stored, so neither
// an old definition nor a crafted request can change a column's type, drop a
// locked field or make it optional.
function enforceSystem(f) {
  const sys = SYSTEM_FIELDS[f.key];
  const options = sys.ownOptions ? (f.options?.length ? f.options : sys.options) : [];
  const fixed = { ...f, key: sys.key, type: sys.type, system: true, locked: Boolean(sys.locked), options };
  if (sys.locked) Object.assign(fixed, { required: true, enabled: true });
  if (!fixed.enabled) fixed.required = false;
  return fixed;
}

const systemDefault = (sys) =>
  enforceSystem({ required: true, enabled: true, placeholder: "", ...sys, options: sys.options ?? [] });

// The definition as the forms use it: system fields fixed up, missing ones
// added (a form always has every system field), custom ones kept as saved.
export function normalizeFields(fields) {
  const seen = new Set();
  const out = [];
  for (const f of Array.isArray(fields) ? fields : []) {
    if (!f?.key || seen.has(f.key)) continue;
    seen.add(f.key);
    out.push(SYSTEM_FIELDS[f.key] ? enforceSystem({ placeholder: "", ...f }) : { placeholder: "", enabled: true, ...f, system: false, locked: false });
  }
  for (const sys of DEFAULT_SYSTEM_FIELDS) if (!seen.has(sys.key)) out.push(systemDefault(sys));
  return out;
}

export const definitionSchema = z.object({
  title: requiredString(120, "Title"),
  fields: z
    .array(fieldSchema)
    .max(60, "At most 60 fields")
    .refine((fs) => new Set(fs.map((f) => f.key)).size === fs.length, "Each field needs a unique key")
    .refine((fs) => fs.filter((f) => !SYSTEM_FIELDS[f.key]).length <= 40, "At most 40 custom fields"),
});

export async function getForm(key) {
  if (!FORM_KEYS.includes(key)) throw notFound("Form");
  const row = await queryOne("SELECT key, title, fields, updated_at FROM form_definitions WHERE key = $1", [key]);
  if (!row) throw notFound("Form");
  return { ...row, fields: normalizeFields(row.fields) };
}

export async function saveForm(key, body, user) {
  await getForm(key);
  const data = parseOrThrow(definitionSchema, body ?? {});
  // A locked field left out of the request is put back, never deleted.
  const fields = normalizeFields(data.fields).map(({ system, locked, ...f }) => ({ ...f, system }));
  const custom = fields.filter((f) => !f.system).length;
  const row = await queryOne(
    `UPDATE form_definitions SET title = $1, fields = $2::jsonb, updated_by = $3, updated_at = NOW()
      WHERE key = $4 RETURNING key, title, fields, updated_at`,
    [data.title, JSON.stringify(fields), user.id, key]
  );
  await audit(user, "update", "form_definitions", key, `Updated form "${data.title}" (${custom} custom field(s))`);
  return { ...row, fields: normalizeFields(row.fields) };
}

// ── Answers to custom fields ────────────────────────────────────────────────

export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const PHONE_RE = /^[6-9]\d{9}$/;

const isHttpUrl = (v) => {
  try {
    return ["http:", "https:"].includes(new URL(v).protocol);
  } catch {
    return false;
  }
};

// A required text-like answer, or an optional one where "" means unanswered.
function textual(f, label, { max, transform = (v) => v, test, message }) {
  const base = cleanString(max).transform(transform);
  const checked = test ? base.refine((v) => v === "" || test(v), message) : base;
  const value = f.required ? checked.refine((v) => v !== "", `${label} is required`) : checked;
  return z.preprocess((v) => (v === undefined || v === null ? "" : typeof v === "number" ? String(v) : v), value);
}

function answerValidator(f) {
  const label = f.label_en || f.label_mr;
  const values = f.options.map((o) => o.value);
  switch (f.type) {
    case "number":
      return textual(f, label, { max: 30, test: (v) => /^-?\d+(\.\d+)?$/.test(v), message: `${label} must be a number` })
        .transform((v) => (v === "" ? null : Number(v)));
    case "email":
      return textual(f, label, {
        max: 160, transform: (v) => v.toLowerCase(), test: (v) => z.string().email().safeParse(v).success, message: "Enter a valid email address",
      });
    case "phone":
      return textual(f, label, {
        max: 20, transform: (v) => v.replace(/[\s-]/g, "").replace(/^\+91/, ""), test: (v) => PHONE_RE.test(v), message: "Enter a valid 10-digit mobile number",
      });
    case "pan":
      return textual(f, label, { max: 10, transform: (v) => v.toUpperCase(), test: (v) => PAN_RE.test(v), message: "Enter a valid PAN (e.g. ABCDE1234F)" });
    case "url":
      return textual(f, label, { max: 500, test: isHttpUrl, message: "Enter a valid link starting with http:// or https://" });
    case "date":
      return textual(f, label, {
        max: 10, test: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), message: `${label} must be a date`,
      });
    case "password":
      // Stored only as a bcrypt hash, never as entered.
      return textual(f, label, { max: 128, test: (v) => v.length >= 8, message: `${label} must have at least 8 characters` })
        .transform((v) => (v === "" ? "" : bcrypt.hashSync(v, 10)));
    case "select":
    case "radio":
      return textual(f, label, { max: 40, test: (v) => values.includes(v), message: `Choose a valid ${label.toLowerCase()}` });
    case "checkbox":
      if (!values.length) {
        // A single tick box.
        const tick = z.preprocess((v) => v === true || v === "true", z.boolean());
        return f.required ? tick.refine((v) => v, `${label} must be ticked`) : tick;
      }
      return z
        .preprocess((v) => (v === undefined || v === null || v === "" ? [] : Array.isArray(v) ? v : [v]), z.array(z.string()))
        .refine((v) => v.every((x) => values.includes(x)), `Choose valid options for ${label.toLowerCase()}`)
        .refine((v) => !f.required || v.length > 0, `Choose at least one option for ${label.toLowerCase()}`)
        .transform((v) => [...new Set(v)]);
    case "file":
      // The upload itself is checked by checkFiles(); nothing is read from the body.
      return z.any().transform(() => undefined);
    default:
      return textual(f, label, { max: f.max ?? (f.type === "textarea" ? 2000 : 200) });
  }
}

// Validates answers to the enabled custom fields; unknown keys are dropped.
// Errors are reported as extra.<key> so the form can show them against the
// question.
export function validateAnswers(fields, answers) {
  const custom = fields.filter((f) => !f.system && f.enabled !== false);
  const shape = Object.fromEntries(custom.map((f) => [f.key, answerValidator(f)]));
  const parsed = z.object(shape).safeParse(answers && typeof answers === "object" && !Array.isArray(answers) ? answers : {});
  if (!parsed.success) {
    throw validation(parsed.error.issues.map((i) => ({ field: `extra.${i.path[0]}`, message: i.message })));
  }
  return Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
}

// Required file questions that came without an upload, as validation details.
export function missingFiles(fields, files, { isRequired = (f) => f.required } = {}) {
  return fields
    .filter((f) => f.type === "file" && f.enabled !== false && isRequired(f) && !files[f.key])
    .map((f) => ({ field: f.system ? f.key : `extra.${f.key}`, message: `Upload the ${(f.label_en || f.label_mr).toLowerCase()}` }));
}
