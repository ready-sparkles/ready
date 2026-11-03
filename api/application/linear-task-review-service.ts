import type { RepositoryPort } from "@readymeet/db/ports/repository";
import {
  type AiWorkflowJobView,
  LINEAR_TASK_REVIEW_PROMPT_VERSION,
  type LinearTaskReviewCandidate,
  linearTaskReviewClassificationResponseSchema,
  type LinearTaskReviewDuplicateIssue,
  type LinearTaskReviewItem,
  type LinearTaskReviewRun,
  type LinearTaskReviewTaskInput,
  type LinearTaskReviewTeam,
  type MeetingTask,
} from "@readymeet/shared";
import { createHash, randomUUID } from "node:crypto";

import { apiEnv } from "../ports/api-env";
import { triggerLinearTaskReview, triggerLinearTaskReviewRevision } from "../ports/gate-assistant-client";
import { repositories } from "../ports/repository-runtime";

import {
  type AgentToolExecutionContext,
  type AgentToolUser,
  confirmAgentTool,
  executeAgentTool,
  prepareAgentTool,
} from "./agent-tool-broker";
import { resolveMeetingNotesAccess } from "./meeting-notes-access";
import { registerRequestWorkflowHandler, runAiWorkflowInRequest } from "./request-ai-workflow";

const TASK_CONTEXT_QUOTE_RADIUS_BEFORE = 3;
const TASK_CONTEXT_QUOTE_RADIUS_AFTER = 4;
const TASK_CONTEXT_QUOTE_LIMIT = 20;

const LINEAR_AGENT_CONTEXT_UTTERANCE_MAX_LENGTH = 160;
const LINEAR_REVISION_IDENTIFIER_LOOKBACK_CHARS = 100;
const LINEAR_DUPLICATE_ISSUES_LIST_LIMIT = 5;
const LINEAR_GROUNDING_MIN_TOKEN_LENGTH = 3;
const LINEAR_GROUNDING_OVERLAP_MIN = 2;
const LINEAR_ISSUE_DRAFT_PROBLEM_MAX_LENGTH = 3000;
const LINEAR_ISSUE_DRAFT_FALLBACK_EVIDENCE_LIMIT = 5;
const LINEAR_ISSUE_DRAFT_EVIDENCE_LIMIT = 12;
const LINEAR_ISSUE_DRAFT_REPRODUCTION_STEPS_LIMIT = 10;
const LINEAR_DUPLICATE_SEARCH_TERM_MIN_LENGTH = 5;
const LINEAR_DUPLICATE_SEARCH_TERM_MAX_LENGTH = 80;
const LINEAR_DUPLICATE_SEARCH_TERMS_LIMIT = 3;
const LINEAR_DUPLICATE_GROUNDING_MAX_CANDIDATE_TOKENS = 8;
const LINEAR_DUPLICATE_GROUNDING_REQUIRED_OVERLAP_CAP = 3;
const LINEAR_DUPLICATE_RANKED_RESULTS_LIMIT = 3;
const LINEAR_DUPLICATE_SHARED_TOKEN_PREVIEW_LIMIT = 3;
const LINEAR_WORKFLOW_MAX_ATTEMPTS = 2;

const LINEAR_TASK_REVIEW_MESSAGES = {
  linearIsNotConnected: "Linear is not connected",
  noLinearTeamsAvailable: "No Linear teams are available for this connection",
  noLinearTeamAvailable: "No Linear team is available",
  reviewOwnerMissing: "Linear task review owner no longer exists",
  reviewRunNotFound: "Linear task review run was not found",
  meetingNotesLocked: "Meeting notes are locked",
  tasksChangedBeforeReview: "Tasks changed before Linear review completed",
  chooseCanonicalLinearIssue: "Choose the canonical Linear issue",
  linearDuplicateRelationMissing: "Linear duplicate relation returned no relation",
  tasksChangedAfterConfirmation: "Ready tasks changed after confirmation; the updated work was kept in Ready",
  linearIssueSyncFailed: "Linear issue sync failed",
  linearReviewSyncFailed: "Could not sync the Linear review",
  linearTaskReviewFailed: "Linear task review failed",
  linearTaskReviewNotFound: "Linear task review not found",
  tasksChangedBeforeRevision: "Tasks changed before the review was revised",
  linearTaskReviewNotReadyForChanges: "Linear task review is not ready for changes",
  linearTaskReviewItemNotFound: "Linear task review item not found",
  chooseSuggestedLinearIssue: "Choose one of the suggested Linear issues",
  tasksChangedBeforeIssueCreation: "Tasks changed before the Linear issues were created",
  chooseExistingLinearIssueToLink: "Choose the existing Linear issue to link",
  linearIssueCreationReturnedNoIssue: "Linear issue creation returned no issue",
  linearIssueStateNotPersisted: "Linear issue state was not persisted",
  linkedScreenCaptureUnavailable: "A linked screen capture is no longer available",
  couldNotReviseLinearReview: "Could not revise the Linear review",
  linearTaskReviewCompleted: "Linear task review completed",
} as const;

const LINEAR_MERGE_CANDIDATE_PAIR_COUNT = 2;
const LINEAR_MERGE_CANDIDATE_TITLE_MAX_LENGTH = LINEAR_AGENT_CONTEXT_UTTERANCE_MAX_LENGTH;
const LINEAR_MERGE_CANDIDATE_TITLE_ELLIPSIS_RESERVE = 4;
const LINEAR_MERGE_CANDIDATE_TITLE_TRUNCATED_LENGTH =
  LINEAR_MERGE_CANDIDATE_TITLE_MAX_LENGTH - LINEAR_MERGE_CANDIDATE_TITLE_ELLIPSIS_RESERVE;

type LinearTaskReviewExternalIssue = NonNullable<LinearTaskReviewItem["externalIssue"]>;

type LinearTaskReviewRevisionTargetPreference = {
  mode: "use_existing" | "create_new" | "automatic";
  identifiers: string[];
};

type LinearTaskReviewRunView = NonNullable<Awaited<ReturnType<RepositoryPort["getLinearTaskReviewById"]>>>;

type LoggerLike = {
  info(...args: [bindings: Record<string, unknown>, message: string]): void;
  warn(...args: [bindings: Record<string, unknown>, message: string]): void;
  error(...args: [bindings: Record<string, unknown>, message: string]): void;
};

type MeetingTranscriptSegment = {
  id: string;
  speakerName: string;
  content: string;
  startedAt: Date;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function activeTasks(tasks: MeetingTask[]): MeetingTask[] {
  return tasks.filter((task) => task.status === "open");
}

function linearTaskLinkedMeetingAssetIds(input: {
  tasks: Pick<MeetingTask, "id" | "assetIds">[];
  sourceTaskIds: Iterable<string>;
  meetingAssetIds: Iterable<string>;
}): string[] {
  const sourceTaskIds = new Set(input.sourceTaskIds);
  const meetingAssetIds = new Set(input.meetingAssetIds);

  return [...new Set(input.tasks.filter((task) => sourceTaskIds.has(task.id)).flatMap((task) => task.assetIds))].filter(
    (assetId) => meetingAssetIds.has(assetId),
  );
}

function taskInput(input: {
  task: MeetingTask;
  contextQuotes?: LinearTaskReviewTaskInput["contextQuotes"];
}): LinearTaskReviewTaskInput {
  const contextQuotes = input.contextQuotes ?? [];

  return {
    id: input.task.id,
    title: input.task.title,
    description: input.task.description,
    taskType: input.task.type,
    workKind: input.task.workKind,
    assigneeName: input.task.assignee.name,
    dueDate: input.task.dueDate.value,
    sourceQuotes: input.task.sourceQuotes.map((quote) => ({
      quote: quote.quote,
      speaker: quote.speaker,
      timestamp: quote.timestamp,
      segmentId: quote.segmentId ?? null,
    })),
    contextQuotes,
    assetIds: input.task.assetIds,
  };
}

async function buildTaskInputs(input: {
  meetingId: string;
  tasks: MeetingTask[];
}): Promise<LinearTaskReviewTaskInput[]> {
  const transcriptData = await repositories().getTranscriptForMeeting(input.meetingId);
  const segments: MeetingTranscriptSegment[] = transcriptData?.segments ?? [];
  const indexById = new Map(segments.map((segment, index) => [segment.id, index]));

  return input.tasks.map((task) => {
    const contextIndexes = [
      ...new Set(
        task.sourceQuotes.flatMap((quote) => {
          const segmentId = quote.segmentId;
          if (segmentId === null || segmentId === undefined || segmentId.length === 0) {
            return [];
          }
          const sourceIndex = indexById.get(segmentId);
          if (sourceIndex === undefined) {
            return [];
          }
          const start = Math.max(0, sourceIndex - TASK_CONTEXT_QUOTE_RADIUS_BEFORE);
          const end = Math.min(segments.length - 1, sourceIndex + TASK_CONTEXT_QUOTE_RADIUS_AFTER);

          return Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
        }),
      ),
    ];
    const sortedContextIndexes = [...contextIndexes].sort((first, second) => first - second);
    const contextQuotes = sortedContextIndexes
      .flatMap((index) => {
        const segment = segments[index];
        if (segment === undefined || segment.content.trim().length === 0) {
          return [];
        }

        return [segment];
      })
      .slice(0, TASK_CONTEXT_QUOTE_LIMIT)
      .map((segment) => ({
        quote: segment.content.trim(),
        speaker: segment.speakerName.length > 0 ? segment.speakerName : null,
        timestamp: segment.startedAt.toISOString(),
        segmentId: segment.id,
      }));

    return taskInput({ task, contextQuotes });
  });
}

export function computeLinearTaskReviewInputHash(tasks: MeetingTask[]): string {
  return computeLinearTaskReviewInputSnapshotHash(createLinearTaskReviewInputSnapshot(tasks));
}

export function createLinearTaskReviewInputSnapshot(tasks: MeetingTask[]): Record<string, unknown>[] {
  return activeTasks(tasks).map((task) => ({
    id: task.id,
    title: task.title,
    description: task.description,
    taskType: task.type,
    workKind: task.workKind,
    assignee: task.assignee,
    dueDate: task.dueDate.value,
    status: task.status,
  }));
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJsonValue);
  }
  if (isRecord(value)) {
    const sortedEntries = [...Object.entries(value)].sort(([first], [second]) => first.localeCompare(second));

    return Object.fromEntries(sortedEntries.map(([key, child]) => [key, canonicalJsonValue(child)]));
  }

  return value;
}

function computeLinearTaskReviewInputSnapshotHashNamed(input: {
  snapshot: unknown[];
  excludedTaskIds: ReadonlySet<string>;
  promptVersion: string;
}): string {
  const scopedSnapshot = input.snapshot.filter((entry) => {
    if (!isRecord(entry)) {
      return true;
    }
    const id = entry.id;

    return typeof id !== "string" || !input.excludedTaskIds.has(id);
  });

  return createHash("sha256")
    .update(input.promptVersion)
    .update("\0")
    .update(JSON.stringify(canonicalJsonValue(scopedSnapshot)))
    .digest("hex");
}

export function computeLinearTaskReviewInputSnapshotHash(
  ...args: [snapshot: unknown[], excludedTaskIds?: ReadonlySet<string>, promptVersion?: string]
): string {
  const snapshot = args[0];
  const excludedTaskIds = args[1] ?? new Set<string>();
  const promptVersion = args[2] ?? LINEAR_TASK_REVIEW_PROMPT_VERSION;

  return computeLinearTaskReviewInputSnapshotHashNamed({ snapshot, excludedTaskIds, promptVersion });
}

function snapshotEntriesForTaskIds(input: {
  snapshot: unknown[];
  taskIds: ReadonlySet<string>;
}): Record<string, unknown>[] {
  const entries = input.snapshot.filter((entry): entry is Record<string, unknown> => {
    if (!isRecord(entry)) {
      return false;
    }
    const id = entry.id;

    return typeof id === "string" && input.taskIds.has(id);
  });

  return [...entries].sort((first, second) => String(first.id).localeCompare(String(second.id)));
}

function linearTaskReviewSourceTasksAreFreshNamed(input: {
  originalSnapshot: unknown[];
  currentTasks: MeetingTask[];
  sourceTaskIds: ReadonlySet<string>;
}): boolean {
  const originalEntries = snapshotEntriesForTaskIds({
    snapshot: input.originalSnapshot,
    taskIds: input.sourceTaskIds,
  });
  const originalIds = new Set(originalEntries.map((entry) => entry.id));
  if (originalIds.size !== input.sourceTaskIds.size) {
    return false;
  }

  const currentSourceTasks = input.currentTasks.filter((task) => input.sourceTaskIds.has(task.id));
  // A previous attempt may have committed the whole deletion before it could
  // mark the item created. That is the one safe missing-task retry case.
  if (currentSourceTasks.length === 0) {
    return true;
  }
  if (
    currentSourceTasks.length !== input.sourceTaskIds.size ||
    currentSourceTasks.some((task) => task.status !== "open")
  ) {
    return false;
  }

  const currentEntries = snapshotEntriesForTaskIds({
    snapshot: createLinearTaskReviewInputSnapshot(currentSourceTasks),
    taskIds: input.sourceTaskIds,
  });

  return (
    computeLinearTaskReviewInputSnapshotHash(originalEntries) ===
    computeLinearTaskReviewInputSnapshotHash(currentEntries)
  );
}

export function linearTaskReviewSourceTasksAreFresh(
  ...args: [originalSnapshot: unknown[], currentTasks: MeetingTask[], sourceTaskIds: ReadonlySet<string>]
): boolean {
  return linearTaskReviewSourceTasksAreFreshNamed({
    originalSnapshot: args[0],
    currentTasks: args[1],
    sourceTaskIds: args[2],
  });
}

export function normalizeLinearTeams(value: unknown): LinearTaskReviewTeam[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (id.length === 0 || name.length === 0) {
      return [];
    }
    const key = typeof entry.key === "string" ? entry.key.trim() : "";

    return [{ id, name, key: key.length > 0 ? key : name }];
  });
}

export function linearReviewItemNeedsIssueCreation(
  item: Pick<LinearTaskReviewItem, "externalIssue" | "targetAction">,
): boolean {
  return item.externalIssue === null && item.targetAction !== "link_existing";
}

export function linearReviewItemNeedsExistingContextSync(
  item: Pick<LinearTaskReviewItem, "targetAction" | "meetingContextSyncedAt">,
): boolean {
  return item.targetAction === "link_existing" && item.meetingContextSyncedAt === null;
}

function linearReviewExternalIssueForTargetChangeNamed(input: {
  item: Pick<LinearTaskReviewItem, "externalIssue" | "targetAction">;
  nextAction: LinearTaskReviewItem["targetAction"];
}): LinearTaskReviewItem["externalIssue"] {
  const isReadyCreatedIssue = input.item.externalIssue !== null && input.item.targetAction !== "link_existing";

  return isReadyCreatedIssue && input.nextAction !== "link_existing" ? input.item.externalIssue : null;
}

export function linearReviewExternalIssueForTargetChange(
  ...args: [
    item: Pick<LinearTaskReviewItem, "externalIssue" | "targetAction">,
    nextAction: LinearTaskReviewItem["targetAction"],
  ]
): LinearTaskReviewItem["externalIssue"] {
  return linearReviewExternalIssueForTargetChangeNamed({ item: args[0], nextAction: args[1] });
}

function linearIssueMarkdownSection(input: { heading: string; content: string | null | undefined }): string[] {
  const trimmedContent = input.content?.trim();
  if (trimmedContent === undefined || trimmedContent.length === 0) {
    return [];
  }

  return [`## ${input.heading}`, trimmedContent, ""];
}

function linearIssueReproductionMarkdownSection(reproductionSteps: string[]): string[] {
  if (reproductionSteps.length === 0) {
    return [];
  }

  return ["## Reproduction", ...reproductionSteps.map((step, index) => `${index + 1}. ${step}`), ""];
}

function linearIssueEvidenceMarkdownSection(
  evidenceItems: NonNullable<LinearTaskReviewItem["issueDraft"]>["evidence"],
): string[] {
  if (evidenceItems.length === 0) {
    return [];
  }

  return [
    "## Evidence from meeting",
    ...evidenceItems.map((evidence) => {
      const attribution = [evidence.timestamp, evidence.speaker]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .join(" · ");

      return `- ${attribution.length > 0 ? `${attribution}: ` : ""}“${evidence.quote}”`;
    }),
    "",
  ];
}

function linearIssueVisualEvidenceMarkdownSection(imageUrls: string[]): string[] {
  if (imageUrls.length === 0) {
    return [];
  }

  return ["## Visual evidence", ...imageUrls.map((url, index) => `![Screen capture ${index + 1}](${url})`), ""];
}

export function buildLinearIssueDescription(input: {
  item: Pick<LinearTaskReviewItem, "title" | "description" | "issueDraft">;
  meetingId: string;
  imageUrls?: string[];
}): string {
  const draft = input.item.issueDraft;
  const reproductionSteps = draft?.reproductionSteps ?? [];
  const reproductionSection = linearIssueReproductionMarkdownSection(reproductionSteps);
  const evidenceItems = draft?.evidence ?? [];
  const evidenceSection = linearIssueEvidenceMarkdownSection(evidenceItems);
  const imageUrls = input.imageUrls ?? [];
  const visualEvidenceSection = linearIssueVisualEvidenceMarkdownSection(imageUrls);

  const sections = [
    ...linearIssueMarkdownSection({
      heading: "Problem",
      content: draft?.problem ?? input.item.description ?? input.item.title,
    }),
    ...linearIssueMarkdownSection({ heading: "Observed behavior", content: draft?.observedBehavior }),
    ...linearIssueMarkdownSection({ heading: "Expected behavior", content: draft?.expectedBehavior }),
    ...linearIssueMarkdownSection({ heading: "Requested change", content: draft?.requestedChange }),
    ...reproductionSection,
    ...linearIssueMarkdownSection({ heading: "Impact", content: draft?.impact }),
    ...evidenceSection,
    ...visualEvidenceSection,
    `Ready meeting: ${apiEnv().NEXT_PUBLIC_WEB_URL}/workspace/${input.meetingId}`,
  ];

  return sections.join("\n").trim();
}

export function appendLinearMeetingContext(input: {
  existingDescription: string;
  meetingContext: string;
  meetingId: string;
  itemId: string;
}): { description: string; /** @external linear description sync flag */ needsUpdate: boolean } {
  const existingDescription = input.existingDescription.trim();
  const meetingContext = input.meetingContext.trim();
  const marker = `<!-- ready-meeting-context:${input.meetingId}:${input.itemId} -->`;
  if (existingDescription.includes(marker) || existingDescription.includes(meetingContext)) {
    return { description: existingDescription, needsUpdate: false };
  }
  const markedContext = `${marker}\n${meetingContext}`;

  return {
    description: existingDescription.length > 0 ? `${existingDescription}\n\n---\n\n${markedContext}` : markedContext,
    needsUpdate: true,
  };
}

export function appendLinearVisualEvidence(input: {
  existingDescription: string;
  imageUrls: string[];
  meetingId: string;
  itemId: string;
}): { description: string; /** @external linear description sync flag */ needsUpdate: boolean } {
  const existingDescription = input.existingDescription.trim();
  const imageUrls = [...new Set(input.imageUrls.map((url) => url.trim()).filter((url) => url.length > 0))];
  if (imageUrls.length === 0) {
    return { description: existingDescription, needsUpdate: false };
  }
  const marker = `<!-- ready-meeting-visual-evidence:${input.meetingId}:${input.itemId} -->`;
  if (existingDescription.includes(marker) || imageUrls.every((url) => existingDescription.includes(url))) {
    return { description: existingDescription, needsUpdate: false };
  }
  const visualEvidence = [
    marker,
    "## Visual evidence",
    ...imageUrls.map((url, index) => `![Screen capture ${index + 1}](${url})`),
  ].join("\n");

  return {
    description: existingDescription.length > 0 ? `${existingDescription}\n\n${visualEvidence}` : visualEvidence,
    needsUpdate: true,
  };
}

async function canUseLinearTaskReviewForMeetingNamed(input: {
  meetingId: string;
  ownerUserId: string;
}): Promise<boolean> {
  const meeting = await repositories().getMeetingById(input.meetingId);
  if (meeting === null || meeting.createdByUserId !== input.ownerUserId) {
    return false;
  }
  const access = await resolveMeetingNotesAccess({
    meeting,
    viewerRole: "participant",
    userId: input.ownerUserId,
  });

  return !access.locked;
}

export async function canUseLinearTaskReviewForMeeting(
  ...args: [meetingId: string, ownerUserId: string]
): Promise<boolean> {
  return canUseLinearTaskReviewForMeetingNamed({ meetingId: args[0], ownerUserId: args[1] });
}

async function connectedLinearConnector(userId: string) {
  const connector = await repositories().getAgentConnectorForUser({ userId, provider: "linear" });
  if (!connector || connector.status !== "connected") {
    return null;
  }
  const secret = await repositories().getLatestAgentConnectorSecret(connector.id);

  return secret ? connector : null;
}

async function emitReviewUpdate(input: {
  run: LinearTaskReviewRun;
  eventName: "task.linear_review.started" | "task.linear_review.updated";
}): Promise<void> {
  const meeting = await repositories().getMeetingById(input.run.meetingId);
  if (meeting === null) {
    return;
  }
  await repositories().publishTaskRealtimeEvent({
    workspaceId: meeting.workspaceId,
    meetingId: meeting.id,
    channel: repositories().meetingTasksRealtimeChannel({ workspaceId: meeting.workspaceId, meetingId: meeting.id }),
    eventName: input.eventName,
    actorUserId: null,
    dedupeKey: `linear-review:${input.run.id}:${input.eventName}:${input.run.status}:${input.run.updatedAt}`,
  });
}

export async function enqueueLinearTaskReviewIfEligible(meetingId: string): Promise<LinearTaskReviewRunView | null> {
  const meeting = await repositories().getMeetingById(meetingId);
  if (!meeting || !(await canUseLinearTaskReviewForMeeting(meetingId, meeting.createdByUserId))) {
    return null;
  }
  const [taskList, connector] = await Promise.all([
    repositories().getMeetingTaskListForMeeting(meetingId),
    connectedLinearConnector(meeting.createdByUserId),
  ]);
  if (!connector || !taskList || taskList.status !== "completed" || activeTasks(taskList.items).length === 0) {
    return null;
  }
  const inputSnapshot = createLinearTaskReviewInputSnapshot(taskList.items);
  const run = await repositories().createLinearTaskReviewRun({
    meetingId,
    taskListId: taskList.id,
    userId: meeting.createdByUserId,
    connectorId: connector.id,
    inputHash: computeLinearTaskReviewInputSnapshotHash(inputSnapshot),
    inputSnapshot,
    promptVersion: LINEAR_TASK_REVIEW_PROMPT_VERSION,
  });
  if (run.status === "queued" || run.status === "failed" || run.status === "stale") {
    if (run.status !== "queued" || run.promptVersion !== LINEAR_TASK_REVIEW_PROMPT_VERSION) {
      await repositories().updateLinearTaskReviewRun({
        runId: run.id,
        status: "queued",
        phase: "queued",
        promptVersion: LINEAR_TASK_REVIEW_PROMPT_VERSION,
        error: null,
        completedAt: null,
      });
    }
    await runAiWorkflowInRequest({
      meetingId,
      type: "review_linear_tasks",
      scopeKey: run.id,
      phase: "queued",
      payload: { runId: run.id },
      maxAttempts: LINEAR_WORKFLOW_MAX_ATTEMPTS,
      logger: { info: () => undefined, warn: () => undefined },
    });
  }

  return repositories().getLinearTaskReviewById(run.id);
}

async function getLinearTaskReviewIfEnabledNamed(input: {
  meetingId: string;
  ownerUserId: string;
}): Promise<LinearTaskReviewRunView | null> {
  const [connector, hasNotesAccess] = await Promise.all([
    connectedLinearConnector(input.ownerUserId),
    canUseLinearTaskReviewForMeeting(input.meetingId, input.ownerUserId),
  ]);
  if (connector === null || !hasNotesAccess) {
    return null;
  }
  const review = await repositories().getLatestLinearTaskReviewForMeeting(input.meetingId);
  if (review !== null && linearTaskReviewNeedsPromptRefresh(review)) {
    return enqueueLinearTaskReviewIfEligible(input.meetingId);
  }

  return review;
}

export async function getLinearTaskReviewIfEnabled(
  ...args: [meetingId: string, ownerUserId: string]
): Promise<LinearTaskReviewRunView | null> {
  return getLinearTaskReviewIfEnabledNamed({ meetingId: args[0], ownerUserId: args[1] });
}

const LINEAR_REVIEW_REFRESHABLE_STATUSES = new Set<LinearTaskReviewRun["status"]>([
  "awaiting_user",
  "no_matches",
  "failed",
  "stale",
]);

export function linearTaskReviewNeedsPromptRefresh(
  review: Pick<LinearTaskReviewRun, "promptVersion" | "status">,
): boolean {
  return (
    LINEAR_REVIEW_REFRESHABLE_STATUSES.has(review.status) && review.promptVersion !== LINEAR_TASK_REVIEW_PROMPT_VERSION
  );
}

async function agentContext(input: {
  user: AgentToolUser;
  meetingId: string;
  suffix: string;
}): Promise<AgentToolExecutionContext> {
  const profile = await repositories().ensureDefaultAgentProfileForUser({
    userId: input.user.id,
    displayName: input.user.displayName,
    voiceId: null,
    llmModel: null,
  });

  return {
    meetingId: input.meetingId,
    utteranceId: `linear-review:${input.suffix}`.slice(0, LINEAR_AGENT_CONTEXT_UTTERANCE_MAX_LENGTH),
    requestingUserId: input.user.id,
    activeSpeakerUserId: input.user.id,
    agentProfileId: profile.id,
    allowedToolScope: "private",
    createdAt: new Date().toISOString(),
  };
}

async function loadTeams(input: { run: LinearTaskReviewRun; user: AgentToolUser }) {
  const connector = await connectedLinearConnector(input.user.id);
  if (!connector) {
    const updated = await repositories().updateLinearTaskReviewRun({
      runId: input.run.id,
      connectorId: null,
      status: "needs_connection",
      phase: "needs_connection",
      error: LINEAR_TASK_REVIEW_MESSAGES.linearIsNotConnected,
    });
    await emitReviewUpdate({ run: updated, eventName: "task.linear_review.updated" });

    return null;
  }
  const context = await agentContext({
    user: input.user,
    meetingId: input.run.meetingId,
    suffix: `teams:${input.run.id}`,
  });
  const result = await executeAgentTool({
    context,
    user: input.user,
    toolName: "linear.list_teams",
    args: {},
    idempotencyKey: `linear-review:${input.run.id}:list-teams`,
  });
  const resultRecord = isRecord(result.result) ? result.result : {};
  const teams = normalizeLinearTeams(resultRecord.teams);
  if (teams.length === 0) {
    throw new Error(LINEAR_TASK_REVIEW_MESSAGES.noLinearTeamsAvailable);
  }

  return { teams, connector, context };
}

function sanitizeCandidates(input: {
  candidates: LinearTaskReviewCandidate[];
  tasks: MeetingTask[];
  taskInputs: LinearTaskReviewTaskInput[];
  teams: LinearTaskReviewTeam[];
}): LinearTaskReviewCandidate[] {
  const validTaskIds = new Set(activeTasks(input.tasks).map((task) => task.id));
  const validTeams = new Map(input.teams.map((team) => [team.id, team]));
  const claimed = new Set<string>();
  const fallbackTeam = input.teams[0];
  if (fallbackTeam === undefined) {
    throw new Error(LINEAR_TASK_REVIEW_MESSAGES.noLinearTeamAvailable);
  }
  const taskInputById = new Map(input.taskInputs.map((task) => [task.id, task]));

  return input.candidates.flatMap((candidate) => {
    if (candidate.decision === "not_linear") {
      return [];
    }
    const sourceTaskIds = [...new Set(candidate.sourceTaskIds)].filter(
      (id) => validTaskIds.has(id) && !claimed.has(id),
    );
    sourceTaskIds.forEach((id) => {
      claimed.add(id);
    });
    if (sourceTaskIds.length === 0) {
      return [];
    }
    const team =
      candidate.teamId !== null && candidate.teamId.length > 0
        ? (validTeams.get(candidate.teamId) ?? fallbackTeam)
        : fallbackTeam;
    const suppliedEvidence = sourceTaskIds.flatMap((taskId) => {
      const source = taskInputById.get(taskId);

      return source ? [...source.sourceQuotes, ...source.contextQuotes] : [];
    });
    const issueDraft = groundLinearIssueDraft({
      draft: candidate.issueDraft,
      suppliedEvidence,
      tasks: sourceTaskIds
        .map((taskId) => taskInputById.get(taskId))
        .filter((task): task is LinearTaskReviewTaskInput => task !== undefined),
    });

    return [
      {
        ...candidate,
        sourceTaskIds,
        issueDraft,
        confidence: Math.max(0, Math.min(1, candidate.confidence)),
        teamId: team.id,
        teamName: team.name,
      },
    ];
  });
}

const GROUNDING_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "we",
  "when",
  "with",
  "you",
  // Workflow language is common to nearly every product issue and must not
  // count as evidence that two issues describe the same work.
  "bug",
  "bugs",
  "change",
  "changed",
  "changes",
  "fix",
  "fixed",
  "fixes",
  "fixing",
  "issue",
  "issues",
  "make",
  "need",
  "needs",
  "needed",
  "not",
  "should",
  "shouldnt",
  "update",
  "updated",
  "updates",
  "work",
  "works",
]);

function groundingTokens(value: string) {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= LINEAR_GROUNDING_MIN_TOKEN_LENGTH && !GROUNDING_STOP_WORDS.has(token)),
  );
}

const RECOMMENDED_EXISTING_ISSUE_SCORE = 0.6;
const RECOMMENDED_EXISTING_ISSUE_MARGIN = 0.15;
const CLOSED_LINEAR_ISSUE_STATUS = /\b(done|complete|completed|closed|cancelled|canceled|duplicate)\b/i;
const READY_MEETING_CONTEXT_MARKER = /<!--\s*ready-meeting-context:/i;

type RankedDuplicateIssue = LinearTaskReviewDuplicateIssue & { score: number };

function externalIssueFromDuplicate(issue: LinearTaskReviewDuplicateIssue) {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
  };
}

export function linearReviewRevisionTargetPreference(instruction: string): LinearTaskReviewRevisionTargetPreference {
  const issueMatches = [...instruction.matchAll(/\b[A-Za-z][A-Za-z0-9]*-\d+\b/g)];
  const routed = issueMatches.map((match) => {
    const matchIndex = match.index;
    const prefix = instruction.slice(Math.max(0, matchIndex - LINEAR_REVISION_IDENTIFIER_LOOKBACK_CHARS), matchIndex);
    const clause = prefix.slice(
      Math.max(prefix.lastIndexOf("."), prefix.lastIndexOf(","), prefix.lastIndexOf(";")) + 1,
    );
    const routingCues = [
      ...clause.matchAll(
        /\b(?:(?<negative>(?:do not|don't|never|not)\s+(?:add|attach|link|update|use)|avoid|exclude|except|skip|without)|(?<positive>add|attach|link|update|use))\b/gi,
      ),
    ];
    const routingCue = routingCues.at(-1);

    return {
      identifier: match[0].toUpperCase(),
      isRejectingIssue: Boolean(routingCue?.groups?.negative),
      isAskingToUseIssue: Boolean(routingCue?.groups?.positive),
    };
  });
  const hasNegativeRoutingIntent = routed.some((item) => item.isRejectingIssue);
  const identifiers = routed.flatMap((item) =>
    item.isAskingToUseIssue && !item.isRejectingIssue ? [item.identifier] : [],
  );
  const isExplicitlyCreatingNew = /\bcreate\b[^.!?]{0,48}\b(?:all\s+)?new issues?\b/i.test(instruction);
  const uniqueIdentifiers = [...new Set(identifiers)];

  return {
    mode:
      uniqueIdentifiers.length !== 0
        ? ("use_existing" as const)
        : isExplicitlyCreatingNew || hasNegativeRoutingIntent
          ? ("create_new" as const)
          : ("automatic" as const),
    identifiers: uniqueIdentifiers,
  };
}

export function resolveLinearReviewRevisionTarget(input: {
  instruction: string;
  candidate: LinearTaskReviewCandidate;
  currentCandidates: LinearTaskReviewCandidate[];
  duplicateIssues: LinearTaskReviewDuplicateIssue[];
  recommendedIssue: LinearTaskReviewCandidate["targetIssue"];
}): {
  duplicateIssues: LinearTaskReviewDuplicateIssue[];
  targetIssue: LinearTaskReviewCandidate["targetIssue"];
} {
  const preference = linearReviewRevisionTargetPreference(input.instruction);
  if (preference.mode === "automatic") {
    return {
      duplicateIssues: input.duplicateIssues,
      targetIssue: input.recommendedIssue,
    };
  }
  if (preference.mode === "create_new") {
    return {
      duplicateIssues: input.duplicateIssues,
      targetIssue: null,
    };
  }

  const sourceTaskIds = new Set(input.candidate.sourceTaskIds);
  const relevantCurrentCandidates = input.currentCandidates.filter((candidate) =>
    candidate.sourceTaskIds.some((taskId) => sourceTaskIds.has(taskId)),
  );
  const knownIssues = new Map<string, LinearTaskReviewDuplicateIssue>(
    [...input.duplicateIssues, ...relevantCurrentCandidates.flatMap((candidate) => candidate.duplicateIssues)].map(
      (issue): [string, LinearTaskReviewDuplicateIssue] => [issue.identifier.toUpperCase(), issue],
    ),
  );
  relevantCurrentCandidates.forEach((candidate) => {
    if (candidate.targetIssue === null) {
      return;
    }
    knownIssues.set(candidate.targetIssue.identifier.toUpperCase(), {
      ...candidate.targetIssue,
      status: null,
      rationale: "Selected from the existing issue found for this work.",
    });
  });

  const selectedIssue =
    preference.identifiers
      .map((identifier) => knownIssues.get(identifier))
      .find((issue): issue is LinearTaskReviewDuplicateIssue => issue !== undefined) ?? null;
  const duplicateIssues =
    selectedIssue && !input.duplicateIssues.some((issue) => issue.id === selectedIssue.id)
      ? [selectedIssue, ...input.duplicateIssues].slice(0, LINEAR_DUPLICATE_ISSUES_LIST_LIMIT)
      : input.duplicateIssues;

  return {
    duplicateIssues,
    targetIssue: selectedIssue ? externalIssueFromDuplicate(selectedIssue) : null,
  };
}

function recommendedExistingIssue(matches: RankedDuplicateIssue[]): LinearTaskReviewExternalIssue | null {
  const eligible = matches.filter(
    (issue) =>
      issue.score >= RECOMMENDED_EXISTING_ISSUE_SCORE &&
      issue.status !== null &&
      issue.status.length > 0 &&
      !CLOSED_LINEAR_ISSUE_STATUS.test(issue.status),
  );
  const match = eligible[0];
  const runnerUp = eligible[1];
  if (match && runnerUp && match.score - runnerUp.score < RECOMMENDED_EXISTING_ISSUE_MARGIN) {
    return null;
  }

  return match ? externalIssueFromDuplicate(match) : null;
}

function linearIssueDescriptionWithoutReadyContext(description: string) {
  const markerIndex = description.search(READY_MEETING_CONTEXT_MARKER);
  if (markerIndex < 0) {
    return description;
  }
  const separatorIndex = description.lastIndexOf("\n---", markerIndex);

  return description.slice(0, separatorIndex >= 0 ? separatorIndex : markerIndex).trim();
}

function hasGroundingOverlap(input: { value: string; evidenceText: string }): boolean {
  const valueTokens = groundingTokens(input.value);
  const evidenceTokens = groundingTokens(input.evidenceText);
  if (valueTokens.size === 0) {
    return false;
  }
  const overlap = [...valueTokens].filter((token) => evidenceTokens.has(token)).length;

  return overlap >= Math.min(LINEAR_GROUNDING_OVERLAP_MIN, valueTokens.size);
}

function groundedDraftField(input: {
  value: string | null | undefined;
  evidenceText: string;
  isCueRequired?: boolean;
  isCue?: boolean;
}): string | null {
  const trimmed = input.value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return null;
  }
  if (input.isCueRequired === true && input.isCue !== true) {
    return null;
  }

  return hasGroundingOverlap({ value: trimmed, evidenceText: input.evidenceText }) ? trimmed : null;
}

function taskDraftProblemFallback(tasks: LinearTaskReviewTaskInput[]): string {
  return tasks
    .map((task) => task.description ?? task.title)
    .filter((value) => value.trim().length > 0)
    .join("\n")
    .slice(0, LINEAR_ISSUE_DRAFT_PROBLEM_MAX_LENGTH);
}

function groundLinearIssueDraft(input: {
  draft: LinearTaskReviewCandidate["issueDraft"];
  suppliedEvidence: LinearTaskReviewTaskInput["sourceQuotes"];
  tasks: LinearTaskReviewTaskInput[];
}): LinearTaskReviewCandidate["issueDraft"] {
  const fallbackEvidence = input.tasks
    .flatMap((task) => task.sourceQuotes)
    .slice(0, LINEAR_ISSUE_DRAFT_FALLBACK_EVIDENCE_LIMIT);
  if (input.draft === null) {
    const problem = taskDraftProblemFallback(input.tasks);

    return fallbackEvidence.length !== 0
      ? {
          problem,
          observedBehavior: null,
          expectedBehavior: null,
          requestedChange: null,
          reproductionSteps: [],
          impact: null,
          evidence: fallbackEvidence,
        }
      : null;
  }
  const evidence = input.draft.evidence
    .flatMap((candidateEvidence) => {
      const normalized = candidateEvidence.quote.trim().replace(/\s+/g, " ").toLowerCase();
      const matched = input.suppliedEvidence.find((source) => {
        const segmentId = candidateEvidence.segmentId;
        if (segmentId !== null && segmentId.length > 0 && source.segmentId === segmentId) {
          return source.quote.trim().replace(/\s+/g, " ").toLowerCase() === normalized;
        }

        return source.quote.trim().replace(/\s+/g, " ").toLowerCase() === normalized;
      });

      return matched !== undefined ? [matched] : [];
    })
    .slice(0, LINEAR_ISSUE_DRAFT_EVIDENCE_LIMIT);
  if (evidence.length === 0) {
    return groundLinearIssueDraft({ draft: null, suppliedEvidence: input.suppliedEvidence, tasks: input.tasks });
  }
  const evidenceText = evidence.map((item) => item.quote).join("\n");
  const allSuppliedText = input.suppliedEvidence.map((item) => item.quote).join("\n");
  const isExpectedCue = /\b(should|expected|supposed|used to|needs? to|want(?:ed)?|correct behavior)\b/i.test(
    allSuppliedText,
  );
  const isRequestCue =
    /\b(please|can we|could we|need(?:s)? to|want(?:ed)?|request|change|fix|add|remove|show|allow|make)\b/i.test(
      allSuppliedText,
    );
  const isImpactCue =
    /\b(block(?:ed|ing)?|customer|users?|cannot|can't|unable|impact|critical|urgent|lost|failure|production)\b/i.test(
      allSuppliedText,
    );
  const fallbackProblem = taskDraftProblemFallback(input.tasks);
  const problem = hasGroundingOverlap({ value: input.draft.problem, evidenceText })
    ? input.draft.problem
    : fallbackProblem;

  return {
    problem,
    observedBehavior: groundedDraftField({ value: input.draft.observedBehavior, evidenceText }),
    expectedBehavior: groundedDraftField({
      value: input.draft.expectedBehavior,
      evidenceText: allSuppliedText,
      isCueRequired: true,
      isCue: isExpectedCue,
    }),
    requestedChange: groundedDraftField({
      value: input.draft.requestedChange,
      evidenceText: allSuppliedText,
      isCueRequired: true,
      isCue: isRequestCue,
    }),
    reproductionSteps: input.draft.reproductionSteps
      .filter((step) => hasGroundingOverlap({ value: step, evidenceText: allSuppliedText }))
      .slice(0, LINEAR_ISSUE_DRAFT_REPRODUCTION_STEPS_LIMIT),
    impact: groundedDraftField({
      value: input.draft.impact,
      evidenceText: allSuppliedText,
      isCueRequired: true,
      isCue: isImpactCue,
    }),
    evidence,
  };
}

function duplicateSearchTerms(candidate: LinearTaskReviewCandidate) {
  const terms = [candidate.title, candidate.issueDraft?.problem ?? ""]
    .flatMap((value) => [value, ...value.split(/[:—-]/)])
    .map((value) =>
      value
        .replace(/[^a-zA-Z0-9\s/-]/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((value) => value.length >= LINEAR_DUPLICATE_SEARCH_TERM_MIN_LENGTH)
    .map((value) => value.slice(0, LINEAR_DUPLICATE_SEARCH_TERM_MAX_LENGTH));

  return [...new Set(terms)].slice(0, LINEAR_DUPLICATE_SEARCH_TERMS_LIMIT);
}

async function findDuplicateIssues(input: {
  run: LinearTaskReviewRun;
  user: AgentToolUser;
  candidate: LinearTaskReviewCandidate;
}) {
  const searchResults = await duplicateSearchTerms(input.candidate).reduce<
    Promise<{ term: string; issues: Record<string, unknown>[] }[]>
  >(async (previous, term) => {
    const results = await previous;
    const context = await agentContext({
      user: input.user,
      meetingId: input.run.meetingId,
      suffix: `duplicates:${input.run.id}:${term}`,
    });
    const result = await executeAgentTool({
      context,
      user: input.user,
      toolName: "linear.search_issues",
      args: { term },
      idempotencyKey: `linear-review:${input.run.id}:search:${term}`,
    });

    const resultRecord = isRecord(result.result) ? result.result : {};
    const issuesValue = resultRecord.issues;
    const issues = Array.isArray(issuesValue)
      ? issuesValue.filter((entry): entry is Record<string, unknown> => isRecord(entry))
      : [];

    return [...results, { term, issues }];
  }, Promise.resolve([]));
  const ranked = rankDuplicateIssueSearchResults({ candidate: input.candidate, searchResults });

  return {
    duplicateIssues: ranked.map((issue) => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      status: issue.status,
      rationale: issue.rationale,
    })),
    recommendedIssue: recommendedExistingIssue(ranked),
  };
}

function rankedDuplicateFromSearchIssue(input: {
  issue: Record<string, unknown>;
  candidateTokens: Set<string>;
  requiredOverlap: number;
}): RankedDuplicateIssue | null {
  const id = typeof input.issue.id === "string" ? input.issue.id : "";
  const identifier = typeof input.issue.identifier === "string" ? input.issue.identifier : "";
  const title = typeof input.issue.title === "string" ? input.issue.title : "";
  const url = typeof input.issue.url === "string" ? input.issue.url : "";
  if (id.length === 0 || identifier.length === 0 || title.length === 0 || url.length === 0) {
    return null;
  }
  const status = typeof input.issue.status === "string" ? input.issue.status : null;
  if (status !== null && status.length > 0 && CLOSED_LINEAR_ISSUE_STATUS.test(status)) {
    return null;
  }
  const description =
    typeof input.issue.description === "string"
      ? linearIssueDescriptionWithoutReadyContext(input.issue.description)
      : "";
  const issueTokens = groundingTokens(`${title} ${description}`);
  const sharedTokens = [...input.candidateTokens].filter((token) => issueTokens.has(token));
  const overlap = sharedTokens.length;
  if (overlap < input.requiredOverlap) {
    return null;
  }
  const score =
    overlap / Math.max(1, Math.min(input.candidateTokens.size, LINEAR_DUPLICATE_GROUNDING_MAX_CANDIDATE_TOKENS));

  return {
    id,
    identifier,
    title,
    url,
    status,
    rationale: `Shares ${sharedTokens.slice(0, LINEAR_DUPLICATE_SHARED_TOKEN_PREVIEW_LIMIT).join(", ")} context with this task.`,
    score,
  };
}

function rankDuplicateIssueSearchResults(input: {
  candidate: LinearTaskReviewCandidate;
  searchResults: { term: string; issues: Record<string, unknown>[] }[];
}): RankedDuplicateIssue[] {
  const matches = new Map<string, RankedDuplicateIssue>();
  const candidateTokens = groundingTokens(
    [
      input.candidate.title,
      input.candidate.issueDraft?.problem ?? "",
      input.candidate.issueDraft?.observedBehavior ?? "",
      input.candidate.issueDraft?.expectedBehavior ?? "",
      input.candidate.issueDraft?.requestedChange ?? "",
    ].join(" "),
  );
  if (candidateTokens.size === 0) {
    return [];
  }
  const requiredOverlap = Math.min(LINEAR_DUPLICATE_GROUNDING_REQUIRED_OVERLAP_CAP, candidateTokens.size);
  input.searchResults.forEach(({ issues }) => {
    issues.forEach((issue) => {
      const ranked = rankedDuplicateFromSearchIssue({ issue, candidateTokens, requiredOverlap });
      if (ranked === null) {
        return;
      }
      const existing = matches.get(ranked.id);
      if (existing !== undefined && existing.score >= ranked.score) {
        return;
      }
      matches.set(ranked.id, ranked);
    });
  });

  return [...matches.values()]
    .sort((first, second) => {
      const scoreDelta = second.score - first.score;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      return first.identifier.localeCompare(second.identifier);
    })
    .slice(0, LINEAR_DUPLICATE_RANKED_RESULTS_LIMIT);
}

async function requireRunUser(run: LinearTaskReviewRun) {
  const user = await repositories().getUserById(run.userId);
  if (!user) {
    throw new Error(LINEAR_TASK_REVIEW_MESSAGES.reviewOwnerMissing);
  }

  return { id: user.id, email: user.email, displayName: user.displayName };
}

export async function runLinearTaskReviewJob(input: {
  job: AiWorkflowJobView;
  logger: LoggerLike;
}): Promise<LinearTaskReviewRunView> {
  const runId = typeof input.job.payload.runId === "string" ? input.job.payload.runId : null;
  const run = runId !== null ? await repositories().getLinearTaskReviewById(runId) : null;
  if (!run || run.meetingId !== input.job.meetingId) {
    throw new Error(LINEAR_TASK_REVIEW_MESSAGES.reviewRunNotFound);
  }
  if (!(await canUseLinearTaskReviewForMeeting(run.meetingId, run.userId))) {
    const locked = await repositories().updateLinearTaskReviewRun({
      runId: run.id,
      status: "stale",
      phase: "notes_locked",
      error: LINEAR_TASK_REVIEW_MESSAGES.meetingNotesLocked,
      completedAt: new Date(),
    });
    await emitReviewUpdate({ run: locked, eventName: "task.linear_review.updated" });

    return locked;
  }
  const user = await requireRunUser(run);
  const taskList = await repositories().getMeetingTaskListForMeeting(run.meetingId);
  if (
    !taskList ||
    taskList.id !== run.taskListId ||
    computeLinearTaskReviewInputHash(taskList.items) !== run.inputHash
  ) {
    const stale = await repositories().updateLinearTaskReviewRun({
      runId: run.id,
      status: "stale",
      phase: "stale",
      error: LINEAR_TASK_REVIEW_MESSAGES.tasksChangedBeforeReview,
      completedAt: new Date(),
    });
    await emitReviewUpdate({ run: stale, eventName: "task.linear_review.updated" });
    await enqueueLinearTaskReviewIfEligible(run.meetingId);

    return stale;
  }
  const reviewing = await repositories().updateLinearTaskReviewRun({
    runId: run.id,
    status: "reviewing",
    phase: "reviewing_tasks",
    error: null,
    startedAt: run.startedAt !== null ? new Date(run.startedAt) : new Date(),
  });
  await emitReviewUpdate({ run: reviewing, eventName: "task.linear_review.started" });
  const preflight = await loadTeams({ run: reviewing, user });
  if (!preflight) {
    const current = await repositories().getLinearTaskReviewById(run.id);
    if (current === null) {
      throw new Error(LINEAR_TASK_REVIEW_MESSAGES.linearTaskReviewNotFound);
    }

    return current;
  }
  const taskInputs = await buildTaskInputs({ meetingId: run.meetingId, tasks: activeTasks(taskList.items) });
  const response = linearTaskReviewClassificationResponseSchema.parse(
    await triggerLinearTaskReview(run.meetingId, {
      meetingId: run.meetingId,
      jobId: input.job.id,
      tasks: taskInputs,
      availableTeams: preflight.teams,
    }),
  );
  const candidates = sanitizeCandidates({
    candidates: response.candidates,
    tasks: taskList.items,
    taskInputs,
    teams: preflight.teams,
  });
  const candidatesWithDuplicates = await Promise.all(
    candidates.map(async (candidate) => {
      const { duplicateIssues, recommendedIssue } = await findDuplicateIssues({ run, user, candidate });

      return {
        ...candidate,
        duplicateIssues,
        targetAction: recommendedIssue !== null ? ("link_existing" as const) : ("create" as const),
        targetIssue: recommendedIssue,
        relationId: null,
      };
    }),
  );
  await repositories().replaceLinearTaskReviewItems({ runId: run.id, candidates: candidatesWithDuplicates });
  const updated = await repositories().updateLinearTaskReviewRun({
    runId: run.id,
    connectorId: preflight.connector.id,
    status: candidatesWithDuplicates.length !== 0 ? "awaiting_user" : "no_matches",
    phase: candidatesWithDuplicates.length !== 0 ? "awaiting_user" : "complete",
    model: response.model,
    promptVersion: response.promptVersion,
    error: null,
    completedAt: candidatesWithDuplicates.length !== 0 ? null : new Date(),
  });
  await emitReviewUpdate({ run: updated, eventName: "task.linear_review.updated" });
  input.logger.info(
    { meetingId: run.meetingId, runId: run.id, matchCount: candidatesWithDuplicates.length },
    LINEAR_TASK_REVIEW_MESSAGES.linearTaskReviewCompleted,
  );

  return updated;
}

function mergeCandidateTitle(candidates: LinearTaskReviewCandidate[]): string {
  const titles = [...new Set(candidates.map((candidate) => candidate.title.trim()))];
  const firstTitle = titles[0];
  if (titles.length === 1 && firstTitle !== undefined) {
    return firstTitle;
  }
  const joined = titles.join(" and ");
  if (joined.length <= LINEAR_MERGE_CANDIDATE_TITLE_MAX_LENGTH || firstTitle === undefined) {
    return joined;
  }

  return `${firstTitle.slice(0, LINEAR_MERGE_CANDIDATE_TITLE_TRUNCATED_LENGTH)}…`;
}

function isNonEmptyString(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function joinNonEmptyStrings(input: { values: (string | null | undefined)[]; separator: string }): string | null {
  const joined = input.values.filter(isNonEmptyString).join(input.separator);

  return joined.length > 0 ? joined : null;
}

export function mergeLinearReviewCandidates(candidates: LinearTaskReviewCandidate[]): LinearTaskReviewCandidate[] {
  const first = candidates[0];
  if (!first) {
    return [];
  }
  const mergedEvidence = candidates
    .flatMap((candidate) => candidate.issueDraft?.evidence ?? [])
    .slice(0, LINEAR_ISSUE_DRAFT_EVIDENCE_LIMIT);

  return [
    {
      sourceTaskIds: [...new Set(candidates.flatMap((candidate) => candidate.sourceTaskIds))],
      decision: candidates.every((candidate) => candidate.decision === "linear")
        ? ("linear" as const)
        : ("uncertain" as const),
      confidence: Math.min(...candidates.map((candidate) => candidate.confidence)),
      reasoning: "Merged at the user’s request because these tasks should become one Linear issue.",
      title: mergeCandidateTitle(candidates),
      description: joinNonEmptyStrings({
        values: candidates.map((candidate) => candidate.description),
        separator: "\n\n",
      }),
      issueDraft:
        mergedEvidence.length !== 0
          ? {
              problem:
                joinNonEmptyStrings({
                  values: candidates.map((candidate) => candidate.issueDraft?.problem),
                  separator: "\n\n",
                }) ?? mergeCandidateTitle(candidates),
              observedBehavior: joinNonEmptyStrings({
                values: candidates.map((candidate) => candidate.issueDraft?.observedBehavior),
                separator: "\n\n",
              }),
              expectedBehavior: joinNonEmptyStrings({
                values: candidates.map((candidate) => candidate.issueDraft?.expectedBehavior),
                separator: "\n\n",
              }),
              requestedChange: joinNonEmptyStrings({
                values: candidates.map((candidate) => candidate.issueDraft?.requestedChange),
                separator: "\n\n",
              }),
              reproductionSteps: candidates
                .flatMap((candidate) => candidate.issueDraft?.reproductionSteps ?? [])
                .slice(0, LINEAR_ISSUE_DRAFT_REPRODUCTION_STEPS_LIMIT),
              impact: joinNonEmptyStrings({
                values: candidates.map((candidate) => candidate.issueDraft?.impact),
                separator: "\n\n",
              }),
              evidence: mergedEvidence,
            }
          : null,
      teamId: first.teamId,
      teamName: first.teamName,
      duplicateIssues: [],
      targetAction: "create" as const,
      targetIssue: null,
      relationId: null,
    },
  ];
}

type MeetingTaskListView = NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingTaskListForMeeting"]>>>;

type LinearTaskReviewTeamsPreflight = NonNullable<Awaited<ReturnType<typeof loadTeams>>>;

function linearTaskReviewCandidatesFromRunItems(items: LinearTaskReviewRunView["items"]): LinearTaskReviewCandidate[] {
  return items
    .filter((item) => item.included)
    .map((item) => ({
      sourceTaskIds: item.sourceTaskIds,
      decision: item.decision,
      confidence: item.confidence,
      reasoning: item.reasoning,
      title: item.title,
      description: item.description,
      issueDraft: item.issueDraft,
      teamId: item.teamId,
      teamName: item.teamName,
      duplicateIssues: item.duplicateIssues,
      targetAction: item.targetAction,
      targetIssue: item.targetIssue,
      relationId: item.relationId,
    }));
}

async function fetchRevisedLinearTaskReviewResponse(input: {
  run: LinearTaskReviewRun;
  instruction: string;
  currentCandidates: LinearTaskReviewCandidate[];
  taskInputs: LinearTaskReviewTaskInput[];
  teams: LinearTaskReviewTeam[];
}): Promise<
  Omit<ReturnType<typeof linearTaskReviewClassificationResponseSchema.parse>, "promptVersion"> & {
    promptVersion: string;
  }
> {
  const isMergeInstruction = /\b(merge|combine|single issue|one issue|same issue)\b/i.test(input.instruction);
  if (isMergeInstruction && input.currentCandidates.length === LINEAR_MERGE_CANDIDATE_PAIR_COUNT) {
    return {
      candidates: mergeLinearReviewCandidates(input.currentCandidates),
      model: input.run.model ?? "deterministic",
      promptVersion: input.run.promptVersion ?? "linear-task-review-v1",
    };
  }

  return linearTaskReviewClassificationResponseSchema.parse(
    await triggerLinearTaskReviewRevision(input.run.id, {
      meetingId: input.run.meetingId,
      runId: input.run.id,
      instruction: input.instruction,
      tasks: input.taskInputs,
      currentCandidates: input.currentCandidates,
      availableTeams: input.teams,
    }),
  );
}

async function persistRevisedLinearTaskReviewCandidates(input: {
  run: LinearTaskReviewRun;
  user: AgentToolUser;
  instruction: string;
  taskList: MeetingTaskListView;
  preflight: LinearTaskReviewTeamsPreflight;
}): Promise<LinearTaskReviewRunView> {
  const currentCandidates = linearTaskReviewCandidatesFromRunItems(input.run.items);
  const taskInputs = await buildTaskInputs({
    meetingId: input.run.meetingId,
    tasks: activeTasks(input.taskList.items),
  });
  const response = await fetchRevisedLinearTaskReviewResponse({
    run: input.run,
    instruction: input.instruction,
    currentCandidates,
    taskInputs,
    teams: input.preflight.teams,
  });
  const candidates = sanitizeCandidates({
    candidates: response.candidates,
    tasks: input.taskList.items,
    taskInputs,
    teams: input.preflight.teams,
  });
  const candidatesWithDuplicates = await Promise.all(
    candidates.map(async (candidate) => {
      const { duplicateIssues, recommendedIssue } = await findDuplicateIssues({
        run: input.run,
        user: input.user,
        candidate,
      });
      const resolvedTarget = resolveLinearReviewRevisionTarget({
        instruction: input.instruction,
        candidate,
        currentCandidates,
        duplicateIssues,
        recommendedIssue,
      });

      return {
        ...candidate,
        duplicateIssues: resolvedTarget.duplicateIssues,
        targetAction: resolvedTarget.targetIssue !== null ? ("link_existing" as const) : ("create" as const),
        targetIssue: resolvedTarget.targetIssue,
        relationId: null,
      };
    }),
  );
  await repositories().replaceLinearTaskReviewItems({ runId: input.run.id, candidates: candidatesWithDuplicates });
  const updated = await repositories().updateLinearTaskReviewRun({
    runId: input.run.id,
    connectorId: input.preflight.connector.id,
    status: candidatesWithDuplicates.length !== 0 ? "awaiting_user" : "no_matches",
    phase: candidatesWithDuplicates.length !== 0 ? "awaiting_user" : "complete",
    model: response.model,
    promptVersion: response.promptVersion,
    error: null,
    completedAt: candidatesWithDuplicates.length !== 0 ? null : new Date(),
  });
  await emitReviewUpdate({ run: updated, eventName: "task.linear_review.updated" });

  return updated;
}

export async function reviseLinearTaskReview(input: {
  runId: string;
  userId: string;
  instruction: string;
}): Promise<LinearTaskReviewRunView | null> {
  const run = await repositories().getLinearTaskReviewById(input.runId);
  if (run === null || run.userId !== input.userId) {
    throw new Error(LINEAR_TASK_REVIEW_MESSAGES.linearTaskReviewNotFound);
  }
  if (!(await canUseLinearTaskReviewForMeeting(run.meetingId, input.userId))) {
    throw new Error(LINEAR_TASK_REVIEW_MESSAGES.meetingNotesLocked);
  }
  const user = await requireRunUser(run);
  const taskList = await repositories().getMeetingTaskListForMeeting(run.meetingId);
  if (
    taskList === null ||
    taskList.id !== run.taskListId ||
    computeLinearTaskReviewInputHash(taskList.items) !== run.inputHash
  ) {
    const stale = await repositories().updateLinearTaskReviewRun({
      runId: run.id,
      status: "stale",
      phase: "stale",
      error: LINEAR_TASK_REVIEW_MESSAGES.tasksChangedBeforeRevision,
      completedAt: new Date(),
    });
    await emitReviewUpdate({ run: stale, eventName: "task.linear_review.updated" });
    await enqueueLinearTaskReviewIfEligible(run.meetingId);

    return stale;
  }
  const revising = await repositories().claimLinearTaskReviewRunAction({
    runId: run.id,
    status: "revising",
    phase: "applying_change",
  });
  if (revising === null) {
    return repositories().getLinearTaskReviewById(run.id);
  }
  await emitReviewUpdate({ run: revising, eventName: "task.linear_review.updated" });
  try {
    const preflight = await loadTeams({ run: revising, user });
    if (preflight === null) {
      return await repositories().getLinearTaskReviewById(run.id);
    }

    return await persistRevisedLinearTaskReviewCandidates({
      run: revising,
      user,
      instruction: input.instruction,
      taskList,
      preflight,
    });
  } catch (error) {
    const failed = await repositories().updateLinearTaskReviewRun({
      runId: run.id,
      status: "awaiting_user",
      phase: "revision_failed",
      error: error instanceof Error ? error.message : LINEAR_TASK_REVIEW_MESSAGES.couldNotReviseLinearReview,
    });
    await emitReviewUpdate({ run: failed, eventName: "task.linear_review.updated" });
    throw error;
  }
}

function issueFromResult(result: unknown): LinearTaskReviewExternalIssue | null {
  if (!isRecord(result)) {
    return null;
  }
  const issue = result.issue;
  if (!isRecord(issue)) {
    return null;
  }
  const id = issue.id;
  const identifier = issue.identifier;
  const title = issue.title;
  const url = issue.url;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof identifier !== "string" ||
    identifier.length === 0 ||
    typeof title !== "string" ||
    title.length === 0 ||
    typeof url !== "string" ||
    url.length === 0
  ) {
    return null;
  }

  return { id, identifier, title, url };
}

function relationFromResult(result: unknown): string | null {
  if (!isRecord(result)) {
    return null;
  }
  const relation = result.relation;
  if (!isRecord(relation)) {
    return null;
  }
  const id = relation.id;

  return typeof id === "string" && id.length > 0 ? id : null;
}

function linearUploadAssetUrlFromResult(result: unknown): string | null {
  if (!isRecord(result)) {
    return null;
  }
  const assetUrl = result.assetUrl;

  return typeof assetUrl === "string" && assetUrl.length > 0 ? assetUrl : null;
}

function linearGetIssueDescriptionFromResult(result: unknown): string {
  if (!isRecord(result)) {
    return "";
  }
  const issue = result.issue;
  if (!isRecord(issue)) {
    return "";
  }
  const description = issue.description;

  return typeof description === "string" ? description.trim() : "";
}

export async function updateLinearTaskReviewTarget(input: {
  runId: string;
  itemId: string;
  userId: string;
  action: LinearTaskReviewItem["targetAction"];
  issueId: string | null;
}): Promise<LinearTaskReviewRunView | null> {
  const run = await repositories().getLinearTaskReviewById(input.runId);
  if (run === null || run.userId !== input.userId || run.status !== "awaiting_user") {
    throw new Error(LINEAR_TASK_REVIEW_MESSAGES.linearTaskReviewNotReadyForChanges);
  }
  const item = run.items.find((candidate) => candidate.id === input.itemId);
  if (item === undefined) {
    throw new Error(LINEAR_TASK_REVIEW_MESSAGES.linearTaskReviewItemNotFound);
  }
  const targetIssue =
    input.action === "create" ? null : (item.duplicateIssues.find((issue) => issue.id === input.issueId) ?? null);
  if (input.action !== "create" && targetIssue === null) {
    throw new Error(LINEAR_TASK_REVIEW_MESSAGES.chooseSuggestedLinearIssue);
  }
  await repositories().updateLinearTaskReviewItem({
    itemId: item.id,
    targetAction: input.action,
    targetIssue,
    relationId: null,
    meetingContextSyncedAt: null,
    externalIssue: linearReviewExternalIssueForTargetChange(item, input.action),
    syncStatus: "pending",
    syncError: null,
  });

  return repositories().getLinearTaskReviewById(run.id);
}

type MeetingAssetView = Awaited<ReturnType<RepositoryPort["listMeetingAssets"]>>[number];

function isLinearTaskReviewInputSnapshotMatching(input: {
  taskList: MeetingTaskListView;
  run: LinearTaskReviewRun;
  inputSnapshot: unknown[];
  persistedIssueSourceTaskIds: ReadonlySet<string>;
}): boolean {
  if (input.inputSnapshot.length === 0) {
    return false;
  }
  if (input.persistedIssueSourceTaskIds.size === 0) {
    return computeLinearTaskReviewInputHash(input.taskList.items) === input.run.inputHash;
  }

  return (
    computeLinearTaskReviewInputSnapshotHash(
      createLinearTaskReviewInputSnapshot(input.taskList.items),
      input.persistedIssueSourceTaskIds,
    ) === computeLinearTaskReviewInputSnapshotHash(input.inputSnapshot, input.persistedIssueSourceTaskIds)
  );
}

async function uploadLinearTaskReviewLinkedAssetUrls(input: {
  linkedAssetIds: string[];
  meetingAssetsById: Map<string, MeetingAssetView>;
  context: AgentToolExecutionContext;
  user: AgentToolUser;
  runId: string;
  itemId: string;
  meetingId: string;
}): Promise<{ imageUrls: string[]; meetingAssetsById: Map<string, MeetingAssetView> }> {
  return input.linkedAssetIds.reduce<
    Promise<{ imageUrls: string[]; meetingAssetsById: Map<string, MeetingAssetView> }>
  >(
    async (previous, assetId) => {
      const state = await previous;
      const asset = state.meetingAssetsById.get(assetId);
      if (asset === undefined) {
        throw new Error(LINEAR_TASK_REVIEW_MESSAGES.linkedScreenCaptureUnavailable);
      }
      const meetingAssetsById = asset.includeInLinear
        ? state.meetingAssetsById
        : await (async () => {
            const approvedAsset = await repositories().updateMeetingAsset({
              assetId,
              meetingId: input.meetingId,
              includeInLinear: true,
            });
            if (approvedAsset === null) {
              throw new Error(LINEAR_TASK_REVIEW_MESSAGES.linkedScreenCaptureUnavailable);
            }
            const nextMeetingAssetsById = new Map(state.meetingAssetsById);
            nextMeetingAssetsById.set(assetId, approvedAsset);

            return nextMeetingAssetsById;
          })();
      const uploadPrepared = await prepareAgentTool({
        context: input.context,
        user: input.user,
        toolName: "linear.upload_meeting_asset",
        args: { assetId },
        idempotencyKey: `linear-review:${input.runId}:asset:${input.itemId}:${assetId}`,
      });
      const uploadConfirmed = await confirmAgentTool({
        context: input.context,
        user: input.user,
        pendingInvocationId: uploadPrepared.pendingInvocationId,
        confirmationActorUserId: input.user.id,
      });
      const assetUrl = linearUploadAssetUrlFromResult(uploadConfirmed.result);
      const imageUrls = assetUrl !== null ? [...state.imageUrls, assetUrl] : state.imageUrls;

      return { imageUrls, meetingAssetsById };
    },
    Promise.resolve({ imageUrls: [] as string[], meetingAssetsById: new Map(input.meetingAssetsById) }),
  );
}

async function syncLinearTaskReviewLinkedIssueContext(input: {
  item: LinearTaskReviewItem;
  issueRef: LinearTaskReviewExternalIssue;
  context: AgentToolExecutionContext;
  user: AgentToolUser;
  run: LinearTaskReviewRun;
  imageUrls: string[];
}): Promise<void> {
  if (!linearReviewItemNeedsExistingContextSync(input.item)) {
    return;
  }
  const current = await executeAgentTool({
    context: input.context,
    user: input.user,
    toolName: "linear.get_issue",
    args: { issueId: input.issueRef.id },
    idempotencyKey: `linear-review:${input.run.id}:get:${input.item.id}:${input.issueRef.id}`,
  });
  const existingDescription = linearGetIssueDescriptionFromResult(current.result);
  const meetingContext = buildLinearIssueDescription({
    item: input.item,
    meetingId: input.run.meetingId,
    imageUrls: input.imageUrls,
  });
  const contextUpdate = appendLinearMeetingContext({
    existingDescription,
    meetingContext,
    meetingId: input.run.meetingId,
    itemId: input.item.id,
  });
  if (contextUpdate.needsUpdate) {
    const updatePrepared = await prepareAgentTool({
      context: input.context,
      user: input.user,
      toolName: "linear.update_issue",
      args: { issueId: input.issueRef.id, description: contextUpdate.description },
      idempotencyKey: `linear-review:${input.run.id}:update:${input.item.id}:${input.issueRef.id}`,
    });
    await confirmAgentTool({
      context: input.context,
      user: input.user,
      pendingInvocationId: updatePrepared.pendingInvocationId,
      confirmationActorUserId: input.user.id,
    });
  }
  await repositories().updateLinearTaskReviewItem({
    itemId: input.item.id,
    meetingContextSyncedAt: new Date(),
    syncStatus: "syncing",
    syncError: null,
  });
}

async function syncLinearTaskReviewCreatedIssueVisualEvidence(input: {
  item: LinearTaskReviewItem;
  issueRef: LinearTaskReviewExternalIssue;
  context: AgentToolExecutionContext;
  user: AgentToolUser;
  run: LinearTaskReviewRun;
  imageUrls: string[];
}): Promise<void> {
  if (input.imageUrls.length === 0 || input.item.meetingContextSyncedAt !== null) {
    return;
  }
  const current = await executeAgentTool({
    context: input.context,
    user: input.user,
    toolName: "linear.get_issue",
    args: { issueId: input.issueRef.id },
    idempotencyKey: `linear-review:${input.run.id}:evidence-get:${input.item.id}:${input.issueRef.id}`,
  });
  const existingDescription = linearGetIssueDescriptionFromResult(current.result);
  const evidenceUpdate = appendLinearVisualEvidence({
    existingDescription,
    imageUrls: input.imageUrls,
    meetingId: input.run.meetingId,
    itemId: input.item.id,
  });
  if (evidenceUpdate.needsUpdate) {
    const updatePrepared = await prepareAgentTool({
      context: input.context,
      user: input.user,
      toolName: "linear.update_issue",
      args: { issueId: input.issueRef.id, description: evidenceUpdate.description },
      idempotencyKey: `linear-review:${input.run.id}:evidence-update:${input.item.id}:${input.issueRef.id}`,
    });
    await confirmAgentTool({
      context: input.context,
      user: input.user,
      pendingInvocationId: updatePrepared.pendingInvocationId,
      confirmationActorUserId: input.user.id,
    });
  }
  await repositories().updateLinearTaskReviewItem({
    itemId: input.item.id,
    meetingContextSyncedAt: new Date(),
    syncStatus: "syncing",
    syncError: null,
  });
}

async function syncLinearTaskReviewDuplicateRelation(input: {
  item: LinearTaskReviewItem;
  issueRef: LinearTaskReviewExternalIssue;
  user: AgentToolUser;
  run: LinearTaskReviewRun;
}): Promise<void> {
  if (input.item.targetAction !== "create_duplicate") {
    return;
  }
  if (input.item.targetIssue === null) {
    throw new Error(LINEAR_TASK_REVIEW_MESSAGES.chooseCanonicalLinearIssue);
  }
  const relationId =
    input.item.relationId !== null && input.item.relationId.length > 0 ? input.item.relationId : randomUUID();
  if (input.item.relationId === null || input.item.relationId.length === 0) {
    await repositories().updateLinearTaskReviewItem({
      itemId: input.item.id,
      relationId,
      syncStatus: "syncing",
      syncError: null,
    });
  }
  const context = await agentContext({
    user: input.user,
    meetingId: input.run.meetingId,
    suffix: `duplicate:${input.run.id}:${input.item.id}`,
  });
  const prepared = await prepareAgentTool({
    context,
    user: input.user,
    toolName: "linear.create_issue_relation",
    args: {
      id: relationId,
      issueId: input.issueRef.id,
      relatedIssueId: input.item.targetIssue.id,
      type: "duplicate",
    },
    idempotencyKey: `linear-review:${input.run.id}:duplicate:${input.item.id}`,
  });
  const confirmed = await confirmAgentTool({
    context,
    user: input.user,
    pendingInvocationId: prepared.pendingInvocationId,
    confirmationActorUserId: input.user.id,
  });
  if (relationFromResult(confirmed.result) !== relationId) {
    throw new Error(LINEAR_TASK_REVIEW_MESSAGES.linearDuplicateRelationMissing);
  }
}

async function finalizeSyncedLinearTaskReviewItem(input: {
  item: LinearTaskReviewItem;
  issueRef: LinearTaskReviewExternalIssue;
  run: LinearTaskReviewRun;
  taskList: MeetingTaskListView;
  inputSnapshot: unknown[];
  persistedIssueSourceTaskIds: ReadonlySet<string>;
  user: AgentToolUser;
}): Promise<Set<string>> {
  const persistedIssueSourceTaskIds = new Set([...input.persistedIssueSourceTaskIds, ...input.item.sourceTaskIds]);
  const latestTaskList = await repositories().getMeetingTaskListForMeeting(input.run.meetingId);
  const sourceTaskIds = new Set(input.item.sourceTaskIds);
  const latestInputSnapshot = latestTaskList !== null ? createLinearTaskReviewInputSnapshot(latestTaskList.items) : [];
  const isUnaffectedTasksFresh =
    latestTaskList !== null &&
    latestTaskList.id === input.run.taskListId &&
    computeLinearTaskReviewInputSnapshotHash(latestInputSnapshot, persistedIssueSourceTaskIds) ===
      computeLinearTaskReviewInputSnapshotHash(input.inputSnapshot, persistedIssueSourceTaskIds);
  if (
    latestTaskList === null ||
    !isUnaffectedTasksFresh ||
    !linearTaskReviewSourceTasksAreFresh(input.inputSnapshot, latestTaskList.items, sourceTaskIds)
  ) {
    throw new Error(LINEAR_TASK_REVIEW_MESSAGES.tasksChangedAfterConfirmation);
  }
  const expectedRevisions = Object.fromEntries(
    latestTaskList.items.filter((task) => sourceTaskIds.has(task.id)).map((task) => [task.id, task.revision]),
  );
  await repositories().deleteMeetingTasksByIds({
    meetingId: input.run.meetingId,
    taskIds: input.item.sourceTaskIds,
    actorUserId: input.user.id,
    expectedRevisions,
  });
  await repositories().updateLinearTaskReviewItem({
    itemId: input.item.id,
    syncStatus: "created",
    externalIssue: input.issueRef,
    syncError: null,
  });

  return persistedIssueSourceTaskIds;
}

async function persistLinkedLinearSyncIssue(input: {
  item: LinearTaskReviewItem;
  issue: LinearTaskReviewExternalIssue;
}): Promise<LinearTaskReviewExternalIssue> {
  await repositories().updateLinearTaskReviewItem({
    itemId: input.item.id,
    syncStatus: "syncing",
    externalIssue: input.issue,
    syncError: null,
  });

  return input.issue;
}

async function createPersistedLinearSyncIssue(input: {
  item: LinearTaskReviewItem;
  context: AgentToolExecutionContext;
  user: AgentToolUser;
  run: LinearTaskReviewRun;
  fallbackTeam: LinearTaskReviewTeam;
}): Promise<LinearTaskReviewExternalIssue> {
  const description = buildLinearIssueDescription({
    item: input.item,
    meetingId: input.run.meetingId,
  });
  const prepared = await prepareAgentTool({
    context: input.context,
    user: input.user,
    toolName: "linear.create_issue",
    args: { teamId: input.item.teamId ?? input.fallbackTeam.id, title: input.item.title, description },
    idempotencyKey: `linear-review:${input.run.id}:create:${input.item.id}`,
  });
  const confirmed = await confirmAgentTool({
    context: input.context,
    user: input.user,
    pendingInvocationId: prepared.pendingInvocationId,
    confirmationActorUserId: input.user.id,
  });
  const issue = issueFromResult(confirmed.result);
  if (issue === null) {
    throw new Error(LINEAR_TASK_REVIEW_MESSAGES.linearIssueCreationReturnedNoIssue);
  }
  await repositories().updateLinearTaskReviewItem({
    itemId: input.item.id,
    syncStatus: "syncing",
    externalIssue: issue,
    syncError: null,
  });

  return issue;
}

async function ensureLinearTaskReviewSyncIssue(input: {
  item: LinearTaskReviewItem;
  externalIssue: LinearTaskReviewExternalIssue | null;
  context: AgentToolExecutionContext;
  user: AgentToolUser;
  run: LinearTaskReviewRun;
  fallbackTeam: LinearTaskReviewTeam;
}): Promise<LinearTaskReviewExternalIssue> {
  const shouldLinkExisting = input.item.targetAction === "link_existing" && input.externalIssue === null;
  const linkedIssue = shouldLinkExisting
    ? (() => {
        if (input.item.targetIssue === null) {
          throw new Error(LINEAR_TASK_REVIEW_MESSAGES.chooseExistingLinearIssueToLink);
        }

        return input.item.targetIssue;
      })()
    : input.externalIssue;
  const issueAfterLink =
    shouldLinkExisting && linkedIssue !== null
      ? await persistLinkedLinearSyncIssue({ item: input.item, issue: linkedIssue })
      : linkedIssue;
  const issue = linearReviewItemNeedsIssueCreation(input.item)
    ? await createPersistedLinearSyncIssue({
        item: input.item,
        context: input.context,
        user: input.user,
        run: input.run,
        fallbackTeam: input.fallbackTeam,
      })
    : issueAfterLink;
  if (issue === null) {
    throw new Error(LINEAR_TASK_REVIEW_MESSAGES.linearIssueStateNotPersisted);
  }

  return issue;
}

async function syncLinearTaskReviewCandidateItem(input: {
  item: LinearTaskReviewItem;
  run: LinearTaskReviewRun;
  taskList: MeetingTaskListView;
  inputSnapshot: unknown[];
  user: AgentToolUser;
  fallbackTeam: LinearTaskReviewTeam;
  meetingAssetsById: Map<string, MeetingAssetView>;
  persistedIssueSourceTaskIds: ReadonlySet<string>;
}): Promise<{ meetingAssetsById: Map<string, MeetingAssetView>; persistedIssueSourceTaskIds: Set<string> }> {
  await repositories().updateLinearTaskReviewItem({ itemId: input.item.id, syncStatus: "syncing", syncError: null });
  const context = await agentContext({
    user: input.user,
    meetingId: input.run.meetingId,
    suffix: `sync:${input.run.id}:${input.item.id}`,
  });
  const linkedAssetIds = linearTaskLinkedMeetingAssetIds({
    tasks: input.taskList.items,
    sourceTaskIds: input.item.sourceTaskIds,
    meetingAssetIds: input.meetingAssetsById.keys(),
  });
  const issue = await ensureLinearTaskReviewSyncIssue({
    item: input.item,
    externalIssue: input.item.externalIssue,
    context,
    user: input.user,
    run: input.run,
    fallbackTeam: input.fallbackTeam,
  });
  const uploadResult = await uploadLinearTaskReviewLinkedAssetUrls({
    linkedAssetIds,
    meetingAssetsById: input.meetingAssetsById,
    context,
    user: input.user,
    runId: input.run.id,
    itemId: input.item.id,
    meetingId: input.run.meetingId,
  });
  const imageUrls = uploadResult.imageUrls;
  const meetingAssetsById = uploadResult.meetingAssetsById;
  if (input.item.targetAction === "link_existing") {
    await syncLinearTaskReviewLinkedIssueContext({
      item: input.item,
      issueRef: issue,
      context,
      user: input.user,
      run: input.run,
      imageUrls,
    });
  } else {
    await syncLinearTaskReviewCreatedIssueVisualEvidence({
      item: input.item,
      issueRef: issue,
      context,
      user: input.user,
      run: input.run,
      imageUrls,
    });
  }
  await syncLinearTaskReviewDuplicateRelation({
    item: input.item,
    issueRef: issue,
    user: input.user,
    run: input.run,
  });
  const persistedIssueSourceTaskIds = await finalizeSyncedLinearTaskReviewItem({
    item: input.item,
    issueRef: issue,
    run: input.run,
    taskList: input.taskList,
    inputSnapshot: input.inputSnapshot,
    persistedIssueSourceTaskIds: input.persistedIssueSourceTaskIds,
    user: input.user,
  });

  return { meetingAssetsById, persistedIssueSourceTaskIds };
}

async function runLinearTaskReviewSyncWork(input: {
  run: LinearTaskReviewRun;
  syncing: LinearTaskReviewRun;
  taskList: MeetingTaskListView;
  inputSnapshot: unknown[];
  user: AgentToolUser;
}): Promise<LinearTaskReviewRunView> {
  const preflight = await loadTeams({ run: input.syncing, user: input.user });
  if (preflight === null) {
    const latest = await repositories().getLinearTaskReviewById(input.run.id);
    if (latest === null) {
      throw new Error(LINEAR_TASK_REVIEW_MESSAGES.reviewRunNotFound);
    }

    return latest;
  }
  const candidates = input.syncing.items.filter((item) => item.included && item.syncStatus !== "created");
  const meetingAssetsById = new Map(
    (await repositories().listMeetingAssets(input.run.meetingId)).map((asset) => [asset.id, asset]),
  );
  const failures = { count: 0 };
  const fallbackTeam = preflight.teams[0];
  if (fallbackTeam === undefined) {
    throw new Error(LINEAR_TASK_REVIEW_MESSAGES.noLinearTeamsAvailable);
  }
  await candidates.reduce<
    Promise<{
      meetingAssetsById: Map<string, MeetingAssetView>;
      persistedIssueSourceTaskIds: Set<string>;
    }>
  >(
    async (previousState, item) => {
      const state = await previousState;
      try {
        const syncResult = await syncLinearTaskReviewCandidateItem({
          item,
          run: input.run,
          taskList: input.taskList,
          inputSnapshot: input.inputSnapshot,
          user: input.user,
          fallbackTeam,
          meetingAssetsById: state.meetingAssetsById,
          persistedIssueSourceTaskIds: state.persistedIssueSourceTaskIds,
        });

        return {
          meetingAssetsById: syncResult.meetingAssetsById,
          persistedIssueSourceTaskIds: syncResult.persistedIssueSourceTaskIds,
        };
      } catch (error) {
        failures.count += 1;
        await repositories().updateLinearTaskReviewItem({
          itemId: item.id,
          syncStatus: "failed",
          syncError: error instanceof Error ? error.message : LINEAR_TASK_REVIEW_MESSAGES.linearIssueSyncFailed,
        });

        return state;
      }
    },
    Promise.resolve({
      meetingAssetsById,
      persistedIssueSourceTaskIds: new Set(
        input.syncing.items
          .filter((syncItem) => syncItem.included && syncItem.externalIssue !== null)
          .flatMap((syncItem) => syncItem.sourceTaskIds),
      ),
    }),
  );
  const final = await repositories().updateLinearTaskReviewRun({
    runId: input.run.id,
    status: failures.count === 0 ? "completed" : "awaiting_user",
    phase: failures.count === 0 ? "complete" : "partial_failure",
    error:
      failures.count === 0
        ? null
        : `${failures.count} Linear issue${failures.count === 1 ? "" : "s"} could not be finished`,
    completedAt: failures.count === 0 ? new Date() : null,
  });
  await emitReviewUpdate({ run: final, eventName: "task.linear_review.updated" });

  return final;
}

export async function syncLinearTaskReview(input: {
  runId: string;
  userId: string;
}): Promise<LinearTaskReviewRunView | null> {
  const run = await repositories().getLinearTaskReviewById(input.runId);
  if (run === null || run.userId !== input.userId) {
    throw new Error(LINEAR_TASK_REVIEW_MESSAGES.linearTaskReviewNotFound);
  }
  if (!(await canUseLinearTaskReviewForMeeting(run.meetingId, input.userId))) {
    throw new Error(LINEAR_TASK_REVIEW_MESSAGES.meetingNotesLocked);
  }
  const syncing = await repositories().claimLinearTaskReviewRunAction({
    runId: run.id,
    status: "syncing",
    phase: "creating_issues",
  });
  if (syncing === null) {
    return repositories().getLinearTaskReviewById(run.id);
  }
  await emitReviewUpdate({ run: syncing, eventName: "task.linear_review.updated" });
  const [taskList, inputSnapshot] = await Promise.all([
    repositories().getMeetingTaskListForMeeting(run.meetingId),
    repositories().getLinearTaskReviewInputSnapshot(run.id),
  ]);
  const persistedIssueSourceTaskIds = new Set(
    syncing.items.filter((item) => item.included && item.externalIssue !== null).flatMap((item) => item.sourceTaskIds),
  );
  const isInputMatching =
    taskList !== null &&
    isLinearTaskReviewInputSnapshotMatching({
      taskList,
      run,
      inputSnapshot,
      persistedIssueSourceTaskIds,
    });
  if (taskList === null || taskList.id !== run.taskListId || !isInputMatching) {
    const stale = await repositories().updateLinearTaskReviewRun({
      runId: run.id,
      status: "stale",
      phase: "stale",
      error: LINEAR_TASK_REVIEW_MESSAGES.tasksChangedBeforeIssueCreation,
      completedAt: new Date(),
    });
    await emitReviewUpdate({ run: stale, eventName: "task.linear_review.updated" });
    await enqueueLinearTaskReviewIfEligible(run.meetingId);

    return stale;
  }
  const user = await requireRunUser(run);
  try {
    return await runLinearTaskReviewSyncWork({
      run,
      syncing,
      taskList,
      inputSnapshot,
      user,
    });
  } catch (error) {
    const failed = await repositories().updateLinearTaskReviewRun({
      runId: run.id,
      status: "awaiting_user",
      phase: "sync_failed",
      error: error instanceof Error ? error.message : LINEAR_TASK_REVIEW_MESSAGES.linearReviewSyncFailed,
    });
    await emitReviewUpdate({ run: failed, eventName: "task.linear_review.updated" });
    throw error;
  }
}

export const linearTaskReviewTestInternals = {
  linearTaskLinkedMeetingAssetIds,
  rankDuplicateIssueSearchResults,
  recommendedExistingIssue,
  sanitizeCandidates,
};

registerRequestWorkflowHandler({
  type: "review_linear_tasks",
  handler: ({ job, logger }) => runLinearTaskReviewJob({ job, logger }),
});
