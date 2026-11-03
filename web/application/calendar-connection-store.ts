import type { CalendarProvider } from "@readymeet/shared";
import { z } from "zod";

const calendarConnectionMemory = new Map<string, CalendarProvider[]>();
const CALENDAR_CONNECTION_EVENT = "readymeet:calendar-connection";
const CALENDAR_CONNECTION_KEY_PREFIX = "readymeet:calendar-connection:v1:";

const cachedCalendarConnectionSchema = z.object({
  providers: z.array(z.enum(["google_calendar", "outlook_calendar"])).optional(),
});

const calendarConnectionEventDetailSchema = z.object({
  userId: z.string(),
  providers: z.array(z.enum(["google_calendar", "outlook_calendar"])).optional(),
});

function storageKey(userId: string): string {
  return `${CALENDAR_CONNECTION_KEY_PREFIX}${userId}`;
}

function isCalendarProvider(value: unknown): value is CalendarProvider {
  return value === "google_calendar" || value === "outlook_calendar";
}

function normalizeProviders(providers: CalendarProvider[]): CalendarProvider[] {
  return Array.from(new Set(providers.filter(isCalendarProvider)));
}

export function getCachedCalendarConnectionProviders(userId?: string | null): CalendarProvider[] | null {
  if (userId === undefined || userId === null || userId.length === 0) {
    return null;
  }

  const memoryValue = calendarConnectionMemory.get(userId);
  if (memoryValue !== undefined) {
    return memoryValue;
  }

  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    if (raw === null || raw.length === 0) {
      return null;
    }
    const parsed = cachedCalendarConnectionSchema.parse(JSON.parse(raw));
    const providers = Array.isArray(parsed.providers) ? normalizeProviders(parsed.providers) : [];
    calendarConnectionMemory.set(userId, providers);

    return providers;
  } catch (error: unknown) {
    void error;

    return null;
  }
}

type SetCachedCalendarConnectionProvidersArgs =
  | [userId: string | null | undefined, providers: CalendarProvider[]]
  | [{ userId: string | null | undefined; providers: CalendarProvider[] }];

export function setCachedCalendarConnectionProviders(...args: SetCachedCalendarConnectionProvidersArgs): void {
  const { userId, providers } = args.length === 1 ? args[0] : { userId: args[0], providers: args[1] };
  if (userId === undefined || userId === null || userId.length === 0) {
    return;
  }

  const normalizedProviders = normalizeProviders(providers);
  calendarConnectionMemory.set(userId, normalizedProviders);

  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      storageKey(userId),
      JSON.stringify({
        providers: normalizedProviders,
        updatedAt: Date.now(),
      }),
    );
  } catch (error: unknown) {
    void error;
    // Memory cache still covers the current tab.
  }

  window.dispatchEvent(
    new CustomEvent(CALENDAR_CONNECTION_EVENT, {
      detail: { userId, providers: normalizedProviders },
    }),
  );
}

type SubscribeToCalendarConnectionProvidersArgs =
  | [userId: string | null | undefined, callback: (providers: CalendarProvider[] | null) => void]
  | [
      {
        userId: string | null | undefined;
        callback: (providers: CalendarProvider[] | null) => void;
      },
    ];

export function subscribeToCalendarConnectionProviders(
  ...args: SubscribeToCalendarConnectionProvidersArgs
): () => void {
  const { userId, callback } = args.length === 1 ? args[0] : { userId: args[0], callback: args[1] };
  if (userId === undefined || userId === null || userId.length === 0 || typeof window === "undefined") {
    return () => {};
  }
  const resolvedUserId = userId;

  function handleLocalEvent(event: Event): void {
    if (!(event instanceof CustomEvent)) {
      return;
    }
    const parsedDetail = calendarConnectionEventDetailSchema.safeParse(event.detail);
    if (!parsedDetail.success || parsedDetail.data.userId !== resolvedUserId) {
      return;
    }
    const providers =
      parsedDetail.data.providers !== undefined
        ? normalizeProviders(parsedDetail.data.providers.filter(isCalendarProvider))
        : null;
    callback(providers);
  }

  function handleStorageEvent(event: StorageEvent): void {
    if (event.key !== storageKey(resolvedUserId)) {
      return;
    }
    callback(getCachedCalendarConnectionProviders(resolvedUserId));
  }

  window.addEventListener(CALENDAR_CONNECTION_EVENT, handleLocalEvent);
  window.addEventListener("storage", handleStorageEvent);

  return () => {
    window.removeEventListener(CALENDAR_CONNECTION_EVENT, handleLocalEvent);
    window.removeEventListener("storage", handleStorageEvent);
  };
}
