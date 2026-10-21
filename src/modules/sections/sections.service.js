import { query, queryOne, transaction } from "../../db/pool.js";
import { notFound, parseOrThrow } from "../../lib/errors.js";
import { liveMedia, publicImages, resolveImageRefs } from "../../lib/media.js";
import { audit } from "../../lib/audit.js";
import { SECTIONS, imageFields, sectionByKey, storedKeys } from "./sections.config.js";
import { sectionSchema } from "./sections.schema.js";

const isEmpty = (o) => !o || Object.keys(o).length === 0;

export function getSectionDef(key) {
  const def = sectionByKey(key);
  if (!def) throw notFound("Section");
  return def;
}

// Fills keys a stored record lacks (e.g. a field added after it was saved)
// with the schema defaults, so editors always receive a complete object.
function complete(def, value = {}) {
  const out = {};
  for (const field of def.fields) {
    for (const key of storedKeys(field)) {
      const fallback = field.type === "boolean" ? false : field.type === "image" ? { media_id: null, url: "" } : "";
      out[key] = value?.[key] ?? fallback;
    }
  }
  return out;
}

function shape(def, row) {
  const draft = complete(def, row?.draft);
  const published = complete(def, row?.published);
  return {
    key: def.key,
    title: def.title,
    description: def.description,
    draft,
    published,
    is_published: Boolean(row?.published_at),
    published_at: row?.published_at ?? null,
    updated_at: row?.updated_at ?? null,
    updated_by_name: row?.updated_by_name ?? null,
    has_unpublished_changes: Boolean(row) && JSON.stringify(row.draft) !== JSON.stringify(row.published),
  };
}

const SELECT = `SELECT s.*, u.name AS updated_by_name
                  FROM page_sections s LEFT JOIN admin_users u ON u.id = s.updated_by`;

export async function listSections() {
  const rows = await query(SELECT);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return SECTIONS.map((def) => {
    const s = shape(def, byKey.get(def.key));
    return {
      key: s.key,
      title: s.title,
      description: s.description,
      fields: def.fields.length,
      is_published: s.is_published,
      has_unpublished_changes: s.has_unpublished_changes,
      published_at: s.published_at,
      updated_at: s.updated_at,
      updated_by_name: s.updated_by_name,
    };
  });
}

export async function getSection(key) {
  const def = getSectionDef(key);
  const row = await queryOne(`${SELECT} WHERE s.key = $1`, [key]);
  return shape(def, row);
}

export async function saveDraft(key, body, user, { publish = false } = {}) {
  const def = getSectionDef(key);
  const data = await resolveImageRefs(parseOrThrow(sectionSchema(def), body), imageFields(def));
  const json = JSON.stringify(data);
  await transaction(async (tx) => {
    await tx.query(
      `INSERT INTO page_sections (key, draft, published, updated_by)
       VALUES ($1, $2::jsonb, '{}'::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET draft = EXCLUDED.draft, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
      [key, json, user.id]
    );
    if (publish) {
      await tx.query(
        `UPDATE page_sections SET published = draft, published_at = NOW(), updated_at = NOW(), updated_by = $2
          WHERE key = $1`,
        [key, user.id]
      );
    }
    await audit(user, publish ? "publish" : "update", "section", key,
      `${publish ? "Saved and published" : "Saved draft of"} ${def.title}`, tx);
  });
  return getSection(key);
}

export async function publishSection(key, user) {
  const def = getSectionDef(key);
  const row = await queryOne("SELECT draft FROM page_sections WHERE key = $1", [key]);
  if (!row || isEmpty(row.draft)) throw notFound("Section draft");
  // Re-validate at publish time: rules may have tightened and images may have
  // been removed since the draft was saved. Nothing invalid reaches the site.
  const data = await resolveImageRefs(parseOrThrow(sectionSchema(def), row.draft), imageFields(def));
  await transaction(async (tx) => {
    await tx.query(
      `UPDATE page_sections SET draft = $2::jsonb, published = $2::jsonb, published_at = NOW(),
              updated_at = NOW(), updated_by = $3 WHERE key = $1`,
      [key, JSON.stringify(data), user.id]
    );
    await audit(user, "publish", "section", key, `Published ${def.title}`, tx);
  });
  return getSection(key);
}

export async function discardDraft(key, user) {
  const def = getSectionDef(key);
  const row = await queryOne("SELECT published_at FROM page_sections WHERE key = $1", [key]);
  if (!row?.published_at) throw notFound("Published version");
  await query(
    "UPDATE page_sections SET draft = published, updated_at = NOW(), updated_by = $2 WHERE key = $1",
    [key, user.id]
  );
  await audit(user, "discard", "section", key, `Discarded draft of ${def.title}`);
  return getSection(key);
}

// Published content of every section, image refs replaced by live URLs.
// Sections never published are omitted.
export async function publicSections() {
  const rows = await query("SELECT key, published FROM page_sections WHERE published_at IS NOT NULL");
  const ids = [];
  for (const row of rows) {
    const def = sectionByKey(row.key);
    if (!def) continue;
    for (const k of imageFields(def)) ids.push(row.published?.[k]?.media_id);
  }
  const media = await liveMedia(ids);
  const out = {};
  for (const row of rows) {
    const def = sectionByKey(row.key);
    if (!def || isEmpty(row.published)) continue;
    out[row.key] = publicImages(complete(def, row.published), imageFields(def), media);
  }
  return out;
}
