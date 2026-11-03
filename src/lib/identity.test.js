import test from "node:test";
import assert from "node:assert/strict";
import {
  decryptAadhaar, encryptAadhaar, hashAadhaar, isValidAadhaar, maskAadhaar, normalizeUdyam, UDYAM_RE, verhoeffValid,
} from "./identity.js";
import { slotTransition } from "../modules/registrations/slots.js";
import { bookingSchema } from "../modules/registrations/registrations.schema.js";
import { definitionSchema, normalizeFields, validateAnswers } from "../modules/forms/forms.service.js";

// Appends the Verhoeff check digit to 11 digits.
export function withCheckDigit(eleven) {
  for (let d = 0; d <= 9; d += 1) if (verhoeffValid(`${eleven}${d}`)) return `${eleven}${d}`;
  throw new Error("unreachable");
}

const AADHAAR = withCheckDigit("23456789012");

test("Aadhaar: 12 digits, valid Verhoeff checksum, never starting with 0 or 1", () => {
  assert.ok(isValidAadhaar(AADHAAR));
  assert.ok(isValidAadhaar(`${AADHAAR.slice(0, 4)} ${AADHAAR.slice(4, 8)} ${AADHAAR.slice(8)}`), "spaces ignored");
  const wrongCheck = `${AADHAAR.slice(0, 11)}${(Number(AADHAAR[11]) + 1) % 10}`;
  assert.equal(isValidAadhaar(wrongCheck), false, "checksum enforced");
  assert.equal(isValidAadhaar(withCheckDigit("12345678901")), false, "leading 1 never issued");
  assert.equal(isValidAadhaar("23456789"), false);
  assert.equal(isValidAadhaar("2345678901ab"), false);
});

test("Aadhaar is encrypted with a fresh IV, decrypts back, and is masked for display", () => {
  const a = encryptAadhaar(AADHAAR);
  const b = encryptAadhaar(AADHAAR);
  assert.notEqual(a, b, "same number gives different ciphertexts");
  assert.ok(!a.includes(AADHAAR));
  assert.equal(decryptAadhaar(a), AADHAAR);
  const tampered = a.slice(0, -2) + (a.endsWith("A") ? "BB" : "AA");
  assert.throws(() => decryptAadhaar(tampered), "GCM rejects tampering");
  assert.equal(hashAadhaar(AADHAAR), hashAadhaar(`${AADHAAR.slice(0, 6)}-${AADHAAR.slice(6)}`));
  assert.equal(maskAadhaar(AADHAAR.slice(-4)), `XXXX XXXX ${AADHAAR.slice(-4)}`);
});

test("Udyam Registration Number format", () => {
  assert.ok(UDYAM_RE.test(normalizeUdyam(" udyam-mh-26-0012345 ")));
  for (const bad of ["UDYAM-MH-26-001234", "UDYAM-M1-26-0012345", "MH-26-0012345", "UDYAM-MH-2-0012345"]) {
    assert.equal(UDYAM_RE.test(normalizeUdyam(bad)), false, bad);
  }
});

test("slot transitions: holding statuses take and release stalls", () => {
  assert.equal(slotTransition("waitlisted", "pending"), "take");
  assert.equal(slotTransition("rejected", "approved"), "take");
  assert.equal(slotTransition("pending", "approved"), "none");
  assert.equal(slotTransition("approved", "rejected"), "release");
  assert.equal(slotTransition("pending", "waitlisted"), "release");
  assert.equal(slotTransition("waitlisted", "rejected"), "none");
});

const FIELDS = normalizeFields([]);
const publicSchema = bookingSchema(FIELDS);
const managerSchema = bookingSchema(FIELDS, { manager: true });
const valid = {
  event_id: 1, name: "Asha Patil", business_name: "Asha Gruh Udyog", nature_of_business: "artisan",
  product_categories: [2, "3"], aadhaar: AADHAAR, caste_category: "open", phone: "98765 43210", consent: true,
};

test("booking schema mirrors the public form rules", () => {
  const ok = publicSchema.safeParse(valid);
  assert.ok(ok.success);
  assert.equal(ok.data.phone, "9876543210");
  assert.deepEqual(ok.data.product_categories, [2, 3]);
  assert.equal(ok.data.udyam_number, "", "disabled system fields are stored empty");

  const fields = (body, schema = publicSchema) => schema.safeParse(body).error?.issues.map((i) => i.path.join(".")).sort() ?? [];
  assert.deepEqual(fields({ ...valid, aadhaar: "123412341234" }), ["aadhaar"]);
  assert.deepEqual(fields({ ...valid, aadhaar: "12341234123a" }), ["aadhaar"], "digits only");
  assert.deepEqual(fields({ ...valid, phone: "12345" }), ["phone"]);
  assert.deepEqual(fields({ ...valid, consent: false }), ["consent"]);
  assert.deepEqual(fields({ ...valid, product_categories: [] }), ["product_categories"]);
  assert.deepEqual(fields({ ...valid, nature_of_business: "Pickles" }), ["nature_of_business"], "a dropdown value");
  assert.deepEqual(fields({ ...valid, caste_category: "obc" }), ["caste_name"], "reserved categories give the caste name");
  assert.ok(publicSchema.safeParse({ ...valid, caste_category: "obc", caste_name: "Kunbi" }).success);
  assert.equal(publicSchema.parse({ ...valid, quota_type: "sponsored" }).quota_type, undefined, "the public cannot pick a quota");
  assert.ok(managerSchema.safeParse({ ...valid, quota_type: "sponsored" }).success, "managers allocate sponsored stalls");
  assert.deepEqual(fields({ ...valid, quota_type: "ews" }, managerSchema), ["quota_type"], "EWS quota needs an eligible category");

  const udyamOn = bookingSchema(normalizeFields([{ key: "udyam_number", enabled: true, required: true, label_mr: "उद्यम" }]));
  assert.deepEqual(fields(valid, udyamOn), ["udyam_number"]);
  assert.deepEqual(fields({ ...valid, udyam_number: "12345" }, udyamOn), ["udyam_number"]);
  assert.equal(udyamOn.parse({ ...valid, udyam_number: "udyam-mh-26-0012345" }).udyam_number, "UDYAM-MH-26-0012345");
});

test("form builder: definitions are validated and answers checked against them", () => {
  const def = definitionSchema.safeParse({
    title: "Stall form",
    fields: [
      { key: "stall_size", label_mr: "आकार", type: "select", required: true, options: [{ value: "small", label_mr: "लहान" }] },
      { key: "years", label_mr: "वर्षे", type: "number" },
    ],
  });
  assert.ok(def.success);
  assert.equal(definitionSchema.safeParse({ title: "x", fields: [{ key: "event_id", label_mr: "a", type: "text" }] }).success, false, "reserved key");
  assert.equal(definitionSchema.safeParse({ title: "x", fields: [{ key: "pick", label_mr: "a", type: "radio" }] }).success, false, "radio needs options");
  assert.equal(definitionSchema.safeParse({ title: "x", fields: [{ key: "pick", label_mr: "a", type: "select" }] }).success, false, "select needs options");

  assert.deepEqual(validateAnswers(def.data.fields, { stall_size: "small", years: "4", junk: 1 }), { stall_size: "small", years: 4 });
  assert.throws(() => validateAnswers(def.data.fields, {}), (err) => err.details[0].field === "extra.stall_size");
});
