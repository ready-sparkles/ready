// Complete configuration and provider wiring before evaluating route modules.
await import("./composition/env");
await import("./composition/server");

export {};
