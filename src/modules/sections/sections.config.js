// Field definitions for every single-record page section.
//
// This is the one place a section's shape is described: the server builds its
// validation schema from it (sections.schema.js) and the admin panel renders
// its edit form from it (served by GET /admin/sections/meta). A bilingual
// field ("bi: true") is stored as <key>_mr and <key>_en; "required" applies to
// the Marathi value, which is the site's default language.
//
// Field types: text | textarea | url | email | tel | boolean | image

import { storedKeys } from "../../lib/fieldSchema.js";

export { storedKeys };

export const SECTIONS = [
  {
    key: "settings",
    title: "Site Settings & SEO",
    description: "Logo, favicon, site title, government bar, notice bar and search/social metadata.",
    fields: [
      { key: "logo", label: "Logo", type: "image", required: true, group: "Branding", hint: "Shown in the header and footer. PNG with transparent background recommended." },
      { key: "logo_alt", label: "Logo alt text", type: "text", bi: true, max: 120, group: "Branding" },
      { key: "favicon", label: "Favicon", type: "image", group: "Branding", hint: "Square PNG, at least 64×64." },
      { key: "brand_name", label: "Brand name", type: "text", bi: true, required: true, max: 60, group: "Branding" },
      { key: "brand_sub", label: "Brand sub-title", type: "text", bi: true, max: 60, group: "Branding" },
      { key: "gov_state", label: "Government bar — state", type: "text", bi: true, max: 80, group: "Government bar" },
      { key: "gov_org", label: "Government bar — organisation", type: "text", bi: true, max: 160, group: "Government bar" },
      { key: "notice_enabled", label: "Show notice in the government bar", type: "boolean", group: "Notice bar" },
      { key: "notice_text", label: "Notice text", type: "text", bi: true, max: 200, group: "Notice bar" },
      { key: "notice_short", label: "Notice short label (mobile)", type: "text", bi: true, max: 40, group: "Notice bar" },
      { key: "header_cta", label: "Header button label", type: "text", bi: true, required: true, max: 40, group: "Header" },
      { key: "site_title", label: "Browser / SEO title", type: "text", bi: true, required: true, max: 120, group: "SEO" },
      { key: "meta_description", label: "Meta description", type: "textarea", bi: true, max: 300, group: "SEO" },
      { key: "meta_keywords", label: "Meta keywords", type: "text", max: 300, group: "SEO", hint: "Comma-separated." },
      { key: "og_title", label: "Social share title", type: "text", bi: true, max: 120, group: "Social sharing" },
      { key: "og_description", label: "Social share description", type: "textarea", bi: true, max: 300, group: "Social sharing" },
      { key: "og_image", label: "Social share image", type: "image", group: "Social sharing", hint: "1200×630 recommended." },
    ],
  },
  {
    key: "contact",
    title: "Contact Details",
    description: "Phone, email, address, office hours and website shown in the header, contact panel and footer.",
    fields: [
      { key: "phone", label: "Phone (dialable)", type: "tel", required: true, max: 20, group: "Phone & email", hint: "International format, e.g. +919730151450." },
      { key: "phone_label", label: "Phone (as displayed)", type: "text", required: true, max: 30, group: "Phone & email" },
      { key: "email", label: "Email", type: "email", required: true, max: 160, group: "Phone & email" },
      { key: "address", label: "Office address", type: "textarea", bi: true, max: 300, group: "Office" },
      { key: "hours", label: "Office hours", type: "text", bi: true, max: 120, group: "Office" },
      { key: "website", label: "Official website URL", type: "url", max: 300, group: "Website" },
      { key: "website_label", label: "Website label", type: "text", max: 80, group: "Website" },
    ],
  },
  {
    key: "hero",
    title: "Hero Section",
    description: "The home-page banner: headline, description, buttons, photographs and chip.",
    fields: [
      { key: "eyebrow", label: "Eyebrow", type: "text", bi: true, max: 120, group: "Text" },
      { key: "title", label: "Title", type: "text", bi: true, required: true, max: 80, group: "Text" },
      { key: "tagline", label: "Tagline", type: "text", bi: true, max: 160, group: "Text" },
      { key: "desc", label: "Description", type: "textarea", bi: true, max: 600, group: "Text" },
      { key: "primary_cta", label: "Primary button (to Registration)", type: "text", bi: true, required: true, max: 60, group: "Buttons" },
      { key: "secondary_cta", label: "Secondary button (to About)", type: "text", bi: true, max: 60, group: "Buttons" },
      { key: "main_image", label: "Main photograph", type: "image", group: "Images" },
      { key: "main_image_alt", label: "Main photograph alt text", type: "text", bi: true, max: 200, group: "Images" },
      { key: "small_image", label: "Supporting photograph", type: "image", group: "Images" },
      { key: "small_image_alt", label: "Supporting photograph alt text", type: "text", bi: true, max: 200, group: "Images" },
      { key: "chip", label: "Photo chip text", type: "text", bi: true, max: 80, group: "Images" },
      { key: "quick_label", label: "Quick links label (screen readers)", type: "text", bi: true, max: 60, group: "Quick links" },
    ],
  },
  {
    key: "about",
    title: "About Section",
    description: "Introduction text, photograph with caption and the categories heading.",
    fields: [
      { key: "badge", label: "Badge", type: "text", bi: true, max: 60, group: "Text" },
      { key: "title", label: "Title", type: "text", bi: true, required: true, max: 160, group: "Text" },
      { key: "p1", label: "Paragraph 1", type: "textarea", bi: true, max: 800, group: "Text" },
      { key: "p2", label: "Paragraph 2", type: "textarea", bi: true, max: 800, group: "Text" },
      { key: "image", label: "Photograph", type: "image", group: "Photograph" },
      { key: "image_alt", label: "Photograph alt text", type: "text", bi: true, max: 200, group: "Photograph" },
      { key: "caption", label: "Photograph caption", type: "text", bi: true, max: 160, group: "Photograph" },
      { key: "find_title", label: "Categories heading", type: "text", bi: true, max: 80, group: "Categories" },
    ],
  },
  {
    key: "highlights",
    title: "Highlights Section",
    description: "Heading and lead line above the highlight cards.",
    fields: [
      { key: "badge", label: "Badge", type: "text", bi: true, max: 60, group: "Text" },
      { key: "title", label: "Title", type: "text", bi: true, required: true, max: 160, group: "Text" },
      { key: "lead", label: "Lead", type: "textarea", bi: true, max: 400, group: "Text" },
    ],
  },
  {
    key: "participate",
    title: "Participation Section",
    description: "Heading, lead, eligibility label, button and steps label.",
    fields: [
      { key: "badge", label: "Badge", type: "text", bi: true, max: 60, group: "Text" },
      { key: "title", label: "Title", type: "text", bi: true, required: true, max: 160, group: "Text" },
      { key: "lead", label: "Lead", type: "textarea", bi: true, max: 600, group: "Text" },
      { key: "who_label", label: "Eligibility list label (screen readers)", type: "text", bi: true, max: 80, group: "Labels" },
      { key: "cta", label: "Button label", type: "text", bi: true, required: true, max: 60, group: "Labels" },
      { key: "steps_label", label: "Steps list label (screen readers)", type: "text", bi: true, max: 80, group: "Labels" },
    ],
  },
  {
    key: "register",
    title: "Registration Section",
    description: "Enquiry form texts, success messages and the contact panel.",
    fields: [
      { key: "badge", label: "Badge", type: "text", bi: true, max: 60, group: "Heading" },
      { key: "title", label: "Title", type: "text", bi: true, required: true, max: 160, group: "Heading" },
      { key: "lead", label: "Lead", type: "textarea", bi: true, max: 400, group: "Heading" },
      { key: "label_name", label: "Name field label", type: "text", bi: true, required: true, max: 60, group: "Form labels" },
      { key: "label_email", label: "Email field label", type: "text", bi: true, required: true, max: 60, group: "Form labels" },
      { key: "label_phone", label: "Mobile field label", type: "text", bi: true, required: true, max: 60, group: "Form labels" },
      { key: "label_subject", label: "Subject field label", type: "text", bi: true, required: true, max: 60, group: "Form labels" },
      { key: "label_message", label: "Message field label", type: "text", bi: true, required: true, max: 60, group: "Form labels" },
      { key: "placeholder_name", label: "Name placeholder", type: "text", bi: true, max: 80, group: "Placeholders" },
      { key: "placeholder_email", label: "Email placeholder", type: "text", bi: true, max: 80, group: "Placeholders" },
      { key: "placeholder_phone", label: "Mobile placeholder", type: "text", bi: true, max: 80, group: "Placeholders" },
      { key: "placeholder_message", label: "Message placeholder", type: "textarea", bi: true, max: 300, group: "Placeholders" },
      { key: "select_subject", label: "Subject dropdown prompt", type: "text", bi: true, max: 60, group: "Placeholders" },
      { key: "hint", label: "Message hint", type: "text", bi: true, max: 160, group: "Placeholders" },
      { key: "consent", label: "Consent text", type: "textarea", bi: true, required: true, max: 300, group: "Submission" },
      { key: "submit", label: "Submit button", type: "text", bi: true, required: true, max: 40, group: "Submission" },
      { key: "thanks", label: "Thank-you heading", type: "text", bi: true, max: 120, group: "Submission", hint: "{name} is replaced with the visitor's name." },
      { key: "recorded", label: "Confirmation message", type: "textarea", bi: true, max: 300, group: "Submission" },
      { key: "again", label: "Send-another button", type: "text", bi: true, max: 60, group: "Submission" },
      { key: "contact_title", label: "Contact panel title", type: "text", bi: true, max: 80, group: "Contact panel" },
      { key: "contact_desc", label: "Contact panel description", type: "textarea", bi: true, max: 300, group: "Contact panel" },
    ],
  },
  {
    key: "footer",
    title: "Footer",
    description: "Quote, description, column headings and copyright line.",
    fields: [
      { key: "quote", label: "Quote", type: "textarea", bi: true, max: 300, group: "Text" },
      { key: "about", label: "About text", type: "textarea", bi: true, max: 400, group: "Text" },
      { key: "explore_heading", label: "Menu column heading", type: "text", bi: true, max: 60, group: "Column headings" },
      { key: "official_heading", label: "Official links column heading", type: "text", bi: true, max: 60, group: "Column headings" },
      { key: "contact_heading", label: "Contact column heading", type: "text", bi: true, max: 60, group: "Column headings" },
      { key: "copyright", label: "Copyright line", type: "text", bi: true, max: 200, group: "Copyright", hint: "The current year is added automatically." },
    ],
  },
];

export const SECTION_KEYS = SECTIONS.map((s) => s.key);
export const sectionByKey = (key) => SECTIONS.find((s) => s.key === key) ?? null;

export function imageFields(section) {
  return section.fields.filter((f) => f.type === "image").map((f) => f.key);
}
