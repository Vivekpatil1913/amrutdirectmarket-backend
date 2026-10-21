import { query } from "../db/pool.js";
import { validation } from "./errors.js";

const EMPTY = { media_id: null, url: "" };

// Loads the live (not soft-deleted) media rows for the given ids.
export async function liveMedia(ids) {
  const unique = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  if (!unique.length) return new Map();
  const rows = await query(
    "SELECT id, url, alt_text FROM media_assets WHERE id = ANY($1::int[]) AND deleted_at IS NULL",
    [unique]
  );
  return new Map(rows.map((r) => [r.id, r]));
}

// Normalises the image fields of a record about to be saved: every media_id
// must point at a live media asset, and the stored url is taken from the
// library rather than trusted from the client.
export async function resolveImageRefs(data, imageKeys) {
  const ids = imageKeys.map((k) => data[k]?.media_id).filter(Boolean);
  const media = await liveMedia(ids);
  const errors = [];
  const out = { ...data };
  for (const key of imageKeys) {
    const ref = data[key] ?? EMPTY;
    if (!ref.media_id) {
      out[key] = { ...EMPTY };
      continue;
    }
    const row = media.get(ref.media_id);
    if (!row) errors.push({ field: key, message: "Selected image no longer exists in the media library" });
    else out[key] = { media_id: row.id, url: row.url };
  }
  if (errors.length) throw validation(errors);
  return out;
}

// For public output: replaces each image ref with its current url, or null if
// the media was removed since the content was published.
export function publicImages(data, imageKeys, media) {
  const out = { ...data };
  for (const key of imageKeys) {
    const row = media.get(data[key]?.media_id);
    out[key] = row ? row.url : null;
  }
  return out;
}
