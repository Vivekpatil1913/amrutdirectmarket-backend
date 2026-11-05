import { z } from "zod";
import { cleanString, mobileNumber, paginationQuery, requiredString } from "../../lib/validators.js";
import {
  CASTE_CATEGORIES, EWS_ELIGIBLE_CASTES, QUOTA_TYPES, REGISTRATION_STATUSES,
} from "../../lib/constants.js";
import { isValidAadhaar, normalizeAadhaar, normalizeUdyam, UDYAM_RE } from "../../lib/identity.js";

// The stall booking schema is built from the form definition (form builder),
// so labels, the nature-of-business options and the optional system fields
// follow what the super admin configured. Mirrors the public form's
// client-side rules (frontend src/lib/vendorRules.js).

const minLen = (schema, n, label) => schema.refine((v) => v.length >= n, `${label} must contain at least ${n} characters`);

// Caste categories whose applicants must give their caste name and upload a
// caste certificate (and who may take an EWS / reserved stall).
export const isReserved = (caste) => EWS_ELIGIBLE_CASTES.includes(caste);

const blank = (v) => (v === undefined || v === null ? "" : v);

// An optional system field: validated when enabled and filled in, required
// when the form builder marks it so, ignored (stored empty) when disabled.
function configurable(field, validator, label) {
  if (!field?.enabled) return z.any().transform(() => "");
  const optional = z.preprocess(blank, z.union([z.literal(""), validator]));
  return field.required
    ? z.preprocess(blank, z.string().min(1, `${label} is required`).pipe(validator))
    : optional;
}

const udyam = z
  .string()
  .transform(normalizeUdyam)
  .refine((v) => UDYAM_RE.test(v), "Enter a valid Udyam Registration Number (UDYAM-XX-00-0000000)");
const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(160)
  .refine((v) => z.string().email().safeParse(v).success, "Enter a valid email address");

export function bookingSchema(fields, { manager = false } = {}) {
  const f = Object.fromEntries(fields.map((x) => [x.key, x]));
  const label = (key, fallback) => f[key]?.label_en || f[key]?.label_mr || fallback;
  const natures = (f.nature_of_business?.options ?? []).map((o) => o.value);

  const shape = {
    event_id: z.coerce.number({ invalid_type_error: "Choose an event" }).int().positive("Choose an event"),
    name: minLen(requiredString(100, label("name", "Name")), 2, label("name", "Name")),
    business_name: minLen(requiredString(150, label("business_name", "Business name")), 2, label("business_name", "Business name")),
    nature_of_business: z.enum(natures.length ? natures : ["other"], {
      errorMap: () => ({ message: `Choose the ${label("nature_of_business", "nature of business").toLowerCase()}` }),
    }),
    product_categories: z
      .array(z.coerce.number().int().positive(), { invalid_type_error: "Choose at least one product category" })
      .min(1, "Choose at least one product category")
      .max(20, "Choose at most 20 product categories")
      .transform((ids) => [...new Set(ids)]),
    aadhaar: z
      .string({ required_error: "Aadhaar number is required", invalid_type_error: "Aadhaar number must contain digits only" })
      .refine((v) => /^[\d\s]*$/.test(v), "Aadhaar number must contain digits only")
      .transform(normalizeAadhaar)
      .refine(isValidAadhaar, "Enter a valid 12-digit Aadhaar number"),
    caste_category: z.enum(CASTE_CATEGORIES, { errorMap: () => ({ message: "Choose a caste category" }) }),
    caste_name: z.preprocess(blank, cleanString(100)),
    phone: configurable(f.phone, mobileNumber, label("phone", "Mobile number")),
    email: configurable(f.email, email, label("email", "Email")),
    udyam_number: configurable(f.udyam_number, udyam, label("udyam_number", "Udyam Registration Number")),
    extra: z.record(z.any()).optional().default({}),
    language: z.enum(["mr", "en"]).optional().default("mr"),
  };

  const withRules = (schema) =>
    schema
      .refine((v) => !isReserved(v.caste_category) || v.caste_name.length >= 2, {
        message: `${label("caste_name", "Caste name")} is required for the EWS / reserved categories`,
        path: ["caste_name"],
      })
      .refine((v) => v.quota_type !== "ews" || isReserved(v.caste_category), {
        message: "The EWS / reserved quota is for applicants from EWS or reserved categories",
        path: ["quota_type"],
      });

  if (manager) {
    // A manager entering a booking (e.g. a sponsor's nominee for a sponsored
    // stall) chooses the quota; documents are checked offline.
    return withRules(
      z.object({
        ...shape,
        quota_type: z.enum(QUOTA_TYPES, { errorMap: () => ({ message: "Choose a stall type" }) }),
        dm_notes: cleanString(2000).optional().default(""),
      })
    );
  }
  return withRules(
    z.object({
      ...shape,
      // No quota_type: public bookings get theirs automatically (see the service).
      consent: z.literal(true, { errorMap: () => ({ message: "Please confirm the declaration" }) }),
      // Honeypot: hidden on the site, so any value means an automated submission.
      website: z.string().max(200).optional().default(""),
    })
  );
}

export const registrationUpdateSchema = z
  .object({
    status: z.enum(REGISTRATION_STATUSES).optional(),
    dm_notes: cleanString(2000).optional(),
    udyam_verified: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Nothing to update");

export const registrationListQuery = z.object({
  ...paginationQuery,
  event: z.union([z.coerce.number().int().positive(), z.literal("")]).optional().default(""),
  district: z.union([z.coerce.number().int().positive(), z.literal("")]).optional().default(""),
  status: z.union([z.enum(REGISTRATION_STATUSES), z.literal("")]).optional().default(""),
  quota: z.union([z.enum(QUOTA_TYPES), z.literal("")]).optional().default(""),
  sort: z.enum(["created_at", "name", "status", "business_name"]).optional().default("created_at"),
});
