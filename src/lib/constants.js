// Values shared by validation and the admin UI (served via /admin/meta).

// Home-page sections a link can scroll to. These are the element ids the
// public site renders; adding one here without a matching section on the site
// would produce a dead link.
export const SECTION_TARGETS = [
  { value: "home", label: "Home (hero)" },
  { value: "about", label: "About AMRUT Peth" },
  { value: "highlights", label: "Highlights" },
  { value: "participate", label: "Participation" },
  { value: "register", label: "Registration / Contact" },
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
export const FORM_FIELD_TYPES = ["text", "textarea", "number", "select", "checkbox", "date"];
