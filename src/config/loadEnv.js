import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

// The backend root, independent of the directory the process was started from.
export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Loads backend/.env into process.env without overriding variables that are
// already set, so real environment variables always win over the file.
export function loadEnvFile(file = resolve(ROOT_DIR, ".env")) {
  let text;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return; // no .env — rely on the real environment
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}
