import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

// The backend root, independent of the directory the process was started from.
export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Files read for the current NODE_ENV, highest priority first. In production
// .env.production (committed, no secrets) is overlaid by .env.production.local
// (server only, gitignored) which holds PGPASSWORD and JWT_SECRET.
function envFiles() {
  if (process.env.NODE_ENV === "production") {
    return [".env.production.local", ".env.production"];
  }
  return [".env"];
}

// Loads the env file(s) into process.env without overriding variables that are
// already set, so real environment variables always win over the files.
export function loadEnvFile(file) {
  if (file === undefined) {
    for (const name of envFiles()) readEnvFile(resolve(ROOT_DIR, name));
    return;
  }
  readEnvFile(file);
}

function readEnvFile(file) {
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
