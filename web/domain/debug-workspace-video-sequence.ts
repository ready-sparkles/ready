import type { LinearTaskReviewRun, MeetingTaskList } from "@readymeet/shared";

const LINT_NUM_N1000 = 1000;
const LINT_NUM_N2000 = 2000;
const LINT_NUM_N3000 = 3000;
const LINT_NUM_N12 = 12;
const LINT_NUM_N9000 = 9000;
const LINT_NUM_N2 = 2;
const LINT_NUM_N100 = 100;
const LINT_NUM_N3 = 3;
const LINT_NUM_N299 = 299;
const LINT_NUM_N200 = 200;
const LINT_NUM_N4 = 4;
const DEBUG_WORKSPACE_VIDEO_SEQUENCE_CONFIDENCE = 0.94;

export type DebugWorkspaceTaskSeed = {
  title: string;
  description: string;
  owner: string;
  /** @external debug workspace task seed wire field */
  belongsInLinear: boolean;
};

export type DebugLinearVideoStage =
  | "idle"
  | "reviewing"
  | "awaiting_initial"
  | "revising"
  | "merging"
  | "awaiting_merged"
  | "syncing"
  | "completed";

export const DEBUG_WORKSPACE_OWNER_IDS: Record<string, string> = {
  "Avery Quinn": "00000000-0000-4000-8000-000000005001",
  Casey: "00000000-0000-4000-8000-000000005002",
  Riley: "00000000-0000-4000-8000-000000005003",
  "Jordan Quinn": "00000000-0000-4000-8000-000000005004",
};

const MISSING_DEBUG_WORKSPACE_OWNER = "Debug workspace owner is missing.";

function requiredDebugOwnerId(name: string) {
  const ownerId = DEBUG_WORKSPACE_OWNER_IDS[name];
  if (ownerId === undefined) {
    throw new Error(MISSING_DEBUG_WORKSPACE_OWNER);
  }

  return ownerId;
}

export const DEBUG_WORKSPACE_CURRENT_USER_ID = requiredDebugOwnerId("Avery Quinn");

const FIXTURE_TIME = "2026-08-05T12:00:00.000Z";
const MEETING_BASES: Record<string, number> = {
  "product-sync": LINT_NUM_N1000,
  "mobile-review": LINT_NUM_N2000,
  planning: LINT_NUM_N3000,
};

function fixtureUuid(value: number) {
  return `00000000-0000-4000-8000-${String(value).padStart(LINT_NUM_N12, "0")}`;
}

function fixtureBase(meetingKey: string) {
  return MEETING_BASES[meetingKey] ?? LINT_NUM_N9000;
}

export function buildDebugWorkspaceTaskList(
  ...args: [meetingKey: string, seeds: readonly DebugWorkspaceTaskSeed[]]
): MeetingTaskList {
  const [meetingKey, seeds] = args;
  const base = fixtureBase(meetingKey);
  const meetingId = fixtureUuid(base + 1);
  const taskListId = fixtureUuid(base + LINT_NUM_N2);

  return {
    id: taskListId,
    meetingId,
    status: "completed",
    phase: "complete",
    error: null,
    model: "ready-product-debug",
    promptVersion: "2.2.1",
    transcriptHash: `debug-${meetingKey}`,
    taskListVersion: 1,
    items: seeds.map((seed, index) => {
      const ownerUserId = DEBUG_WORKSPACE_OWNER_IDS[seed.owner] ?? null;
      const owner = {
        userId: ownerUserId,
        name: seed.owner,
        email: null,
        confidence: "high" as const,
      };

      return {
        id: fixtureUuid(base + LINT_NUM_N100 + index),
        meetingId,
        taskListId,
        position: index,
        title: seed.title,
        description: seed.description,
        type: "task" as const,
        workKind: seed.belongsInLinear ? ("implementation" as const) : ("general" as const),
        owner,
        assignee: owner,
        dueDate: { value: null, confidence: null },
        confidence: "high" as const,
        assetIds: [],
        sourceQuotes: [
          {
            quote: seed.title,
            speaker: seed.owner,
            timestamp: null,
            segmentId: null,
          },
        ],
        sourceReason: seed.belongsInLinear
          ? "Product implementation work discussed in the meeting."
          : "A concrete next step assigned during the meeting.",
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
        externalLinks: [],
        createdAt: FIXTURE_TIME,
        updatedAt: FIXTURE_TIME,
        completedAt: null,
      };
    }),
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    completedAt: FIXTURE_TIME,
  };
}

function debugLinearReviewStatus(stage: Exclude<DebugLinearVideoStage, "idle">): LinearTaskReviewRun["status"] {
  if (stage === "awaiting_initial" || stage === "awaiting_merged") {
    return "awaiting_user";
  }
  if (stage === "merging" || stage === "revising") {
    return "revising";
  }

  return stage;
}

function debugLinearReviewSyncStatus(stage: DebugLinearVideoStage) {
  if (stage === "completed") {
    return "created" as const;
  }
  if (stage === "syncing") {
    return "syncing" as const;
  }

  return "pending" as const;
}

export function buildDebugLinearTaskReview({
  meetingKey,
  taskList,
  stage,
  mergedTitle,
  mergedDescription,
}: {
  meetingKey: string;
  taskList: MeetingTaskList;
  stage: DebugLinearVideoStage;
  mergedTitle: string;
  mergedDescription: string;
}): LinearTaskReviewRun | null {
  if (stage === "idle") {
    return null;
  }

  const base = fixtureBase(meetingKey);
  const runId = fixtureUuid(base + LINT_NUM_N3);
  const sourceTasks = taskList.items.filter((task) => task.workKind === "implementation");
  const isMerged = stage === "merging" || stage === "awaiting_merged" || stage === "syncing" || stage === "completed";
  const status = debugLinearReviewStatus(stage);
  const syncStatus = debugLinearReviewSyncStatus(stage);

  const itemSeeds =
    isMerged && sourceTasks.length >= LINT_NUM_N2
      ? [
          {
            id: fixtureUuid(base + LINT_NUM_N299),
            sourceTaskIds: sourceTasks.slice(0, LINT_NUM_N2).map((task) => task.id),
            title: mergedTitle,
            description: mergedDescription,
          },
        ]
      : sourceTasks.map((task, index) => ({
          id: fixtureUuid(base + LINT_NUM_N200 + index),
          sourceTaskIds: [task.id],
          title: task.title,
          description: task.description,
        }));

  const items =
    stage === "reviewing"
      ? []
      : itemSeeds.map((item, index) => ({
          id: item.id,
          runId,
          position: index,
          sourceTaskIds: item.sourceTaskIds,
          decision: "linear" as const,
          confidence: DEBUG_WORKSPACE_VIDEO_SEQUENCE_CONFIDENCE,
          reasoning: "Product implementation work belongs in the connected Linear workspace.",
          title: item.title,
          description: item.description,
          issueDraft: null,
          teamId: "ready-engineering",
          teamName: "Engineering",
          /** @external linear task review item wire field */
          included: true,
          syncStatus,
          syncError: null,
          duplicateIssues: [],
          targetAction: "create" as const,
          targetIssue: null,
          relationId: null,
          meetingContextSyncedAt: stage === "completed" ? FIXTURE_TIME : null,
          externalIssue:
            stage === "completed"
              ? {
                  id: "debug-linear-issue-eng-482",
                  identifier: "ENG-482",
                  title: item.title,
                  url: "https://linear.app/ready/issue/ENG-482",
                }
              : null,
          createdAt: FIXTURE_TIME,
          updatedAt: isMerged ? "2026-08-05T12:00:20.000Z" : "2026-08-05T12:00:10.000Z",
        }));

  return {
    id: runId,
    meetingId: taskList.meetingId,
    taskListId: taskList.id,
    userId: DEBUG_WORKSPACE_CURRENT_USER_ID,
    connectorId: fixtureUuid(base + LINT_NUM_N4),
    status,
    phase: stage,
    inputHash: `debug-linear-${meetingKey}`,
    model: "ready-product-debug",
    promptVersion: "linear-task-review-v2",
    error: null,
    startedAt: FIXTURE_TIME,
    completedAt: stage === "completed" ? "2026-08-05T12:01:00.000Z" : null,
    createdAt: FIXTURE_TIME,
    updatedAt: stage === "completed" ? "2026-08-05T12:01:00.000Z" : FIXTURE_TIME,
    items,
  };
}
