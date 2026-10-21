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
export const ROLES = ["superadmin", "admin", "editor"];
