import assert from "node:assert/strict";
import test from "node:test";

import { meetingInviteSuggestionsResponseSchema, sendMeetingInvitesRequestSchema } from "../domain/meeting-invites";

void test("meeting invite requests normalize and deduplicate recipient emails", () => {
  assert.deepEqual(
    sendMeetingInvitesRequestSchema.parse({
      emails: [" Personbr@example.com ", "personbr@example.com", "person@example.com"],
    }),
    {
      emails: ["personbr@example.com", "person@example.com"],
    },
  );
});

void test("meeting invite suggestions identify providers that need renewed contact consent", () => {
  const response = meetingInviteSuggestionsResponseSchema.parse({
    suggestions: [
      {
        email: "person@example.com",
        displayName: "Person Example",
        avatarUrl: null,
        provider: "google_calendar",
      },
    ],
    connectedProviders: ["google_calendar"],
    reconnectRequiredProviders: ["outlook_calendar"],
  });

  assert.equal(response.suggestions[0]?.displayName, "Person Example");
  assert.deepEqual(response.reconnectRequiredProviders, ["outlook_calendar"]);
});
