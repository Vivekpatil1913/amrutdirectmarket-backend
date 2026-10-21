// Minimal structured logger: one line per event, JSON context appended. Kept
// dependency-free; swap for pino/winston if log shipping is added later.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL] ?? (process.env.NODE_ENV === "test" ? LEVELS.warn : LEVELS.info);

function write(level, message, context) {
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  const extra = context && Object.keys(context).length ? ` ${JSON.stringify(context)}` : "";
  (level === "error" || level === "warn" ? console.error : console.log)(line + extra);
}

export const logger = {
  debug: (m, c) => write("debug", m, c),
  info: (m, c) => write("info", m, c),
  warn: (m, c) => write("warn", m, c),
  error: (m, c) => write("error", m, c),
};
