// Values shared by validation and the admin UI (served via /admin/meta).

// Home-page sections a link can scroll to. These are the element ids the
// public site renders; adding one here without a matching section on the site
// would produce a dead link.
export const SECTION_TARGETS = [
  { value: "home", label: "Home (success stories)" },
  { value: "highlights", label: "Event highlights" },
  { value: "events", label: "Upcoming events" },
  { value: "participate", label: "Participation" },
  { value: "map", label: "District map" },
];
export const SECTION_TARGET_VALUES = SECTION_TARGETS.map((t) => t.value);

// Icons available in the public site's inline icon set (src/components/ui/Icon.jsx).
export const ICONS = [
  "info", "sparkle", "store", "phone", "mail", "mapPin", "users", "userPlus",
  "building", "trend", "send", "clock", "globe", "checkCircle", "facebook",
  "instagram", "external", "arrowRight",
];

export const PUBLISH_STATUSES = ["published", "draft"];
export const ENQUIRY_STATUSES = ["new", "reviewed", "actioned", "archived"];
export const ROLES = ["superadmin", "admin", "editor", "district_manager"];

// ── Thet Bajar Peth ──────────────────────────────────────────────────────────
export const EVENT_STATUSES = ["draft", "published", "cancelled"];
// District managers' events reach the public site only once a super admin
// approves them.
export const EVENT_APPROVAL_STATUSES = ["pending", "approved", "rejected"];
// Stall inventory buckets per event. Sponsored stalls are allocated by the
// district manager; the public form books general or EWS stalls only.
export const QUOTA_TYPES = ["general", "ews", "sponsored"];
export const PUBLIC_QUOTA_TYPES = ["general", "ews"];
export const CASTE_CATEGORIES = ["open", "ews", "obc", "sc", "st", "vjnt", "sbc"];
// Caste categories eligible for the reserved (EWS) stall quota.
export const EWS_ELIGIBLE_CASTES = ["ews", "obc", "sc", "st", "vjnt", "sbc"];
export const REGISTRATION_STATUSES = ["pending", "approved", "rejected", "waitlisted", "cancelled"];
// Statuses that occupy a stall slot.
export const SLOT_HOLDING_STATUSES = ["pending", "approved"];
export const SPONSOR_STATUSES = ["draft", "pending", "approved", "rejected"];
export const SPONSOR_TIERS = ["title", "gold", "silver", "partner"];
// Field types of the form builder. "select" is a dropdown; "checkbox" with
// options is a checkbox group, without options a single tick box.
export const FORM_FIELD_TYPES = [
  "text", "email", "phone", "number", "pan", "date", "textarea", "select", "radio", "checkbox", "file", "password", "url",
];
// Uploads accepted by file fields of the public booking form.
export const BOOKING_FILE_TYPES = { "application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png" };
