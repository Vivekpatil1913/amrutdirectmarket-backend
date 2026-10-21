import { ICONS, SECTION_TARGETS } from "../../lib/constants.js";

// Every repeatable list on the website is a "collection": an ordered table of
// records that can be drafted, published, soft-deleted and restored.
//
// `fields` are the editable columns (same spec format as page sections — the
// admin form is rendered from them). display_order and status are added to
// every collection automatically. `search` lists the columns the admin search
// box matches, `filters` the extra columns that can be filtered on, `unique`
// the business keys that must be unique among live rows.

const iconOptions = ICONS.map((value) => ({ value, label: value }));

export const COLLECTIONS = {
  "nav-items": {
    table: "nav_items",
    entity: "Navigation item",
    publicKey: "navItems",
    titleField: "label_en",
    fields: [
      { key: "label", label: "Label", type: "text", bi: true, required: true, max: 60 },
      { key: "section", label: "Target section", type: "select", options: SECTION_TARGETS, required: true },
      { key: "show_in_header", label: "Show in header menu", type: "boolean", default: true },
      { key: "show_in_footer", label: "Show in footer menu", type: "boolean", default: true },
    ],
    search: ["label_mr", "label_en"],
    filters: ["section"],
  },
  "hero-facts": {
    table: "hero_facts",
    entity: "Hero fact",
    publicKey: "heroFacts",
    titleField: "label_en",
    fields: [
      { key: "label", label: "Label", type: "text", bi: true, required: true, max: 60 },
      { key: "value", label: "Value", type: "text", bi: true, required: true, max: 60 },
    ],
    search: ["label_mr", "label_en", "value_mr", "value_en"],
    filters: [],
  },
  "quick-links": {
    table: "quick_links",
    entity: "Quick link",
    publicKey: "quickLinks",
    titleField: "title_en",
    fields: [
      { key: "title", label: "Title", type: "text", bi: true, required: true, max: 80 },
      { key: "desc", label: "Description", type: "text", bi: true, max: 160 },
      { key: "icon", label: "Icon", type: "select", options: iconOptions, default: "info" },
      { key: "section", label: "Target section", type: "select", options: SECTION_TARGETS, required: true },
    ],
    search: ["title_mr", "title_en", "desc_mr", "desc_en"],
    filters: ["section"],
  },
  categories: {
    table: "categories",
    entity: "Category",
    publicKey: "categories",
    titleField: "name_en",
    fields: [
      { key: "name", label: "Name", type: "text", bi: true, required: true, max: 80 },
      { key: "slug", label: "Slug", type: "slug", max: 80, from: "name_en", hint: "Left empty, it is generated from the English name." },
      { key: "description", label: "Description", type: "textarea", bi: true, max: 400 },
    ],
    search: ["name_mr", "name_en", "slug"],
    filters: [],
    unique: [{ column: "slug", message: "Another category already uses this slug" }],
  },
  highlights: {
    table: "highlights",
    entity: "Highlight",
    publicKey: "highlights",
    titleField: "title_en",
    fields: [
      { key: "title", label: "Title", type: "text", bi: true, required: true, max: 120 },
      { key: "desc", label: "Description", type: "textarea", bi: true, max: 400 },
      { key: "icon", label: "Icon", type: "select", options: iconOptions, default: "sparkle" },
    ],
    search: ["title_mr", "title_en", "desc_mr", "desc_en"],
    filters: [],
  },
  "eligibility-groups": {
    table: "eligibility_groups",
    entity: "Eligibility group",
    publicKey: "eligibilityGroups",
    titleField: "name_en",
    fields: [{ key: "name", label: "Name", type: "text", bi: true, required: true, max: 80 }],
    search: ["name_mr", "name_en"],
    filters: [],
  },
  "participation-steps": {
    table: "participation_steps",
    entity: "Participation step",
    publicKey: "participationSteps",
    titleField: "title_en",
    fields: [
      { key: "title", label: "Title", type: "text", bi: true, required: true, max: 120 },
      { key: "desc", label: "Description", type: "textarea", bi: true, max: 400 },
      { key: "icon", label: "Icon", type: "select", options: iconOptions, default: "send" },
    ],
    search: ["title_mr", "title_en", "desc_mr", "desc_en"],
    filters: [],
  },
  "enquiry-subjects": {
    table: "enquiry_subjects",
    entity: "Enquiry subject",
    publicKey: "enquirySubjects",
    titleField: "label_en",
    fields: [
      { key: "label", label: "Label", type: "text", bi: true, required: true, max: 80 },
      { key: "code", label: "Code", type: "slug", max: 40, from: "label_en", hint: "Stored with each enquiry. Left empty, it is generated from the English label." },
    ],
    search: ["label_mr", "label_en", "code"],
    filters: [],
    unique: [{ column: "code", message: "Another subject already uses this code" }],
  },
  "social-links": {
    table: "social_links",
    entity: "Official / social link",
    publicKey: "socialLinks",
    titleField: "label",
    fields: [
      { key: "label", label: "Label", type: "text", required: true, max: 80 },
      { key: "url", label: "URL", type: "url", required: true, max: 500 },
      { key: "icon", label: "Icon", type: "select", options: iconOptions, default: "globe" },
    ],
    search: ["label", "url"],
    filters: [],
  },
};

export const COLLECTION_NAMES = Object.keys(COLLECTIONS);

// Fields every collection has, appended to its own.
export const COMMON_FIELDS = [
  { key: "display_order", label: "Display order", type: "number", min: 0, max: 9999, default: 0, hint: "Lower numbers appear first." },
  {
    key: "status",
    label: "Status",
    type: "select",
    options: [
      { value: "published", label: "Published" },
      { value: "draft", label: "Draft" },
    ],
    default: "published",
  },
];
