import multer from "multer";
import crypto from "crypto";
import path from "path";
import { open, unlink } from "fs/promises";
import { env } from "../config/env.js";
import { AppError } from "../lib/errors.js";

export const MEDIA_SUBDIR = "media";
export const ALLOWED_IMAGE_TYPES = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

// Filenames are random and the extension comes from the validated MIME type,
// never from the visitor's filename, so "shell.php.jpg" style names and path
// tricks cannot reach the disk.
function safeFilename(mime) {
  return `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ALLOWED_IMAGE_TYPES[mime] ?? ".bin"}`;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, path.join(env.upload.dir, MEDIA_SUBDIR)),
  filename: (_req, file, cb) => cb(null, safeFilename(file.mimetype)),
});

function imageFilter(_req, file, cb) {
  if (ALLOWED_IMAGE_TYPES[file.mimetype]) return cb(null, true);
  cb(new AppError("VALIDATION_ERROR", "Only JPEG, PNG, WebP or GIF images are allowed", 422));
}

export const uploadImage = multer({
  storage,
  limits: { fileSize: env.upload.maxMb * 1024 * 1024, files: 1, fields: 10 },
  fileFilter: imageFilter,
});

// Reads the first bytes of the stored file and returns the image type they
// actually encode, or "" — the declared MIME type alone is client-controlled.
export async function detectImageType(filePath) {
  const handle = await open(filePath, "r");
  try {
    const bytes = Buffer.alloc(12);
    const { bytesRead } = await handle.read(bytes, 0, 12, 0);
    const b = bytes.subarray(0, bytesRead);
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
    if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
    if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
    if (b.length >= 6 && ["GIF87a", "GIF89a"].includes(b.toString("ascii", 0, 6))) return "image/gif";
    return "";
  } finally {
    await handle.close();
  }
}

// Rejects (and removes) an uploaded file whose content is not the image type
// it claimed to be.
export async function assertImageContent(file) {
  const detected = await detectImageType(file.path);
  if (!detected || detected !== file.mimetype) {
    await unlink(file.path).catch(() => {});
    throw new AppError("VALIDATION_ERROR", "Uploaded file content is not a supported image", 422);
  }
}
