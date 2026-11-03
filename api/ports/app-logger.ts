export type AppLogger = {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  fatal(...args: unknown[]): void;
  child(bindings: Record<string, unknown>): AppLogger;
};
