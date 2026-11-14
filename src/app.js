import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import path from "path";
import { env } from "./config/env.js";
import { attachUser } from "./middleware/auth.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import { requestLog } from "./middleware/requestLog.js";
import { MEDIA_SUBDIR } from "./middleware/upload.js";
import { buildRouter } from "./routes/index.js";
import { AppError } from "./lib/errors.js";

export function createApp() {
  const app = express();

  // Every rate limit is counted per client address, so req.ip must be the
  // visitor's, not nginx's or the load balancer's (see env.http.trustProxy).
  app.set("trust proxy", env.http.trustProxy);
  app.disable("x-powered-by");

  app.use(requestLog);
  app.use(
    helmet({
      contentSecurityPolicy: false, // JSON API; the SPA host sets its own CSP
      crossOriginResourcePolicy: { policy: "cross-origin" }, // images are embedded by the site
    })
  );

  // Only the configured site/admin origins may call the API from a browser.
  // Requests without an Origin header (curl, server-to-server, same-origin) pass.
  app.use(
    cors({
      origin(origin, cb) {
        if (!origin || env.cors.origins.includes(origin)) return cb(null, true);
        cb(new AppError("CORS_FORBIDDEN", "Origin not allowed", 403));
      },
      credentials: true,
    })
  );

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));
  app.use(cookieParser());

  // Uploaded media: only the media folder, no directory listing or dotfiles,
  // and nosniff (from helmet) so files are never interpreted as another type.
  app.use(
    `/uploads/${MEDIA_SUBDIR}`,
    express.static(path.join(env.upload.dir, MEDIA_SUBDIR), {
      dotfiles: "deny",
      index: false,
      maxAge: "7d",
      immutable: true,
    })
  );

  app.use(attachUser);
  app.use(
    "/api",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: env.isTest ? 100000 : env.http.rateLimit,
      standardHeaders: true,
      legacyHeaders: false,
      // Signing in has its own guard, which counts wrong passwords only.
      skip: (req) => req.method === "POST" && req.path === "/v1/auth/login",
      // Signed-in staff each get their own budget, so colleagues behind one
      // office connection never share one (nor with the public site's traffic).
      keyGenerator: (req) => (req.user ? `user:${req.user.id}` : `ip:${req.ip}`),
      message: { error: { code: "RATE_LIMITED", message: "Too many requests. Please slow down." } },
    })
  );
  app.use("/api/v1", buildRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
