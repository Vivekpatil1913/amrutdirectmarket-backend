import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.path} not found` },
  });
}

// Every error leaves as { error: { code, message, details? } }. Unexpected
// errors are logged with the request id and never echo internals to clients.
export function errorHandler(err, req, res, _next) {
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      error: { code: "FILE_TOO_LARGE", message: "Uploaded file exceeds the allowed size." },
    });
  }
  if (typeof err?.code === "string" && err.code.startsWith("LIMIT_")) {
    return res.status(422).json({ error: { code: "VALIDATION_ERROR", message: "Invalid file upload." } });
  }
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Malformed JSON body." } });
  }
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large." } });
  }

  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }

  // PostgreSQL unique violation that slipped past an explicit check (race).
  if (err?.code === "23505") {
    return res.status(409).json({
      error: { code: "CONFLICT", message: "A record with these values already exists." },
    });
  }
  // Invalid text representation, e.g. a malformed id reaching an integer column.
  if (err?.code === "22P02") {
    return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Invalid request value." } });
  }

  logger.error("Unhandled error", {
    requestId: req.id,
    method: req.method,
    path: req.originalUrl,
    message: err?.message,
    stack: err?.stack,
  });
  return res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred. Please try again." },
  });
}
