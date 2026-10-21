import { mkdirSync } from "fs";
import path from "path";
import { env } from "./config/env.js";
import { checkConnection, pool } from "./db/pool.js";
import { createApp } from "./app.js";
import { MEDIA_SUBDIR } from "./middleware/upload.js";
import { logger } from "./lib/logger.js";

mkdirSync(path.join(env.upload.dir, MEDIA_SUBDIR), { recursive: true });

async function main() {
  await checkConnection();
  const app = createApp();
  const server = app.listen(env.port, () => {
    logger.info(`AMRUT Peth CMS API listening on http://localhost:${env.port}/api/v1 (${env.nodeEnv})`);
  });
  server.on("error", (err) => {
    logger.error(err.code === "EADDRINUSE" ? `Port ${env.port} is already in use — set PORT in .env` : err.message);
    process.exit(1);
  });

  const shutdown = (signal) => {
    logger.info(`${signal} received, shutting down`);
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error("Fatal startup error", { message: err.message });
  process.exit(1);
});
