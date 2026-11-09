type LogLevel = "info" | "warn" | "error" | "debug";

export const logger = {
  info: (message: string, meta?: Record<string, unknown>) => {
    console.info(`[INFO] ${message}`, meta ? JSON.stringify(meta) : "");
  },
  warn: (message: string, meta?: Record<string, unknown>) => {
    console.warn(`[WARN] ${message}`, meta ? JSON.stringify(meta) : "");
  },
  error: (message: string, meta?: Record<string, unknown>) => {
    console.error(`[ERROR] ${message}`, meta ? JSON.stringify(meta) : "");
  },
  debug: (message: string, meta?: Record<string, unknown>) => {
    console.debug(`[DEBUG] ${message}`, meta ? JSON.stringify(meta) : "");
  },
  child: (_meta: Record<string, unknown>) => logger,
  level: (_level: LogLevel) => logger,
};
