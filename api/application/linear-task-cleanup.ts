import type { BugReportIssueDraft, MeetingTask, MeetingTaskSourceQuote } from "@readymeet/shared";

import { repositories } from "../ports/repository-runtime";

const MOVABLE_TASK_WORK_KINDS = new Set<MeetingTask["workKind"]>(["bug_or_issue", "implementation"]);
const MOVABLE_TASK_STATUSES = new Set<MeetingTask["status"]>(["open", "completed"]);
const MIN_MATCH_TOKEN_LENGTH = 4;
const MIN_EVIDENCE_TEXT_LENGTH = 20;
const TITLE_OVERLAP_WITH_EVIDENCE_THRESHOLD = 0.18;
const BODY_OVERLAP_WITH_EVIDENCE_THRESHOLD = 0.32;
const BUG_TITLE_OVERLAP_THRESHOLD = 0.55;
const BUG_BODY_OVERLAP_THRESHOLD = 0.62;

const MATCH_STOP_WORDS = new Set([
  "able",
  "about",
  "after",
  "also",
  "and",
  "are",
  "bug",
  "bugs",
  "can",
  "create",
  "draft",
  "fix",
  "for",
  "from",
  "into",
  "issue",
  "issues",
  "linear",
  "need",
  "needs",
  "related",
  "should",
  "task",
  "tasks",
  "that",
  "the",
  "this",
  "ticket",
  "tickets",
  "with",
]);

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenSet(value: string): Set<string> {
  return new Set(
    normalizeForMatch(value)
      .split(/\s+/)
      .map((word) => word.trim())
      .filter((word) => word.length >= MIN_MATCH_TOKEN_LENGTH && !MATCH_STOP_WORDS.has(word)),
  );
}

function containmentScore(input: { left: string; right: string }): number {
  const leftTokens = tokenSet(input.left);
  const rightTokens = tokenSet(input.right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;

  return shared / Math.min(leftTokens.size, rightTokens.size);
}

function textIncludesEvidence(input: { left: string; right: string }): boolean {
  const leftText = normalizeForMatch(input.left);
  const rightText = normalizeForMatch(input.right);
  if (leftText.length < MIN_EVIDENCE_TEXT_LENGTH || rightText.length < MIN_EVIDENCE_TEXT_LENGTH) {
    return false;
  }

  return leftText.includes(rightText) || rightText.includes(leftText);
}

function issueEvidenceTexts(issue: BugReportIssueDraft): string[] {
  return [...issue.evidence, ...issue.evidenceSpans.map((span) => span.excerpt)].filter(
    (item) => item.trim().length > 0,
  );
}

function issueSegmentIds(issue: BugReportIssueDraft): Set<string> {
  return new Set(issue.evidenceSpans.flatMap((span) => span.segmentIds));
}

function taskEvidenceTexts(task: MeetingTask): string[] {
  return task.sourceQuotes.map((quote) => quote.quote).filter((item) => item.trim().length > 0);
}

function taskSegmentIds(task: MeetingTask): Set<string> {
  return new Set(
    task.sourceQuotes
      .map((quote: MeetingTaskSourceQuote) => quote.segmentId ?? null)
      .filter((segmentId): segmentId is string => segmentId !== null && segmentId.length > 0),
  );
}

function hasSegmentOverlap(input: { issue: BugReportIssueDraft; task: MeetingTask }): boolean {
  const issueSegments = issueSegmentIds(input.issue);
  if (issueSegments.size === 0) {
    return false;
  }

  return [...taskSegmentIds(input.task)].some((segmentId) => issueSegments.has(segmentId));
}

function hasEvidenceTextOverlap(input: { issue: BugReportIssueDraft; task: MeetingTask }): boolean {
  const taskTexts = taskEvidenceTexts(input.task);
  const issueTexts = issueEvidenceTexts(input.issue);

  return taskTexts.some((taskText) =>
    issueTexts.some((issueText) => textIncludesEvidence({ left: taskText, right: issueText })),
  );
}

function issueSearchText(issue: BugReportIssueDraft): string {
  return [
    issue.title,
    issue.description,
    issue.impact,
    issue.reproductionContext,
    issue.scopeReason,
    ...issue.evidence,
    ...issue.evidenceSpans.map((span) => span.excerpt),
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");
}

function taskSearchText(task: MeetingTask): string {
  return [task.title, task.description, task.sourceReason, ...task.sourceQuotes.map((quote) => quote.quote)]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");
}

function shouldMoveTaskForIssue(input: { task: MeetingTask; issue: BugReportIssueDraft }): boolean {
  if (!MOVABLE_TASK_STATUSES.has(input.task.status) || !MOVABLE_TASK_WORK_KINDS.has(input.task.workKind)) {
    return false;
  }

  const isSegmentOverlap = hasSegmentOverlap({ issue: input.issue, task: input.task });
  const hasEvidenceOverlap = isSegmentOverlap || hasEvidenceTextOverlap({ issue: input.issue, task: input.task });
  const titleOverlap = containmentScore({ left: input.task.title, right: input.issue.title });
  const bodyOverlap = containmentScore({ left: taskSearchText(input.task), right: issueSearchText(input.issue) });

  if (
    hasEvidenceOverlap &&
    (titleOverlap >= TITLE_OVERLAP_WITH_EVIDENCE_THRESHOLD || bodyOverlap >= BODY_OVERLAP_WITH_EVIDENCE_THRESHOLD)
  ) {
    return true;
  }

  if (input.task.workKind === "bug_or_issue" && titleOverlap >= BUG_TITLE_OVERLAP_THRESHOLD) {
    return true;
  }

  return input.task.workKind === "bug_or_issue" && bodyOverlap >= BUG_BODY_OVERLAP_THRESHOLD;
}

export function findNativeTaskIdsMovedToLinear(input: {
  tasks: MeetingTask[];
  issueDrafts: BugReportIssueDraft[];
}): string[] {
  return input.tasks
    .filter((task) => input.issueDrafts.some((issue) => shouldMoveTaskForIssue({ task, issue })))
    .map((task) => task.id);
}

export async function moveSyncedLinearTasksOutOfReady(input: {
  meetingId: string;
  issueDrafts: BugReportIssueDraft[];
}): Promise<string[]> {
  const taskList = await repositories().getMeetingTaskListForMeeting(input.meetingId);
  if (taskList === null || input.issueDrafts.length === 0) {
    return [];
  }

  const taskIds = findNativeTaskIdsMovedToLinear({
    tasks: taskList.items,
    issueDrafts: input.issueDrafts,
  });

  return repositories().deleteMeetingTasksByIds({
    meetingId: input.meetingId,
    taskIds,
  });
}
