import type { Meeting } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import {
  getPastMeetingCardSubtitle,
  getPastMeetingPeriodNavigation,
  groupPastMeetings,
  resolvePastMeetingSelection,
} from "../../domain/past-meetings";

function meeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    title: "Design review",
    roomName: "design-review",
    createdByUserId: "33333333-3333-4333-8333-333333333333",
    kind: "standard",
    status: "ended",
    isConfidential: false,
    createdAt: "2026-05-28T12:00:00.000Z",
    startedAt: "2026-05-28T12:00:00.000Z",
    endedAt: "2026-05-28T13:00:00.000Z",
    participantNames: ["Personbr", "Personaz"],
    participants: [
      {
        userId: "44444444-4444-4444-8444-444444444444",
        displayName: "Personbr",
        avatarUrl: null,
      },
    ],
    ...overrides,
  };
}

void test("past meetings group into current and older non-empty periods in newest-first order", () => {
  const groups = groupPastMeetings(
    [
      meeting({
        id: "11111111-1111-4111-8111-111111111111",
        title: "Today",
        startedAt: "2026-05-28T12:00:00.000Z",
      }),
      meeting({
        id: "11111111-1111-4111-8111-222222222222",
        title: "Yesterday",
        startedAt: "2026-05-27T12:00:00.000Z",
      }),
      meeting({
        id: "11111111-1111-4111-8111-333333333333",
        title: "This past week",
        startedAt: "2026-05-26T12:00:00.000Z",
      }),
      meeting({
        id: "11111111-1111-4111-8111-444444444444",
        title: "This past month",
        startedAt: "2026-05-10T12:00:00.000Z",
      }),
      meeting({
        id: "11111111-1111-4111-8111-555555555555",
        title: "April",
        startedAt: "2026-04-18T12:00:00.000Z",
      }),
      meeting({
        id: "11111111-1111-4111-8111-666666666666",
        title: "Older",
        startedAt: "2026-03-12T12:00:00.000Z",
      }),
    ],
    new Date("2026-05-28T18:00:00.000Z"),
  );

  assert.deepEqual(
    groups.map((group) => group.label),
    ["Today", "Yesterday", "This past week", "This past month", "April", "March"],
  );
});

void test("past meetings skip empty current periods", () => {
  const groups = groupPastMeetings(
    [
      meeting({
        id: "11111111-1111-4111-8111-111111111111",
        title: "Yesterday",
        startedAt: "2026-05-27T12:00:00.000Z",
      }),
      meeting({
        id: "11111111-1111-4111-8111-222222222222",
        title: "This past month",
        startedAt: "2026-05-10T12:00:00.000Z",
      }),
    ],
    new Date("2026-05-28T18:00:00.000Z"),
  );

  assert.deepEqual(
    groups.map((group) => group.label),
    ["Yesterday", "This past month"],
  );
});

void test("past meeting card subtitle uses start time and note preview for today", () => {
  assert.deepEqual(
    getPastMeetingCardSubtitle(
      meeting({
        startedAt: "2026-05-28T11:30:00.000",
        endedAt: "2026-05-28T13:00:00.000",
        notePreview: "Personaz wants a clearer onboarding handoff.",
      }),
      new Date("2026-05-28T18:00:00.000"),
    ),
    {
      kind: "recent",
      label: "11:30 AM",
      notePreview: "Personaz wants a clearer onboarding handoff.",
    },
  );
});

void test("past meeting card subtitle uses weekday and note preview for this week", () => {
  assert.deepEqual(
    getPastMeetingCardSubtitle(
      meeting({
        startedAt: "2026-05-26T11:30:00.000",
        endedAt: "2026-05-26T13:00:00.000",
        notePreview: "This week gets a weekday label.",
      }),
      new Date("2026-05-28T18:00:00.000"),
    ),
    {
      kind: "recent",
      label: "Tuesday",
      notePreview: "This week gets a weekday label.",
    },
  );
});

void test("past meeting card subtitle uses numeric date and note preview for month and older groups", () => {
  assert.deepEqual(
    getPastMeetingCardSubtitle(
      meeting({
        startedAt: "2026-05-10T11:30:00.000",
        endedAt: "2026-05-10T13:00:00.000",
        notePreview: "This stays out of older period cards.",
      }),
      new Date("2026-05-28T18:00:00.000"),
    ),
    {
      kind: "recent",
      label: "5/10/26",
      notePreview: "This stays out of older period cards.",
    },
  );
});

void test("past period navigation moves older and bridges from newest period to upcoming", () => {
  const groups = [
    { label: "Today", meetings: [meeting({ id: "11111111-1111-4111-8111-111111111111" })] },
    { label: "Yesterday", meetings: [meeting({ id: "11111111-1111-4111-8111-222222222222" })] },
  ];

  assert.deepEqual(getPastMeetingPeriodNavigation(groups, 0), {
    olderGroupIndex: 1,
    newerGroupIndex: null,
    newerRoute: "/workspace?view=upcoming",
  });
  assert.deepEqual(getPastMeetingPeriodNavigation(groups, 1), {
    olderGroupIndex: null,
    newerGroupIndex: 0,
    newerRoute: null,
  });
});

void test("past meeting selection follows selected meeting group when available", () => {
  const groups = [
    { label: "Today", meetings: [meeting({ id: "11111111-1111-4111-8111-111111111111" })] },
    { label: "Yesterday", meetings: [meeting({ id: "11111111-1111-4111-8111-222222222222" })] },
  ];

  const selection = resolvePastMeetingSelection({
    groups,
    selectedMeetingId: "11111111-1111-4111-8111-222222222222",
    preferredGroupIndex: 0,
  });

  assert.equal(selection.groupIndex, 1);
  assert.equal(selection.meetingId, "11111111-1111-4111-8111-222222222222");
});

void test("past meeting selection preserves deep-linked meetings hidden from the visible list", () => {
  const groups = [
    { label: "Today", meetings: [meeting({ id: "11111111-1111-4111-8111-111111111111" })] },
    { label: "Yesterday", meetings: [meeting({ id: "11111111-1111-4111-8111-222222222222" })] },
  ];

  const selection = resolvePastMeetingSelection({
    groups,
    selectedMeetingId: "11111111-1111-4111-8111-999999999999",
    preferredGroupIndex: 1,
  });

  assert.equal(selection.groupIndex, 1);
  assert.equal(selection.meeting, null);
  assert.equal(selection.meetingId, "11111111-1111-4111-8111-999999999999");
});

void test("past meeting selection falls back to first meeting in the preferred period when nothing is selected", () => {
  const groups = [
    { label: "Today", meetings: [meeting({ id: "11111111-1111-4111-8111-111111111111" })] },
    { label: "Yesterday", meetings: [meeting({ id: "11111111-1111-4111-8111-222222222222" })] },
  ];

  const selection = resolvePastMeetingSelection({
    groups,
    selectedMeetingId: null,
    preferredGroupIndex: 1,
  });

  assert.equal(selection.groupIndex, 1);
  assert.equal(selection.meetingId, "11111111-1111-4111-8111-222222222222");
});
