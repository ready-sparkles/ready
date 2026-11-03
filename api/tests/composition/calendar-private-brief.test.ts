import type { NormalizedCalendarEvent } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMeetingBriefPrivateContext,
  generateMeetingPrivateBrief,
  type MeetingPrivateBriefRunner,
  parseMeetingPrivateBriefOutput,
} from "../../application/calendar-private-brief";

function event(overrides: Partial<NormalizedCalendarEvent> = {}): NormalizedCalendarEvent {
  return {
    id: "google_calendar:primary:event-1",
    provider: "google_calendar",
    providerEventId: "event-1",
    calendarId: "primary",
    title: "Acme onboarding rollout",
    start: "2026-05-09T19:00:00.000Z",
    end: "2026-05-09T20:00:00.000Z",
    timezone: "UTC",
    location: null,
    organizer: null,
    attendees: [],
    isPrivate: false,
    isCancelled: false,
    isAllDay: false,
    joinUrl: null,
    sourceUrl: null,
    ...overrides,
  };
}

const participants = [
  {
    key: "attendee:personqe",
    name: null,
    email: "personqe@acme.com",
    emailDomain: "acme.com",
  },
];

void test("private brief context includes exact participant email threads and identity hints", () => {
  const context = buildMeetingBriefPrivateContext({
    event: event(),
    participants,
    companyDomain: "acme.com",
    emailCandidates: [
      {
        threadId: "thread-1",
        subject: "Implementation details",
        summary: "Personqe confirmed the onboarding rollout scope.",
        snippet: "The rollout scope is confirmed.",
        lastMessageAt: "2026-05-08T10:00:00.000Z",
        participants: [
          {
            email: "Personqe Personqn <personqe@acme.com>",
            normalizedEmail: "personqe@acme.com",
            displayName: "Personqe Personqn",
            domain: "acme.com",
          },
        ],
      },
    ],
    pastMeetingCandidates: [],
  });

  assert.equal(context.relatedEmailThreads.length, 1);
  assert.equal(context.relatedEmailThreads[0]?.matchStrength, "strong");
  assert.deepEqual(context.identityHints, [
    {
      participantKey: "attendee:personqe",
      email: "personqe@acme.com",
      displayName: "Personqe Personqn",
      confidence: "high",
      reason: "Exact participant email matched a display name from email history.",
    },
  ]);
});

void test("private brief context excludes domain-only threads without topic overlap", () => {
  const context = buildMeetingBriefPrivateContext({
    event: event(),
    participants,
    companyDomain: "acme.com",
    emailCandidates: [
      {
        threadId: "thread-2",
        subject: "Lunch schedule",
        summary: "Someone at Acme mentioned lunch.",
        snippet: "Lunch next week.",
        lastMessageAt: "2026-05-08T10:00:00.000Z",
        participants: [
          {
            email: "ops@acme.com",
            normalizedEmail: "ops@acme.com",
            displayName: "Acme Ops",
            domain: "acme.com",
          },
        ],
      },
    ],
    pastMeetingCandidates: [],
  });

  assert.equal(context.relatedEmailThreads.length, 0);
});

void test("private brief context uses exact email matches as identity hints without unrelated thread context", () => {
  const context = buildMeetingBriefPrivateContext({
    event: event({ title: "Demo w/ Personqe" }),
    participants,
    companyDomain: "acme.com",
    emailCandidates: [
      {
        threadId: "thread-identity-only",
        subject: "Dentist appointment",
        summary: "Personqe Personqn emailed about a dentist appointment.",
        snippet: null,
        lastMessageAt: "2026-05-08T10:00:00.000Z",
        participants: [
          {
            email: "Personqe Personqn <personqe@acme.com>",
            normalizedEmail: "personqe@acme.com",
            displayName: "Personqe Personqn",
            domain: "acme.com",
          },
        ],
      },
    ],
    pastMeetingCandidates: [],
  });

  assert.equal(context.relatedEmailThreads.length, 0);
  assert.deepEqual(context.identityHints, [
    {
      participantKey: "attendee:personqe",
      email: "personqe@acme.com",
      displayName: "Personqe Personqn",
      confidence: "high",
      reason: "Exact participant email matched a display name from email history.",
    },
  ]);
});

void test("private brief context includes only exact personal event email overlap", () => {
  const context = buildMeetingBriefPrivateContext({
    event: event({ title: "Personqz Birthday Dinner" }),
    participants: [
      {
        key: "organizer:personqk",
        name: "Personqk",
        email: "personqk@examplecorp.test",
        emailDomain: "examplecorp.test",
      },
    ],
    companyDomain: null,
    emailCandidates: [
      {
        threadId: "thread-bday",
        subject: "Personqz Birthday Dinner",
        summary: "Personqk Personql is inviting you to a Personqz Birthday Dinner.",
        snippet: null,
        lastMessageAt: "2026-04-16T18:14:19.000Z",
        participants: [
          {
            email: "Personqk Personql <personqk@examplecorp.test>",
            normalizedEmail: "personqk@examplecorp.test",
            displayName: "Personqk Personql",
            domain: "examplecorp.test",
          },
        ],
      },
      {
        threadId: "thread-reminder",
        subject: "Book club reminder",
        summary: "Personqk Personql emailed about Book club reminder.",
        snippet: null,
        lastMessageAt: "2026-04-22T21:12:14.000Z",
        participants: [
          {
            email: "Personqk Personql <personqk@examplecorp.test>",
            normalizedEmail: "personqk@examplecorp.test",
            displayName: "Personqk Personql",
            domain: "examplecorp.test",
          },
        ],
      },
    ],
    pastMeetingCandidates: [],
  });

  assert.deepEqual(
    context.relatedEmailThreads.map((thread) => thread.threadId),
    ["thread-bday"],
  );
  assert.deepEqual(context.identityHints, [
    {
      participantKey: "organizer:personqk",
      email: "personqk@examplecorp.test",
      displayName: "Personqk Personql",
      confidence: "high",
      reason: "Exact participant email matched a display name from email history.",
    },
  ]);
});

void test("private brief context includes past meetings only with anchor and topic overlap", () => {
  const context = buildMeetingBriefPrivateContext({
    event: event(),
    participants,
    companyDomain: "acme.com",
    emailCandidates: [],
    pastMeetingCandidates: [
      {
        meetingId: "meeting-1",
        title: "Acme onboarding rollout planning",
        endedAt: "2026-05-01T10:00:00.000Z",
        summary: "The team agreed Personqe would send the final rollout list.",
        participants: [{ email: "personqe@acme.com", displayName: "Personqe Personqn" }],
      },
      {
        meetingId: "meeting-2",
        title: "Weekly sync",
        endedAt: "2026-05-02T10:00:00.000Z",
        summary: "A general note with Acme.",
        participants: [{ email: "ops@acme.com", displayName: "Acme Ops" }],
      },
    ],
  });

  assert.deepEqual(
    context.relatedPastMeetings.map((meeting) => meeting.meetingId),
    ["meeting-1"],
  );
});

void test("private brief generator sends summaries and snippets without raw bodies", async () => {
  const captured = { userMessage: "" };
  const runner: MeetingPrivateBriefRunner = {
    async generate(input) {
      captured.userMessage = input.userMessage;

      return JSON.stringify({
        bullets: [
          {
            label: "Open loop",
            point: "Personqe still needs to send the final rollout list.",
            evidenceKind: "email",
            relevance: "This is directly tied to the onboarding rollout meeting.",
          },
        ],
      });
    },
  };

  const brief = await generateMeetingPrivateBrief({
    event: event(),
    context: {
      relatedEmailThreads: [
        {
          threadId: "thread-1",
          subject: "Implementation details",
          summary: "Personqe confirmed the onboarding rollout scope.",
          snippet: "The rollout scope is confirmed.",
          lastMessageAt: "2026-05-08T10:00:00.000Z",
          participants: [{ email: "personqe@acme.com", displayName: "Personqe Personqn", domain: "acme.com" }],
          matchStrength: "strong",
          matchReason: "Exact participant email match: personqe@acme.com.",
        },
      ],
      relatedPastMeetings: [],
      identityHints: [],
    },
    runner,
    model: "test-model",
  });

  assert.deepEqual(brief.bullets, ["Open loop: Personqe still needs to send the final rollout list."]);
  assert.match(captured.userMessage, /summary/);
  assert.match(captured.userMessage, /snippet/);
  assert.match(captured.userMessage, /meeting_context/);
  assert.doesNotMatch(captured.userMessage, /body_clean|bodyHtml|raw/i);
});

void test("private brief parser normalizes model JSON into UI bullets", () => {
  const parsed = parseMeetingPrivateBriefOutput(
    '```json\n{"bullets":[{"label":"Recent email","point":"Personrc sent the invoice PDF on 2026-02-24 and mentioned February 2026 payment timing.","evidenceKind":"email","relevance":"The meeting is about payment."}]}\n```',
  );
  assert.deepEqual(parsed, {
    status: "completed",
    bullets: ["Recent email: Personrc sent the invoice PDF on 2/24/2026 and mentioned 2/2026 payment timing."],
  });
});
