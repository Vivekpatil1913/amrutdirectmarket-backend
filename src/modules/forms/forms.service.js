import { z } from "zod";
import { queryOne } from "../../db/pool.js";
import { notFound, parseOrThrow, validation } from "../../lib/errors.js";
import { cleanString, requiredString } from "../../lib/validators.js";
import { audit } from "../../lib/audit.js";
import { FORM_FIELD_TYPES } from "../../lib/constants.js";

// Form builder: a super admin appends custom questions to a public form. The
// definition is data; the public form renders it, and answers are validated
// here against the very same definition.

export const FORM_KEYS = ["vendor_registration"];

// Keys of the fixed registration fields; custom questions may not reuse them.
const RESERVED = [
  "event_id", "quota_type", "name", "business_name", "nature_of_business", "category_id", "aadhaar",
  "udyam_number", "caste_category", "phone", "email", "otp_token", "consent", "language", "extra", "website",
];

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
      .regex(/^[a-z][a-z0-9_]{1,39}$/, "Keys start with a letter and use lowercase letters, numbers and _")
      .refine((k) => !RESERVED.includes(k), "This key is used by a built-in field"),
    label_mr: requiredString(120, "Marathi label"),
    label_en: cleanString(120).default(""),
    type: z.enum(FORM_FIELD_TYPES, { errorMap: () => ({ message: "Choose a valid field type" }) }),
    required: z.boolean().default(false),
    max: z.coerce.number().int().min(1).max(2000).optional(),
    options: z.array(optionSchema).max(30).default([]),
  })
  .refine((f) => f.type !== "select" || f.options.length > 0, { message: "A dropdown needs at least one option", path: ["options"] })
  .transform((f) => (f.type === "select" ? f : { ...f, options: [] }));

export const definitionSchema = z.object({
  title: requiredString(120, "Title"),
  fields: z
    .array(fieldSchema)
    .max(30, "At most 30 custom fields")
    .refine((fs) => new Set(fs.map((f) => f.key)).size === fs.length, "Each field needs a unique key"),
});

export async function getForm(key) {
  if (!FORM_KEYS.includes(key)) throw notFound("Form");
  const row = await queryOne("SELECT key, title, fields, updated_at FROM form_definitions WHERE key = $1", [key]);
  if (!row) throw notFound("Form");
  return row;
}

export async function saveForm(key, body, user) {
  await getForm(key);
  const data = parseOrThrow(definitionSchema, body ?? {});
  const row = await queryOne(
    `UPDATE form_definitions SET title = $1, fields = $2::jsonb, updated_by = $3, updated_at = NOW()
      WHERE key = $4 RETURNING key, title, fields, updated_at`,
    [data.title, JSON.stringify(data.fields), user.id, key]
  );
  await audit(user, "update", "form_definitions", key, `Updated form "${data.title}" (${data.fields.length} custom field(s))`);
  return row;
}

function answerValidator(f) {
  const label = f.label_en || f.label_mr;
  switch (f.type) {
    case "number": {
      const n = z.coerce.number({ invalid_type_error: `${label} must be a number` });
      return f.required ? n : z.union([n, z.literal("")]).optional().transform((v) => (v === "" ? null : v ?? null));
    }
    case "checkbox":
      return f.required
        ? z.literal(true, { errorMap: () => ({ message: `${label} must be ticked` }) })
        : z.boolean().optional().default(false);
    case "select": {
      const e = z.enum(f.options.map((o) => o.value), { errorMap: () => ({ message: `Choose a valid ${label.toLowerCase()}` }) });
      return f.required ? e : z.union([e, z.literal("")]).optional().default("");
    }
    case "date": {
      const d = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, `${label} must be a date`);
      return f.required ? d : z.union([d, z.literal("")]).optional().default("");
    }
    default: {
      const max = f.max ?? (f.type === "textarea" ? 1000 : 200);
      return f.required ? requiredString(max, label) : cleanString(max).optional().default("");
    }
  }
}

// Validates answers to the custom fields; unknown keys are dropped. Errors are
// reported as extra.<key> so the form can show them against the question.
export function validateAnswers(fields, answers) {
  const shape = Object.fromEntries(fields.map((f) => [f.key, answerValidator(f)]));
  const parsed = z.object(shape).safeParse(answers && typeof answers === "object" ? answers : {});
  if (!parsed.success) {
    throw validation(parsed.error.issues.map((i) => ({ field: `extra.${i.path.join(".")}`, message: i.message })));
  }
  return parsed.data;
}
