import type { CalendarProvider } from "@readymeet/shared";

const GOOGLE_CALENDAR_WEBHOOK_PATH = "/v1/integrations/calendar/google_calendar/webhook";
const OUTLOOK_CALENDAR_WEBHOOK_PATH = "/v1/integrations/calendar/outlook_calendar/webhook";

function calendarWebhookPath(provider: CalendarProvider): string {
  return provider === "google_calendar" ? GOOGLE_CALENDAR_WEBHOOK_PATH : OUTLOOK_CALENDAR_WEBHOOK_PATH;
}

export function resolveCalendarWebhookAddress(input: {
  provider: CalendarProvider;
  baseUrl?: string | null;
}): string | null {
  const baseUrl = input.baseUrl?.trim() ?? "";
  if (baseUrl.length === 0) {
    return null;
  }

  try {
    const url = new URL(calendarWebhookPath(input.provider), baseUrl);

    return url.protocol === "https:" ? url.toString() : null;
  } catch (error) {
    if (error instanceof Error) {
      return null;
    }
    throw error;
  }
}

export function shouldRecreateCalendarSyncSubscription(input: {
  currentWebhookAddress: string;
  storedWebhookAddress?: string | null;
}): boolean {
  return input.storedWebhookAddress !== input.currentWebhookAddress;
}

type CalendarSyncSubscriptionAction = "skip" | "create" | "recreate" | "reuse";

export function calendarSyncSubscriptionAction(input: {
  currentWebhookAddress: string | null;
  hasActiveSubscription: boolean;
  storedWebhookAddress?: string | null;
}): CalendarSyncSubscriptionAction {
  if (input.currentWebhookAddress === null || input.currentWebhookAddress.length === 0) {
    return "skip";
  }
  if (!input.hasActiveSubscription) {
    return "create";
  }

  return shouldRecreateCalendarSyncSubscription({
    currentWebhookAddress: input.currentWebhookAddress,
    storedWebhookAddress: input.storedWebhookAddress,
  })
    ? "recreate"
    : "reuse";
}
