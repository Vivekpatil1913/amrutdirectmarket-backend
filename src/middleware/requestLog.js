import crypto from "crypto";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

// Tags each request with an id (echoed as X-Request-Id for support/debugging)
// and logs method, path, status and duration when the response finishes.
export function requestLog(req, res, next) {
  req.id = crypto.randomUUID();
  res.setHeader("X-Request-Id", req.id);
  if (!env.logRequests) return next();
  const started = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms`);
  });
  next();
}
