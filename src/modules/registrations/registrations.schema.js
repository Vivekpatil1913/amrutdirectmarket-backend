import { z } from "zod";
import { cleanString, mobileNumber, paginationQuery, requiredString } from "../../lib/validators.js";
import {
  CASTE_CATEGORIES, EWS_ELIGIBLE_CASTES, PUBLIC_QUOTA_TYPES, QUOTA_TYPES, REGISTRATION_STATUSES,
} from "../../lib/constants.js";
import { isValidAadhaar, normalizeAadhaar, normalizeUdyam, UDYAM_RE } from "../../lib/identity.js";

// Mirrors the public form's client-side rules (frontend src/lib/vendorRules.js).

const minLen = (schema, n, label) => schema.refine((v) => v.length >= n, `${label} must contain at least ${n} characters`);

const applicant = {
  event_id: z.coerce.number({ invalid_type_error: "Choose an event" }).int().positive("Choose an event"),
  name: minLen(requiredString(100, "Name"), 2, "Name"),
  business_name: minLen(requiredString(150, "Business name"), 2, "Business name"),
  nature_of_business: minLen(requiredString(200, "Nature of business"), 3, "Nature of business"),
  category_id: z.coerce.number({ invalid_type_error: "Choose a product category" }).int().positive("Choose a product category"),
  aadhaar: z
    .string({ required_error: "Aadhaar number is required" })
    .transform(normalizeAadhaar)
    .refine(isValidAadhaar, "Enter a valid 12-digit Aadhaar number"),
  udyam_number: z
    .string({ required_error: "Udyam Registration Number is required" })
    .transform(normalizeUdyam)
    .refine((v) => UDYAM_RE.test(v), "Enter a valid Udyam Registration Number (UDYAM-XX-00-0000000)"),
  caste_category: z.enum(CASTE_CATEGORIES, { errorMap: () => ({ message: "Choose a category" }) }),
  phone: mobileNumber,
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(160)
    .optional()
    .default("")
    .refine((v) => v === "" || z.string().email().safeParse(v).success, "Enter a valid email address"),
  extra: z.record(z.any()).optional().default({}),
  language: z.enum(["mr", "en"]).optional().default("mr"),
};

const ewsRule = (schema) =>
  schema.refine((v) => v.quota_type !== "ews" || EWS_ELIGIBLE_CASTES.includes(v.caste_category), {
    message: "The EWS / reserved quota is for applicants from EWS or reserved categories",
    path: ["quota_type"],
  });

export const publicRegistrationSchema = ewsRule(
  z.object({
    ...applicant,
    quota_type: z.enum(PUBLIC_QUOTA_TYPES, { errorMap: () => ({ message: "Choose a stall type" }) }),
    otp_token: z.string({ required_error: "Verify your mobile number with the OTP first" }).min(1, "Verify your mobile number with the OTP first"),
    consent: z.literal(true, { errorMap: () => ({ message: "Consent is required" }) }),
    // Honeypot: hidden on the site, so any value means an automated submission.
    website: z.string().max(200).optional().default(""),
  })
);

// A manager entering an application (e.g. a sponsor's nominee for a
// sponsored stall) — no OTP; the manager has verified the applicant.
export const managerRegistrationSchema = ewsRule(
  z.object({
    ...applicant,
    quota_type: z.enum(QUOTA_TYPES, { errorMap: () => ({ message: "Choose a stall type" }) }),
    dm_notes: cleanString(2000).optional().default(""),
  })
);

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
