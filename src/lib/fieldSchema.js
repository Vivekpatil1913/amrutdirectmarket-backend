import { z } from "zod";
import { cleanString, requiredString, optionalHttpUrl, SLUG_RE } from "./validators.js";

// Builds zod validators from the declarative field specs used by page sections
// and content collections. The admin panel renders forms from the very same
// specs, so client and server can never disagree about a field.
//
// Spec: { key, label, type, bi?, required?, max?, min?, options?, default? }
// Types: text | textarea | url | email | tel | boolean | image | select | number | slug

const TEL_RE = /^\+?[0-9][0-9 -]{5,19}$/;

const imageValue = z
  .object({
    media_id: z.number().int().positive().nullable().default(null),
    url: z.string().trim().max(500).default(""),
  })
  .default({ media_id: null, url: "" });

// The stored keys a field expands to: bilingual fields become _mr / _en.
export function storedKeys(field) {
  return field.bi ? [`${field.key}_mr`, `${field.key}_en`] : [field.key];
}

function requiredIf(base, required, label) {
  return required ? base.refine((v) => v !== "", `${label} is required`) : base.default("");
}

export function fieldValidator(field, isPrimary = true) {
  const required = Boolean(field.required && isPrimary);
  const { label } = field;
  switch (field.type) {
    case "boolean":
      return z.boolean({ invalid_type_error: `${label} must be true or false` }).default(field.default ?? false);
    case "number": {
      const n = z.coerce
        .number({ invalid_type_error: `${label} must be a number` })
        .int(`${label} must be a whole number`)
        .min(field.min ?? 0, `${label} must be at least ${field.min ?? 0}`)
        .max(field.max ?? 9999, `${label} must be at most ${field.max ?? 9999}`);
      return n.default(field.default ?? 0);
    }
    case "select": {
      const values = field.options.map((o) => (typeof o === "string" ? o : o.value));
      const e = z.enum(values, { errorMap: () => ({ message: `Choose a valid ${label.toLowerCase()}` }) });
      return field.default !== undefined ? e.default(field.default) : e;
    }
    case "image":
      return field.required
        ? imageValue.refine((v) => v.media_id !== null, { message: `${label} is required` })
        : imageValue;
    case "url":
      return requiredIf(optionalHttpUrl(field.max ?? 500), required, label);
    case "email":
      return requiredIf(
        cleanString(field.max ?? 160).refine(
          (v) => v === "" || z.string().email().safeParse(v).success,
          "Enter a valid email address"
        ),
        required,
        label
      );
    case "tel":
      return requiredIf(
        cleanString(field.max ?? 20).refine((v) => v === "" || TEL_RE.test(v), "Enter a valid phone number"),
        required,
        label
      );
    case "slug":
      // Empty is allowed here; the service derives a slug from field.from.
      return cleanString(field.max ?? 80)
        .transform((v) => v.toLowerCase())
        .refine((v) => v === "" || SLUG_RE.test(v), "Use lowercase letters, numbers and single hyphens only")
        .default("");
    default:
      return required ? requiredString(field.max ?? 300, label) : cleanString(field.max ?? 300).default("");
  }
}

export function buildObjectSchema(fields) {
  const shape = {};
  for (const field of fields) {
    storedKeys(field).forEach((key, i) => {
      shape[key] = fieldValidator(field, i === 0);
    });
  }
  return z.object(shape);
}
