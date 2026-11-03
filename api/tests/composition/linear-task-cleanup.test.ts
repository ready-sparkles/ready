import type { BugReportIssueDraft, MeetingTask } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import { findNativeTaskIdsMovedToLinear } from "../../application/linear-task-cleanup";

const meetingId = "11111111-1111-4111-8111-111111111111";
const taskListId = "22222222-2222-4222-8222-222222222222";
const segmentId = "33333333-3333-4333-8333-333333333333";
const SSO_EVIDENCE_LINE = 4;
const SAFARI_EVIDENCE_LINE = 3;
const EMPTY_TASK_PERSON = {
  userId: null,
  name: null,
  email: null,
  confidence: null,
} as const;

const DEFAULT_SOURCE_QUOTE = {
  quote: "The CSV export is breaking for accounts with over 10,000 rows.",
  speaker: "Personbr",
  timestamp: null,
  segmentId,
} as const;

const DEFAULT_TASK_FIELDS = {
  meetingId,
  taskListId,
  position: 0,
  description: null,
  type: "task" as const,
  workKind: "bug_or_issue" as const,
  owner: EMPTY_TASK_PERSON,
  assignee: EMPTY_TASK_PERSON,
  dueDate: { value: null, confidence: null },
  confidence: "high" as const,
  assetIds: [] as string[],
  sourceQuotes: [DEFAULT_SOURCE_QUOTE],
  sourceReason: "The transcript describes actionable product work.",
  status: "open" as const,
  revision: 1,
  createdFrom: "meeting_transcript" as const,
  origin: "final" as const,
  statusSource: "model" as const,
  statusActorUserId: null,
  statusChangedAt: null,
  actionConfirmableAt: null,
  detectedAt: null,
  firstRenderedAt: null,
  externalLinks: [] as MeetingTask["externalLinks"],
  createdAt: "2026-04-28T18:00:00.000Z",
  updatedAt: "2026-04-28T18:00:00.000Z",
  completedAt: null,
};

function task(input: Partial<MeetingTask> & Pick<MeetingTask, "id" | "title">): MeetingTask {
  return {
    ...DEFAULT_TASK_FIELDS,
    ...input,
    assignee: input.assignee ?? input.owner ?? DEFAULT_TASK_FIELDS.assignee,
  };
}

function issue(input: Partial<BugReportIssueDraft> & Pick<BugReportIssueDraft, "title">): BugReportIssueDraft {
  return {
    title: input.title,
    description:
      input.description ??
      "CSV export crashes for large accounts because the worker loads the whole dataset into memory.",
    severity: input.severity ?? "high",
    impact: input.impact ?? "Large account exports fail.",
    reproductionContext: input.reproductionContext ?? null,
    evidence: input.evidence ?? ["The CSV export is breaking for accounts with over 10,000 rows."],
    evidenceSpans: input.evidenceSpans ?? [
      {
        evidenceId: "csv-export-evidence",
        excerpt: "The CSV export is breaking for accounts with over 10,000 rows.",
        lineStart: 1,
        lineEnd: 1,
        segmentIds: [segmentId],
        verificationStatus: "verified",
      },
    ],
    scopeReason: input.scopeReason,
    confidence: input.confidence ?? "high",
    duplicateIssueIds: input.duplicateIssueIds ?? [],
    teamId: input.teamId ?? "team-1",
    teamName: input.teamName ?? "Engineering",
    labels: input.labels ?? ["bug"],
  };
}

void test("matching bug task is moved when Linear issue shares evidence and scope", () => {
  const moved = findNativeTaskIdsMovedToLinear({
    tasks: [
      task({
        id: "44444444-4444-4444-8444-444444444444",
        title: "Fix CSV export for large accounts",
      }),
    ],
    issueDrafts: [
      issue({
        title: "CSV export crashes for large accounts",
      }),
    ],
  });

  assert.deepEqual(moved, ["44444444-4444-4444-8444-444444444444"]);
});

void test("generic follow-up with loose bug context is preserved", () => {
  const moved = findNativeTaskIdsMovedToLinear({
    tasks: [
      task({
        id: "55555555-5555-4555-8555-555555555555",
        title: "Sync with Personax about ownership",
        description: "Check who owns the SSO fix.",
        workKind: "general",
        sourceQuotes: [
          {
            quote: "Personaj, can you sync with Personax on this and figure out who is owning it?",
            speaker: "Personbr",
            timestamp: null,
            segmentId: "66666666-6666-4666-8666-666666666666",
          },
        ],
      }),
    ],
    issueDrafts: [
      issue({
        title: "SSO login times out intermittently",
        description: "SSO login times out because of a race condition in auth.",
        evidence: ["The login flow is timing out for users with SSO configured."],
        evidenceSpans: [
          {
            evidenceId: "sso-evidence",
            excerpt: "The login flow is timing out for users with SSO configured.",
            lineStart: SSO_EVIDENCE_LINE,
            lineEnd: SSO_EVIDENCE_LINE,
            segmentIds: ["77777777-7777-4777-8777-777777777777"],
            verificationStatus: "verified",
          },
        ],
      }),
    ],
  });

  assert.deepEqual(moved, []);
});

void test("dismissed tasks are preserved even when they match", () => {
  const moved = findNativeTaskIdsMovedToLinear({
    tasks: [
      task({
        id: "88888888-8888-4888-8888-888888888888",
        title: "Fix CSV export for large accounts",
        status: "dismissed",
      }),
    ],
    issueDrafts: [issue({ title: "CSV export crashes for large accounts" })],
  });

  assert.deepEqual(moved, []);
});

void test("multiple Linear issues move only their matching native tasks", () => {
  const safariSegmentId = "99999999-9999-4999-8999-999999999999";
  const moved = findNativeTaskIdsMovedToLinear({
    tasks: [
      task({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        title: "Fix CSV export for large accounts",
      }),
      task({
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        title: "Pin chart library for Safari 15",
        sourceQuotes: [
          {
            quote: "Users on Safari are reporting the dashboard charts are not rendering at all.",
            speaker: "Personbr",
            timestamp: null,
            segmentId: safariSegmentId,
          },
        ],
      }),
      task({
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        title: "Draft support rotation proposal",
        workKind: "documentation",
        sourceQuotes: [
          {
            quote: "Personbp, can you draft a proposal and we will review it next week?",
            speaker: "Personbr",
            timestamp: null,
            segmentId: null,
          },
        ],
      }),
    ],
    issueDrafts: [
      issue({ title: "CSV export crashes for large accounts" }),
      issue({
        title: "Dashboard charts do not render on Safari 15",
        evidence: ["Users on Safari are reporting the dashboard charts are not rendering at all."],
        evidenceSpans: [
          {
            evidenceId: "safari-evidence",
            excerpt: "Users on Safari are reporting the dashboard charts are not rendering at all.",
            lineStart: SAFARI_EVIDENCE_LINE,
            lineEnd: SAFARI_EVIDENCE_LINE,
            segmentIds: [safariSegmentId],
            verificationStatus: "verified",
          },
        ],
      }),
    ],
  });

  assert.deepEqual(moved, ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]);
});
