import type { AppsScriptHosts } from "../../adapters/secondary/apps-script/services";
import { createAppsScriptServices } from "../../adapters/secondary/apps-script/services";
import { createAuthFlow } from "../../application/google-calendar/auth";
import { createCalendarFlow } from "../../application/google-calendar/calendar";
import type { GoogleCalendarPort } from "../../ports/google-calendar";

type AddonRuntime = ReturnType<typeof createCalendarFlow> &
  Pick<GoogleCalendarPort, "webBaseUrl" | "clearAuth" | "warn" | "error" | "debugIdentityAudience" | "debugVerify">;

declare const ScriptApp: AppsScriptHosts["script"];
declare const PropertiesService: AppsScriptHosts["properties"];
declare const UrlFetchApp: AppsScriptHosts["fetcher"];
declare const CacheService: AppsScriptHosts["caches"];
declare const Utilities: AppsScriptHosts["utilities"];

export const createAddon = ({
  script,
  properties,
  fetcher,
  caches,
  utilities,
  logger,
}: AppsScriptHosts): AddonRuntime => {
  const port = createAppsScriptServices({ script, properties, fetcher, caches, utilities, logger });
  const authFlow = createAuthFlow(port);
  const calendarFlow = createCalendarFlow({ port, authFlow });

  return {
    ...calendarFlow,
    webBaseUrl: port.webBaseUrl,
    clearAuth: port.clearAuth,
    warn: port.warn,
    error: port.error,
    debugIdentityAudience: port.debugIdentityAudience,
    debugVerify: port.debugVerify,
  };
};

export const addon = (): AddonRuntime =>
  createAddon({
    script: ScriptApp,
    properties: PropertiesService,
    fetcher: UrlFetchApp,
    caches: CacheService,
    utilities: Utilities,
    logger: console,
  });
