import assert from "node:assert/strict";
import test from "node:test";

import {
  calendarSyncSubscriptionAction,
  resolveCalendarWebhookAddress,
  shouldRecreateCalendarSyncSubscription,
} from "../../domain/calendar-webhooks";

void test("calendar webhook address is disabled without an HTTPS base URL", () => {
  assert.equal(
    resolveCalendarWebhookAddress({
      provider: "google_calendar",
      baseUrl: null,
    }),
    null,
  );
  assert.equal(
    resolveCalendarWebhookAddress({
      provider: "google_calendar",
      baseUrl: "http://localhost:4000",
    }),
    null,
  );
  assert.equal(
    resolveCalendarWebhookAddress({
      provider: "outlook_calendar",
      baseUrl: "not a url",
    }),
    null,
  );
});

void test("calendar webhook address resolves provider-specific HTTPS callback URLs", () => {
  assert.equal(
    resolveCalendarWebhookAddress({
      provider: "google_calendar",
      baseUrl: "https://api.ready.app",
    }),
    "https://api.ready.app/v1/integrations/calendar/google_calendar/webhook",
  );
  assert.equal(
    resolveCalendarWebhookAddress({
      provider: "outlook_calendar",
      baseUrl: "https://api.ready.app/",
    }),
    "https://api.ready.app/v1/integrations/calendar/outlook_calendar/webhook",
  );
});

void test("calendar subscriptions are recreated when the stored webhook address changes", () => {
  assert.equal(
    shouldRecreateCalendarSyncSubscription({
      currentWebhookAddress: "https://api.ready.app/v1/integrations/calendar/google_calendar/webhook",
      storedWebhookAddress: "https://old-tunnel.example.com/v1/integrations/calendar/google_calendar/webhook",
    }),
    true,
  );
  assert.equal(
    shouldRecreateCalendarSyncSubscription({
      currentWebhookAddress: "https://api.ready.app/v1/integrations/calendar/google_calendar/webhook",
      storedWebhookAddress: "https://api.ready.app/v1/integrations/calendar/google_calendar/webhook",
    }),
    false,
  );
});

void test("calendar subscriptions are skipped, not retired, when webhook config is disabled", () => {
  assert.equal(
    calendarSyncSubscriptionAction({
      currentWebhookAddress: null,
      hasActiveSubscription: true,
      storedWebhookAddress: "https://api.ready.app/v1/integrations/calendar/google_calendar/webhook",
    }),
    "skip",
  );
});
