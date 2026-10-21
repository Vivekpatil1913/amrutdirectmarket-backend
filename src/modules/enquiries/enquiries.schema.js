import { z } from "zod";
import { cleanString, paginationQuery, requiredString } from "../../lib/validators.js";
import { ENQUIRY_STATUSES } from "../../lib/constants.js";

// Mirrors the public form's client-side rules (RegistrationCTA.jsx).
export const enquirySchema = z.object({
  name: requiredString(100, "Name").refine((v) => v.length >= 2, "Name must contain at least 2 characters"),
  email: z.string({ required_error: "Email is required" }).trim().toLowerCase().email("Enter a valid email address").max(160),
  phone: z
    .string()
    .optional()
    .default("")
    .transform((v) => v.replace(/[\s-]/g, ""))
    .refine((v) => v === "" || /^[6-9]\d{9}$/.test(v), "Enter a valid 10-digit mobile number"),
  subject: requiredString(40, "Subject"),
  message: requiredString(2000, "Message").refine((v) => v.length >= 20, "Message must be at least 20 characters"),
  consent: z.literal(true, { errorMap: () => ({ message: "Consent is required" }) }),
  language: z.enum(["mr", "en"]).optional().default("mr"),
  // Honeypot: hidden on the site, so any value means an automated submission.
  website: z.string().max(200).optional().default(""),
});

export const enquiryUpdateSchema = z
  .object({
    status: z.enum(ENQUIRY_STATUSES).optional(),
    admin_notes: cleanString(2000).optional(),
  })
  .refine((v) => v.status !== undefined || v.admin_notes !== undefined, "Nothing to update");

export const enquiryListQuery = z.object({
  ...paginationQuery,
  status: z.union([z.enum(ENQUIRY_STATUSES), z.literal("")]).optional().default(""),
  subject: z.string().trim().max(40).optional().default(""),
  from: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal("")]).optional().default(""),
  to: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal("")]).optional().default(""),
  sort: z.enum(["created_at", "name", "status"]).optional().default("created_at"),
});
