import type { RepositoryPort } from "@readymeet/db/ports/repository";
import {
  type BugReportDraft,
  type BugReportDraftRevisionResponse,
  bugReportDraftRevisionResponseSchema,
  bugReportDraftSchema,
  type BugReportEvidenceBankItem,
  bugReportEvidenceBankItemSchema,
  type BugReportIssueDraft,
  bugReportIssueDraftSchema,
  type BugReportIssueEvidenceSpan,
  type BugReportIssuePlanCandidate,
  bugReportIssuePlanningResponseSchema,
  type BugReportLinearContext,
  bugReportLinearContextSchema,
  type BugReportPlan,
  bugReportPlanSchema,
  type BugReportSkippedCandidate,
  type CapabilityWorkflowRun,
  type LinearIssueResult,
  linearIssueResultSchema,
  type MeetingCoachingFeedback,
  meetingCoachingFeedbackSchema,
  meetingCoachingGenerationResponseSchema,
  type SourceSpan,
} from "@readymeet/shared";

import {
  filterDraftDuplicateIdsToContext,
  isRelatedIssueUnlinkInstruction,
  RELATED_ISSUE_UNCLEAR_SUMMARY,
  unlinkRelatedLinearIssues,
} from "../domain/bug-report-related-issues";
import {
  triggerBugReportDraftRevision,
  triggerBugReportIssuePlanning,
  triggerMeetingCoachingFeedback,
} from "../ports/gate-assistant-client";
import { decryptJsonSecret, encryptJsonSecret } from "../ports/gate-secret-crypto";
import { repositories } from "../ports/repository-runtime";

import {
  type AgentToolExecutionContext,
  confirmAgentTool,
  executeAgentTool,
  prepareAgentTool,
} from "./agent-tool-broker";
import { type LinearTokenSet, refreshLinearToken } from "./linear-client";
import { moveSyncedLinearTasksOutOfReady } from "./linear-task-cleanup";

const BUG_REPORT_CAPABILITY_KEY = "file_issue_or_bug";
const MEETING_COACHING_CAPABILITY_KEY = "meeting_coaching";

const REQUESTER_TRANSCRIPT_CONTEXT_OFFSET_START = -2;
const REQUESTER_TRANSCRIPT_CONTEXT_OFFSET_END = 2;
const DOUBLE_QUOTE_CHAR_CODE = 34;
const REQUESTER_TRANSCRIPT_FALLBACK_SEGMENT_LIMIT = 40;
const REQUESTER_TRANSCRIPT_CONTEXT_SEGMENT_LIMIT = 90;
const COACHING_TASK_SUMMARY_LIMIT = 12;
const BUG_ISSUE_BATCH_LIMIT = 8;
const MIN_SIGNAL_ISSUE_TITLE_LENGTH = 12;
const REQUESTER_TURNS_CONTEXT_LIMIT = 60;
const EVIDENCE_BANK_ITEM_LIMIT = 40;
const MIN_OVERLAP_WORD_LENGTH = 5;
const GROUNDED_DESCRIPTION_TRUNCATE_LENGTH = 220;
const BEST_EVIDENCE_MATCH_LIMIT = 3;
const ISSUE_TITLE_TRUNCATE_LENGTH = 180;
const ISSUE_SEARCH_TERMS_LIMIT = 4;
const ISSUE_MATCH_MIN_WORD_LENGTH = 3;
const ISSUE_MATCH_EXACT_TITLE_BONUS = 5;
const ISSUE_MATCH_SECONDARY_SCORE_THRESHOLD = 2;
const ORDINAL_INDEX_SECOND = 1;
const ORDINAL_INDEX_THIRD = 2;
const ORDINAL_INDEX_FOURTH = 3;
const ORDINAL_INDEX_FIFTH = 4;
const ORDINAL_INDEX_SIXTH = 5;
const ORDINAL_INDEX_SEVENTH = 6;
const ORDINAL_INDEX_EIGHTH = 7;
const NUMBER_WORD_TWO = 2;
const NUMBER_WORD_THREE = 3;
const NUMBER_WORD_FOUR = 4;
const NUMBER_WORD_FIVE = 5;
const NUMBER_WORD_SIX = 6;
const NUMBER_WORD_SEVEN = 7;
const NUMBER_WORD_EIGHT = 8;
const LINEAR_SEARCH_TERM_MIN_LENGTH = 4;
const LINEAR_SEARCH_TERM_MAX_LENGTH = 80;
const LINEAR_SEARCH_TERMS_LIMIT = 5;
const LINEAR_SAMPLE_DESCRIPTION_MIN_LENGTH = 220;
const LINEAR_SAMPLE_USEFUL_MIN_COUNT = 3;
const LINEAR_DUPLICATE_RESULTS_LIMIT = 3;
const LINEAR_DUPLICATE_CONTEXT_LIMIT = 10;
const LINEAR_TOKEN_REFRESH_WINDOW_MS = 60_000;
const WORKFLOW_UTTERANCE_ID_MAX_LENGTH = 160;
const TRUNCATE_ELLIPSIS_LENGTH = 1;

const CAPABILITY_WORKFLOW_LOG = {
  issuePlanningFallback:
    "[capability-workflow] Bug report issue planning failed, falling back to deterministic candidates.",
  creditUsageFailed: "[capability-workflow] Failed to record AI credit usage.",
  revisionFallback: "[capability-workflow] Bug report draft revision failed; trying deterministic fallback.",
  revisionValidationFailed: "[capability-workflow] Deterministic bug report draft revision failed validation.",
  nativeTaskCleanupFailed: "[capability-workflow] Failed to move synced Linear tasks out of Ready tasks.",
} as const;

const CAPABILITY_WORKFLOW_MESSAGES = {
  transcriptSegmentNotFound: "Transcript segment was not found",
  meetingNotFound: "Meeting not found",
  revisedDraftNeedsIssue: "A revised Linear draft must include at least one grounded issue",
  selectedIssueNotFound: "Selected issue was not found",
  restoredIssueNotFound: "Restored issue was not found",
  noGroundedIssuesReadyToSync: "No grounded Linear issues are ready to sync",
  recommendationNotFound: "Recommendation not found",
  bugReportOnly: "Only Bug Report workflows are supported right now",
  meetingFeedbackOnlyPath: "Only Meeting Feedback workflows are supported by this path",
  workflowNotBuilt: "This workflow is not built yet",
  bugReportDraftOnly: "Only Bug Report drafts can be updated directly",
  bugReportSyncOnly: "Only Bug Report workflows can sync with Linear",
  chooseLinearTeam: "Choose a Linear team before syncing",
  linearIssueCreateEmpty: "Linear issueCreate returned no issue",
  linearSyncEmpty: "Linear sync returned no issue",
  workflowNotFound: "Workflow not found",
  linearNotConnected: "Linear is not connected",
  bugReportWorkflowFailed: "Bug Report workflow failed",
  meetingFeedbackFailed: "Meeting feedback failed",
  linearSyncFailed: "Linear sync failed",
  defaultBugTitle: "Bug surfaced in meeting",
  possibleBugTitle: "Possible bug",
  possibleBugsFromMeetingTitle: "Possible bugs from meeting",
  skippedNoEvidenceMatch: "Skipped because no verified transcript evidence matched this possible issue.",
  skippedNoEvidenceAvailable: "Skipped because no verified transcript evidence was available.",
  noVerifiedEvidenceSummary: "No verified transcript evidence was available for Linear drafts.",
  skippedPlannerNoEvidence: "Skipped because the planner did not attach verified transcript evidence.",
  scopeReasonFromRecommendation:
    "Prepared from the existing bug recommendation and matched to verified meeting evidence.",
  noGroundedCandidatesSummary: "No grounded issue candidates could be prepared.",
  noGroundedLinearIssuesSummary: "No grounded Linear issues could be prepared from the verified meeting evidence.",
  highImpactFromEvidence: "High priority or customer impact was supported by the meeting evidence.",
  impactConfirmFromEvidence: "Impact should be confirmed from the meeting evidence below.",
  impactConfirmBeforePrioritization: "Impact should be confirmed before prioritization.",
  emptyDraftTitle: "No grounded Linear drafts",
  emptyDraftDescription: "No Linear issue drafts passed evidence validation.",
  emptyDraftImpact: "No synced issue is recommended without verified transcript evidence.",
  emptyDraftScopeReason: "No candidate had enough verified transcript evidence to become a Linear issue.",
  meetingEvidencePrefix: "Meeting evidence: ",
  connectLinearNote: "Connect Linear to search for duplicates and learn ticket conventions.",
  noLinearSamplesNote: "No existing Linear issues were available to learn from.",
  goodLinearSamplesNote: "Existing issues include useful structure, so Ready will mirror the clear sections.",
  poorLinearSamplesNote:
    "Existing issues looked light on reproduction or impact detail, so Ready will use a stronger bug template.",
  linearSuggestedSections: ["Impact", "Reproduction", "Evidence", "Possible duplicates"],
  reproductionNotCaptured: "Not captured yet.",
  noDirectEvidenceCaptured: "- No direct evidence excerpts were captured.",
  noDuplicatesFoundNote: "- None found during the ReadyMeet Linear search.",
  duplicateRationale:
    "Possible duplicates are shown so you can avoid creating parallel work or include references in the new issue.",
  nativeTaskCleanupWarning: "Linear issues were created, but matching Ready tasks could not be moved out.",
  linearIssueDraftingLabel: "Linear issue drafting",
  meetingFeedbackLabel: "Meeting feedback",
  meetingFeedbackFollowUpLabel: "Meeting feedback follow-up",
  syncedSingleIssueFallback: "the issue",
} as const;

function issueNeedsEvidenceBeforeSaveMessage(title: string) {
  const quote = String.fromCharCode(DOUBLE_QUOTE_CHAR_CODE);

  return [quote, title, quote, " needs verified transcript evidence before it can be saved"].join("");
}

function issueNeedsEvidenceBeforeSyncMessage(title: string) {
  const quote = String.fromCharCode(DOUBLE_QUOTE_CHAR_CODE);

  return [quote, title, quote, " needs verified transcript evidence before syncing"].join("");
}

function preparedGroundedIssuesSummary(count: number) {
  const noun = count === 1 ? "candidate" : "candidates";

  return ["Prepared ", String(count), " grounded issue ", noun, "."].join("");
}

function listedDraftIssuesSummary(input: { count: number; issueWord: string }) {
  return ["Listed ", String(input.count), " draft ", input.issueWord, " for review."].join("");
}

function restoredAllIssuesSummary(input: { count: number; issueWord: string }) {
  return ["Restored all ", String(input.count), " draft ", input.issueWord, "."].join("");
}

function keptOnlyIssueSummary(title: string) {
  const quote = String.fromCharCode(DOUBLE_QUOTE_CHAR_CODE);

  return ["Kept only ", quote, title, quote, "."].join("");
}

function keptOnlySelectedIssuesSummary(input: { count: number; issueWord: string }) {
  return ["Kept only ", String(input.count), " selected draft ", input.issueWord, "."].join("");
}

function addedIssueBackSummary(title: string) {
  const quote = String.fromCharCode(DOUBLE_QUOTE_CHAR_CODE);

  return ["Added ", quote, title, quote, " back to the draft list."].join("");
}

function addedIssuesBackSummary(input: { count: number; issueWord: string }) {
  return ["Added ", String(input.count), " draft ", input.issueWord, " back to the list."].join("");
}

function keptPositionIssuesSummary(input: { position: string; count: number; issueWord: string }) {
  return ["Kept the ", input.position, " ", String(input.count), " draft ", input.issueWord, "."].join("");
}

function removedSingleIssueSummary(input: { title: string; remainingCount: number; issueWord: string }) {
  const quote = String.fromCharCode(DOUBLE_QUOTE_CHAR_CODE);

  return [
    "Removed ",
    quote,
    input.title,
    quote,
    " and kept ",
    String(input.remainingCount),
    " draft ",
    input.issueWord,
    ".",
  ].join("");
}

function removedMultipleIssuesSummary(input: { removedCount: number; removedWord: string; remainingCount: number }) {
  return [
    "Removed ",
    String(input.removedCount),
    " draft ",
    input.removedWord,
    " and kept ",
    String(input.remainingCount),
    ".",
  ].join("");
}

function matchedSearchTermRationale(term: string) {
  const quote = String.fromCharCode(DOUBLE_QUOTE_CHAR_CODE);

  return ["Matched the issue-specific search term ", quote, term, quote, "."].join("");
}

function syncedSingleIssueContent(identifier: string) {
  return ["Synced ", identifier, " to Linear."].join("");
}

function syncedMultipleIssuesContent(count: number) {
  return ["Synced ", String(count), " issues to Linear."].join("");
}

type WorkflowUser = {
  id: string;
  email: string;
  displayName: string;
};

type CapabilityWorkflowMessage = Awaited<ReturnType<RepositoryPort["listCapabilityWorkflowMessages"]>>[number];

type CapabilityWorkflowWithMessages = {
  workflow: CapabilityWorkflowRun;
  messages: CapabilityWorkflowMessage[];
};

type Recommendation = NonNullable<Awaited<ReturnType<RepositoryPort["getRecommendationById"]>>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringValue(input: { value: unknown; fallback?: string }) {
  const fallback = input.fallback ?? "";

  return typeof input.value === "string" && input.value.trim().length > 0 ? input.value.trim() : fallback;
}

function severityValue(value: unknown): BugReportDraft["severity"] {
  const normalized = stringValue({ value, fallback: "medium" }).toLowerCase();

  return normalized === "low" || normalized === "high" ? normalized : "medium";
}

function truncate(input: { value: string; maxLength: number }) {
  if (input.value.length <= input.maxLength) {
    return input.value;
  }

  return `${input.value.slice(0, input.maxLength - TRUNCATE_ELLIPSIS_LENGTH).trim()}...`;
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeEvidenceText(value: string) {
  return normalizeWhitespace(value).toLowerCase();
}

function formatSegmentTimestamp(date: Date) {
  return date.toISOString();
}

type TranscriptData = NonNullable<Awaited<ReturnType<RepositoryPort["getTranscriptForMeeting"]>>>;
type TranscriptSegment = TranscriptData["segments"][number];

function compactTranscriptSegment(segment: TranscriptSegment) {
  return {
    id: segment.id,
    speakerUserId: segment.speakerUserId,
    speakerName: segment.speakerName,
    content: segment.content,
    startedAt: formatSegmentTimestamp(segment.startedAt),
    endedAt: segment.endedAt ? formatSegmentTimestamp(segment.endedAt) : null,
  };
}

function buildRequesterContextSegments(input: { segments: TranscriptSegment[]; requesterUserId: string }) {
  const selectedIndexes = new Set<number>();
  input.segments.forEach((segment, index) => {
    if (segment.speakerUserId !== input.requesterUserId) {
      return;
    }
    Array.from(
      { length: REQUESTER_TRANSCRIPT_CONTEXT_OFFSET_END - REQUESTER_TRANSCRIPT_CONTEXT_OFFSET_START + 1 },
      (_unused, offsetIndex) => REQUESTER_TRANSCRIPT_CONTEXT_OFFSET_START + offsetIndex,
    ).forEach((offset) => {
      const candidateIndex = index + offset;
      if (candidateIndex >= 0 && candidateIndex < input.segments.length) {
        selectedIndexes.add(candidateIndex);
      }
    });
  });

  if (selectedIndexes.size === 0) {
    input.segments.slice(0, REQUESTER_TRANSCRIPT_FALLBACK_SEGMENT_LIMIT).forEach((_segment, index) => {
      selectedIndexes.add(index);
    });
  }

  return [...selectedIndexes]
    .sort((left, right) => left - right)
    .slice(0, REQUESTER_TRANSCRIPT_CONTEXT_SEGMENT_LIMIT)
    .map((index) => {
      const segment = input.segments[index];
      if (segment === undefined) {
        throw new Error(CAPABILITY_WORKFLOW_MESSAGES.transcriptSegmentNotFound);
      }

      return compactTranscriptSegment(segment);
    });
}

function taskSummaryForCoaching(tasks: Awaited<ReturnType<RepositoryPort["getMeetingTaskListForMeeting"]>>) {
  if (tasks === null || tasks.items.length === 0) {
    return [];
  }

  return tasks.items
    .filter((task) => task.status !== "dismissed")
    .slice(0, COACHING_TASK_SUMMARY_LIMIT)
    .map((task) => ({
      title: task.title,
      description: task.description,
      owner: task.owner.name,
      status: task.status,
      type: task.type,
      workKind: task.workKind,
    }));
}

function filterFeedbackEvidenceToTranscript(input: {
  feedback: MeetingCoachingFeedback;
  transcriptData: TranscriptData | null;
}): MeetingCoachingFeedback {
  const { feedback, transcriptData } = input;
  if (!transcriptData) {
    return {
      ...feedback,
      whatWorked: feedback.whatWorked.map((point) => ({ ...point, evidence: [] })),
      whatToImprove: feedback.whatToImprove.map((point) => ({ ...point, evidence: [] })),
      tryNextTime: feedback.tryNextTime.map((point) => ({ ...point, evidence: [] })),
      detailParagraphs: feedback.detailParagraphs.map((paragraph) => ({ ...paragraph, evidence: [] })),
    };
  }

  const transcriptText = normalizeEvidenceText(transcriptData.segments.map((segment) => segment.content).join(" "));
  const filterPoint = (point: MeetingCoachingFeedback["whatWorked"][number]) => ({
    ...point,
    evidence: point.evidence.filter((snippet) => transcriptText.includes(normalizeEvidenceText(snippet.quote))),
  });
  const filterDetailParagraph = (paragraph: MeetingCoachingFeedback["detailParagraphs"][number]) => ({
    ...paragraph,
    evidence: paragraph.evidence.filter((snippet) => transcriptText.includes(normalizeEvidenceText(snippet.quote))),
  });

  return {
    ...feedback,
    whatWorked: feedback.whatWorked.map(filterPoint),
    whatToImprove: feedback.whatToImprove.map(filterPoint),
    tryNextTime: feedback.tryNextTime.map(filterPoint),
    detailParagraphs: feedback.detailParagraphs.map(filterDetailParagraph),
  };
}

function requireMeetingOwnedByUser(input: {
  meeting: Awaited<ReturnType<RepositoryPort["getMeetingById"]>>;
  userId: string;
}) {
  if (input.meeting === null || input.meeting.createdByUserId !== input.userId) {
    throw new Error(CAPABILITY_WORKFLOW_MESSAGES.meetingNotFound);
  }

  return input.meeting;
}

async function buildMeetingCoachingContext(input: { user: WorkflowUser; recommendation: Recommendation }) {
  const [meeting, extraction, transcriptData, participants, summary, tasks] = await Promise.all([
    repositories().getMeetingById(input.recommendation.meetingId),
    repositories().getExtractionById(input.recommendation.extractionId),
    repositories().getTranscriptForMeeting(input.recommendation.meetingId),
    repositories().listParticipantsForMeeting(input.recommendation.meetingId),
    repositories().getSummaryForMeeting(input.recommendation.meetingId),
    repositories().getMeetingTaskListForMeeting(input.recommendation.meetingId),
  ]);

  const ownedMeeting = requireMeetingOwnedByUser({ meeting, userId: input.user.id });

  const requesterParticipant = participants.find((participant) => participant.userId === input.user.id);
  const requesterTurns = transcriptData?.segments.filter((segment) => segment.speakerUserId === input.user.id) ?? [];
  const contextSegments =
    transcriptData !== null
      ? buildRequesterContextSegments({ segments: transcriptData.segments, requesterUserId: input.user.id })
      : [];

  return {
    provider: MEETING_COACHING_CAPABILITY_KEY,
    requester: {
      userId: input.user.id,
      displayName: requesterParticipant?.displayName ?? input.user.displayName,
      email: requesterParticipant?.email ?? input.user.email,
    },
    meeting: {
      id: ownedMeeting.id,
      title: ownedMeeting.title,
      meetingType: extraction?.meetingType ?? null,
      meetingTypeConfidence: extraction?.meetingTypeConfidence ?? null,
    },
    requesterTurnCount: requesterTurns.length,
    participantCount: participants.length,
    generatedAt: new Date().toISOString(),
    participants: participants.map((participant) => ({
      userId: participant.userId,
      displayName: participant.displayName,
      role: participant.role,
    })),
    summary: summary?.content ?? null,
    tasks: taskSummaryForCoaching(tasks),
    requesterTurns: requesterTurns.slice(0, REQUESTER_TURNS_CONTEXT_LIMIT).map(compactTranscriptSegment),
    transcriptExcerpts: contextSegments,
    recommendationReasoning: input.recommendation.reasoning,
  };
}

function buildMeetingCoachingPlan(feedback: MeetingCoachingFeedback) {
  return {
    summary: feedback.summary,
    followUpPrompts: feedback.followUpPrompts,
    detailFocus: feedback.detailFocus,
    detailParagraphs: feedback.detailParagraphs,
    /** @external meeting coaching insufficient requester evidence */
    insufficientRequesterEvidence: feedback.insufficientRequesterEvidence,
  };
}

function cleanBugTitle(value: string) {
  return value
    .replace(/\*\*/g, "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*•]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/\s*\([^)]*\)\s*$/g, "")
    .replace(/\s*:\s*$/g, "")
    .trim();
}

function splitBugDescriptionIntoIssues(description: string) {
  const lines = description.split("\n");
  const reduced = lines.reduce<{
    issues: { title: string; description: string }[];
    current: { title: string; lines: string[] } | null;
  }>(
    (state, line) => {
      const trimmed = line.trim();
      const headingMatch = trimmed.match(/^(?:#{1,6}\s*)?\d+[.)]\s+(.+?)(?::\s*)?$/);
      if (headingMatch) {
        const closed = state.current
          ? [
              ...state.issues,
              {
                title: state.current.title,
                description: state.current.lines.join("\n").trim(),
              },
            ]
          : state.issues;

        return {
          issues: closed,
          current: {
            title: cleanBugTitle(headingMatch[1] ?? ""),
            lines: [],
          },
        };
      }

      if (state.current && Boolean(trimmed)) {
        return {
          issues: state.issues,
          current: { ...state.current, lines: [...state.current.lines, trimmed] },
        };
      }

      return state;
    },
    { issues: [], current: null },
  );
  const issues = reduced.current
    ? [
        ...reduced.issues,
        {
          title: reduced.current.title,
          description: reduced.current.lines.join("\n").trim(),
        },
      ]
    : reduced.issues;

  return issues
    .filter((issue) => Boolean(issue.title))
    .map((issue) => ({
      title: issue.title,
      description: issue.description.length > 0 ? issue.description : issue.title,
    }))
    .slice(0, BUG_ISSUE_BATCH_LIMIT);
}

function bugPayloadIssuesFromPayload(payload: Record<string, unknown>) {
  if (!Array.isArray(payload.issues)) {
    return [];
  }

  return payload.issues
    .filter(
      (issue): issue is Record<string, unknown> => Boolean(issue) && typeof issue === "object" && !Array.isArray(issue),
    )
    .map((issue) => ({
      title: cleanBugTitle(stringValue({ value: issue.title })),
      description: stringValue({ value: issue.description }),
      severity: severityValue(issue.severity_hint),
      reproductionContext: stringValue({ value: issue.reproduction_context }),
    }))
    .filter((issue) => issue.title.length > 0 && issue.description.length > 0)
    .slice(0, BUG_ISSUE_BATCH_LIMIT);
}

function splitIssueListText(value: string) {
  const listText = value
    .replace(/^.*?\b(?:including|surfaced|identified|discussed|prioritized)\b[:\s]*/i, "")
    .replace(/\.\s*Each excerpt.*$/i, "")
    .trim();

  return listText
    .split(/(?:,\s+|\s+and\s+|;\s+)/)
    .map((item) => cleanBugTitle(item))
    .filter((item) => {
      const normalized = normalizeForMatch(item);

      return (
        item.length >= MIN_SIGNAL_ISSUE_TITLE_LENGTH &&
        /\b(bug|issue|fail|failure|break|broken|timeout|regression|render|scroll|overflow|deploy|error|race|safari|sso|export)\b/.test(
          normalized,
        )
      );
    })
    .slice(0, BUG_ISSUE_BATCH_LIMIT);
}

function bugIssuesFromMatchedSignals(recommendation: Recommendation) {
  const signalTitles = recommendation.signalsMatched
    .filter((signal) => signal.key === "engineering_issue_identified")
    .flatMap((signal) => splitIssueListText(signal.description ?? ""));

  const uniqueTitles = Array.from(new Set(signalTitles));

  return uniqueTitles.map((title) => ({
    title,
    description: title,
  }));
}

function isGroundedSourceSpan(
  sourceSpan: SourceSpan,
): sourceSpan is SourceSpan & { verificationStatus: "verified" | "corrected" } {
  return sourceSpan.verificationStatus === "verified" || sourceSpan.verificationStatus === "corrected";
}

function evidenceBankItem(input: {
  id: string;
  source: string;
  label: string;
  sourceSpan: SourceSpan;
}): BugReportEvidenceBankItem | null {
  if (!isGroundedSourceSpan(input.sourceSpan)) {
    return null;
  }

  return {
    id: input.id,
    source: input.source,
    label: input.label,
    excerpt: input.sourceSpan.excerpt,
    lineStart: input.sourceSpan.lineStart,
    lineEnd: input.sourceSpan.lineEnd,
    segmentIds: input.sourceSpan.segmentIds,
    verificationStatus: input.sourceSpan.verificationStatus,
  };
}

async function buildBugReportEvidenceBank(recommendation: Recommendation): Promise<BugReportEvidenceBankItem[]> {
  const extraction = await repositories().getExtractionById(recommendation.extractionId);
  if (!extraction) {
    return [];
  }

  const addSpans = (input: { source: string; label: string; sourceId: string; sourceSpans: SourceSpan[] }) =>
    input.sourceSpans.flatMap((sourceSpan, index) => {
      const item = evidenceBankItem({
        id: `${input.source}:${input.sourceId}:${index}`,
        source: input.source,
        label: input.label,
        sourceSpan,
      });

      return item !== null ? [item] : [];
    });

  const evidenceGroups = [
    ...extraction.signals
      .filter((signal) => signal.key === "engineering_issue_identified")
      .map((signal) => ({
        source: "signal",
        label: signal.reasoning ?? signal.key,
        sourceId: signal.key,
        sourceSpans: signal.sourceSpans,
      })),
    ...extraction.highlights.map((highlight) => ({
      source: "highlight",
      label: [highlight.theme, highlight.takeaway].filter(Boolean).join(": "),
      sourceId: highlight.id,
      sourceSpans: highlight.sourceSpans,
    })),
    ...extraction.decisions.map((decision) => ({
      source: "decision",
      label: decision.text,
      sourceId: decision.id,
      sourceSpans: decision.sourceSpans,
    })),
    ...extraction.actionItems.map((actionItem) => ({
      source: "action_item",
      label: actionItem.title,
      sourceId: actionItem.id,
      sourceSpans: actionItem.sourceSpans,
    })),
    ...extraction.risks.map((risk) => ({
      source: "risk",
      label: risk.text,
      sourceId: risk.id,
      sourceSpans: risk.sourceSpans,
    })),
  ];
  const items = evidenceGroups.flatMap((group) => addSpans(group));

  const seen = new Set<string>();

  return items
    .filter((item) => {
      const key = `${item.lineStart}:${item.lineEnd}:${item.excerpt}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);

      return true;
    })
    .slice(0, EVIDENCE_BANK_ITEM_LIMIT);
}

function evidenceSpanFromBankItem(item: BugReportEvidenceBankItem): BugReportIssueEvidenceSpan {
  return {
    evidenceId: item.id,
    source: item.source,
    label: item.label,
    excerpt: item.excerpt,
    lineStart: item.lineStart,
    lineEnd: item.lineEnd,
    segmentIds: item.segmentIds,
    verificationStatus: item.verificationStatus,
  };
}

function evidenceText(evidenceSpans: BugReportIssueEvidenceSpan[]) {
  return evidenceSpans.map((span) => span.excerpt).join(" ");
}

function hasEvidenceOverlap(input: { value: string; evidenceSpans: BugReportIssueEvidenceSpan[] }) {
  const evidenceWords = new Set(
    normalizeForMatch(evidenceText(input.evidenceSpans))
      .split(/\s+/)
      .filter((word) => word.length >= MIN_OVERLAP_WORD_LENGTH),
  );
  if (evidenceWords.size === 0) {
    return false;
  }

  const valueWords = normalizeForMatch(input.value)
    .split(/\s+/)
    .filter((word) => word.length >= MIN_OVERLAP_WORD_LENGTH);

  return valueWords.some((word) => evidenceWords.has(word));
}

function groundedDescription(input: {
  candidate: BugReportIssuePlanCandidate;
  evidenceSpans: BugReportIssueEvidenceSpan[];
}) {
  if (hasEvidenceOverlap({ value: input.candidate.description, evidenceSpans: input.evidenceSpans })) {
    return input.candidate.description;
  }

  const excerpt = input.evidenceSpans[0]?.excerpt ?? input.candidate.title;

  return (
    CAPABILITY_WORKFLOW_MESSAGES.meetingEvidencePrefix +
    truncate({ value: excerpt, maxLength: GROUNDED_DESCRIPTION_TRUNCATE_LENGTH })
  );
}

function groundedReproductionContext(input: {
  candidate: BugReportIssuePlanCandidate;
  evidenceSpans: BugReportIssueEvidenceSpan[];
}) {
  if (input.candidate.reproductionContext === null || input.candidate.reproductionContext.length === 0) {
    return null;
  }

  return hasEvidenceOverlap({ value: input.candidate.reproductionContext, evidenceSpans: input.evidenceSpans })
    ? input.candidate.reproductionContext
    : null;
}

function validateIssueCandidateEvidence(input: {
  candidate: BugReportIssuePlanCandidate;
  evidenceById: Map<string, BugReportEvidenceBankItem>;
}) {
  const evidenceSpans = Array.from(new Set(input.candidate.evidenceIds))
    .map((evidenceId) => input.evidenceById.get(evidenceId))
    .filter((item): item is BugReportEvidenceBankItem => Boolean(item))
    .map(evidenceSpanFromBankItem);

  return evidenceSpans.length !== 0 ? evidenceSpans : null;
}

function evidenceOverlapScore(input: { value: string; evidence: BugReportEvidenceBankItem }) {
  const valueWords = normalizeForMatch(input.value)
    .split(/\s+/)
    .filter((word) => word.length >= MIN_OVERLAP_WORD_LENGTH);
  const evidenceWords = new Set(
    normalizeForMatch(
      [input.evidence.excerpt, input.evidence.label].filter((part) => part !== undefined && part.length > 0).join(" "),
    )
      .split(/\s+/)
      .filter((word) => word.length >= MIN_OVERLAP_WORD_LENGTH),
  );

  return valueWords.filter((word) => evidenceWords.has(word)).length;
}

function bestEvidenceIdsForIssue(input: {
  title: string;
  description: string;
  evidenceBank: BugReportEvidenceBankItem[];
}) {
  const text = `${input.title} ${input.description}`;

  return input.evidenceBank
    .map((evidence) => ({
      id: evidence.id,
      score: evidenceOverlapScore({ value: text, evidence }),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, BEST_EVIDENCE_MATCH_LIMIT)
    .map((item) => item.id);
}

function fallbackIssueCandidates(input: { recommendation: Recommendation; evidenceBank: BugReportEvidenceBankItem[] }) {
  const payload = recordOrEmpty(input.recommendation.payload);
  const title = stringValue({ value: payload.title, fallback: CAPABILITY_WORKFLOW_MESSAGES.defaultBugTitle });
  const description = stringValue({ value: payload.description, fallback: input.recommendation.reasoning });
  const reproductionContext = stringValue({ value: payload.reproduction_context });
  const severity = severityValue(payload.severity_hint);
  const structuredIssues = bugPayloadIssuesFromPayload(payload);
  const descriptionIssues = splitBugDescriptionIntoIssues(description);
  const reproductionIssues = splitBugDescriptionIntoIssues(reproductionContext);
  const signalIssues = bugIssuesFromMatchedSignals(input.recommendation);
  const fallbackIssues =
    structuredIssues.length !== 0
      ? structuredIssues
      : descriptionIssues.length > 1
        ? descriptionIssues.map((issue) => ({ ...issue, severity, reproductionContext }))
        : reproductionIssues.length > 1
          ? reproductionIssues.map((issue) => ({ ...issue, severity, reproductionContext }))
          : signalIssues.length > 1
            ? signalIssues.map((issue) => ({ ...issue, severity, reproductionContext }))
            : [
                {
                  title,
                  description,
                  severity,
                  reproductionContext,
                },
              ];

  const { candidates, skippedCandidates } = fallbackIssues.reduce<{
    candidates: BugReportIssuePlanCandidate[];
    skippedCandidates: BugReportSkippedCandidate[];
  }>(
    (state, issue) => {
      const evidenceIds = bestEvidenceIdsForIssue({
        title: issue.title,
        description: issue.description,
        evidenceBank: input.evidenceBank,
      });
      if (evidenceIds.length === 0) {
        return {
          candidates: state.candidates,
          skippedCandidates: [
            ...state.skippedCandidates,
            {
              title:
                cleanBugTitle(issue.title).length > 0
                  ? cleanBugTitle(issue.title)
                  : CAPABILITY_WORKFLOW_MESSAGES.possibleBugTitle,
              reason: CAPABILITY_WORKFLOW_MESSAGES.skippedNoEvidenceMatch,
              evidenceIds: [],
            },
          ],
        };
      }

      return {
        candidates: [
          ...state.candidates,
          {
            title: truncate({
              value: cleanBugTitle(issue.title).length > 0 ? cleanBugTitle(issue.title) : title,
              maxLength: ISSUE_TITLE_TRUNCATE_LENGTH,
            }),
            description: issue.description,
            severity: issue.severity,
            reproductionContext: issue.reproductionContext.length > 0 ? issue.reproductionContext : null,
            evidenceIds,
            searchTerms: Array.from(
              new Set(
                [issue.title, issue.description.split("\n")[0] ?? ""]
                  .map((term) =>
                    term
                      .replace(/[^a-zA-Z0-9\s/-]/g, " ")
                      .replace(/\s+/g, " ")
                      .trim(),
                  )
                  .filter(Boolean),
              ),
            ).slice(0, ISSUE_SEARCH_TERMS_LIMIT),
            scopeReason: CAPABILITY_WORKFLOW_MESSAGES.scopeReasonFromRecommendation,
            confidence: evidenceIds.length !== 0 ? "medium" : "low",
          },
        ],
        skippedCandidates: state.skippedCandidates,
      };
    },
    { candidates: [], skippedCandidates: [] },
  );

  return {
    candidates,
    skippedCandidates,
    summary:
      candidates.length !== 0
        ? preparedGroundedIssuesSummary(candidates.length)
        : CAPABILITY_WORKFLOW_MESSAGES.noGroundedCandidatesSummary,
  };
}

async function planBugReportIssueCandidates(input: {
  recommendation: Recommendation;
  evidenceBank: BugReportEvidenceBankItem[];
  metering?: { meetingId: string; workflowRunId: string } | null;
}) {
  if (input.evidenceBank.length === 0) {
    return {
      candidates: [],
      skippedCandidates: [
        {
          title: CAPABILITY_WORKFLOW_MESSAGES.possibleBugsFromMeetingTitle,
          reason: CAPABILITY_WORKFLOW_MESSAGES.skippedNoEvidenceAvailable,
          evidenceIds: [],
        },
      ],
      summary: CAPABILITY_WORKFLOW_MESSAGES.noVerifiedEvidenceSummary,
    };
  }

  try {
    const response = await triggerBugReportIssuePlanning({
      recommendation: {
        reasoning: input.recommendation.reasoning,
        payload: input.recommendation.payload,
        signalsMatched: input.recommendation.signalsMatched,
      },
      evidenceBank: input.evidenceBank,
      metering: input.metering ?? null,
    });

    return bugReportIssuePlanningResponseSchema.parse(response);
  } catch (error) {
    console.error(CAPABILITY_WORKFLOW_LOG.issuePlanningFallback, error instanceof Error ? error.message : error);

    return fallbackIssueCandidates(input);
  }
}

function issueDraftsFromDraft(draft: BugReportDraft): BugReportIssueDraft[] {
  if (draft.issues.length !== 0) {
    return draft.issues;
  }

  return draft.evidenceSpans.length !== 0 || draft.evidence.length !== 0
    ? [bugReportIssueDraftSchema.parse(draft)]
    : [];
}

function normalizeForMatch(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const ISSUE_MATCH_STOP_WORDS = new Set([
  "add",
  "and",
  "bug",
  "bugs",
  "draft",
  "drafts",
  "issue",
  "issues",
  "just",
  "keep",
  "linear",
  "only",
  "please",
  "take",
  "ticket",
  "tickets",
  "use",
  "with",
]);

function issueSearchText(issue: BugReportIssueDraft) {
  return [
    issue.title,
    issue.description,
    issue.reproductionContext,
    issue.scopeReason,
    ...issue.evidence,
    ...issue.evidenceSpans.flatMap((span) => [span.label, span.excerpt]),
  ]
    .filter(Boolean)
    .join(" ");
}

function issueMatchScore(input: { issue: BugReportIssueDraft; normalizedInstruction: string }) {
  const instructionWords = normalizeForMatch(input.normalizedInstruction)
    .split(/\s+/)
    .filter((word) => word.length >= ISSUE_MATCH_MIN_WORD_LENGTH && !ISSUE_MATCH_STOP_WORDS.has(word));
  const issueText = normalizeForMatch(issueSearchText(input.issue));
  const issueWords = new Set(issueText.split(/\s+/).filter((word) => word.length >= ISSUE_MATCH_MIN_WORD_LENGTH));
  const titleText = normalizeForMatch(input.issue.title);
  const exactTitleBonus =
    titleText.length > 0 && input.normalizedInstruction.includes(titleText) ? ISSUE_MATCH_EXACT_TITLE_BONUS : 0;
  const wordScore = instructionWords.filter((word) => issueWords.has(word)).length;

  return wordScore + exactTitleBonus;
}

function findIssueIndexesByInstruction(input: { issues: BugReportIssueDraft[]; instruction: string }) {
  const normalizedInstruction = normalizeForMatch(input.instruction);
  const scored = input.issues
    .map((issue, index) => ({
      index,
      score: issueMatchScore({ issue, normalizedInstruction }),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);

  if (scored.length === 0) {
    return [];
  }

  const bestScore = scored[0]?.score ?? 0;

  return scored
    .filter((item) => item.score === bestScore || item.score >= ISSUE_MATCH_SECONDARY_SCORE_THRESHOLD)
    .map((item) => item.index);
}

function findIssueIndexByInstruction(input: { issues: BugReportIssueDraft[]; instruction: string }) {
  const normalizedInstruction = normalizeForMatch(input.instruction);
  const ordinalMatch = normalizedInstruction.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|last)\b/);
  if (ordinalMatch) {
    const ordinalIndexes: Record<string, number> = {
      first: 0,
      second: ORDINAL_INDEX_SECOND,
      third: ORDINAL_INDEX_THIRD,
      fourth: ORDINAL_INDEX_FOURTH,
      fifth: ORDINAL_INDEX_FIFTH,
      sixth: ORDINAL_INDEX_SIXTH,
      seventh: ORDINAL_INDEX_SEVENTH,
      eighth: ORDINAL_INDEX_EIGHTH,
      last: input.issues.length - 1,
    };
    const index = ordinalIndexes[ordinalMatch[1] ?? ""];
    if (typeof index === "number" && index >= 0 && index < input.issues.length) {
      return index;
    }
  }

  const numberedMatch = normalizedInstruction.match(/\b(?:issue|bug|ticket)\s+(\d+)\b/);
  if (numberedMatch) {
    const index = Number(numberedMatch[1]) - 1;
    if (Number.isInteger(index) && index >= 0 && index < input.issues.length) {
      return index;
    }
  }

  return findIssueIndexesByInstruction({ issues: input.issues, instruction: input.instruction })[0] ?? null;
}

function numberWordValue(value: string) {
  const numberWords: Record<string, number> = {
    one: 1,
    two: NUMBER_WORD_TWO,
    three: NUMBER_WORD_THREE,
    four: NUMBER_WORD_FOUR,
    five: NUMBER_WORD_FIVE,
    six: NUMBER_WORD_SIX,
    seven: NUMBER_WORD_SEVEN,
    eight: NUMBER_WORD_EIGHT,
  };
  const normalized = value.toLowerCase();

  return /^\d+$/.test(normalized) ? Number(normalized) : (numberWords[normalized] ?? null);
}

function applyIssueListFilterInstruction(input: { issues: BugReportIssueDraft[]; instruction: string }) {
  const normalizedInstruction = normalizeForMatch(input.instruction);
  const countMatch = normalizedInstruction.match(
    /\b(?:only|just|keep|add|include|use|take)\s+(?:the\s+)?(?:first|last)?\s*(one|two|three|four|five|six|seven|eight|\d+)\s+(?:issues?|bugs?|tickets?)\b/,
  );
  if (countMatch && /\b(only|just|keep|first|last|add|include|use|take)\b/.test(normalizedInstruction)) {
    const count = numberWordValue(countMatch[1] ?? "");
    if (count !== null && count > 0) {
      if (/\blast\b/.test(normalizedInstruction) && !/\bfirst\b/.test(normalizedInstruction)) {
        return input.issues.slice(Math.max(0, input.issues.length - count));
      }

      return input.issues.slice(0, count);
    }
  }

  const firstThroughMatch = normalizedInstruction.match(
    /\b(?:first|issues?|bugs?|tickets?)\s+(?:through|to|-)\s+(one|two|three|four|five|six|seven|eight|\d+)\b/,
  );
  if (firstThroughMatch) {
    const count = numberWordValue(firstThroughMatch[1] ?? "");
    if (count !== null && count > 0) {
      return input.issues.slice(0, count);
    }
  }

  return null;
}

function isExclusiveIssueSelectionInstruction(instruction: string) {
  const normalizedInstruction = normalizeForMatch(instruction);

  return (
    (/\b(only|just)\b/.test(normalizedInstruction) &&
      /\b(add|include|keep|sync|take|use)\b/.test(normalizedInstruction)) ||
    /\bkeep only\b/.test(normalizedInstruction)
  );
}

function isIssueRestoreInstruction(instruction: string) {
  const normalizedInstruction = normalizeForMatch(instruction);

  return (
    /\b(add|include|restore|bring back|put back|return|recover)\b/.test(normalizedInstruction) &&
    /\b(issue|bug|ticket|issues|bugs|tickets)\b/.test(normalizedInstruction)
  );
}

function rebuildBugReportDraftFromIssues(input: { currentDraft: BugReportDraft; issues: BugReportIssueDraft[] }) {
  const normalizedIssues = input.issues.length !== 0 ? input.issues : issueDraftsFromDraft(input.currentDraft);
  const primaryIssue = normalizedIssues[0];
  if (primaryIssue === undefined) {
    throw new Error(CAPABILITY_WORKFLOW_MESSAGES.revisedDraftNeedsIssue);
  }

  return bugReportDraftSchema.parse({
    ...input.currentDraft,
    title: primaryIssue.title,
    description: primaryIssue.description,
    severity: primaryIssue.severity,
    impact: primaryIssue.impact,
    reproductionContext: primaryIssue.reproductionContext,
    evidence: primaryIssue.evidence,
    evidenceSpans: primaryIssue.evidenceSpans,
    scopeReason: primaryIssue.scopeReason,
    confidence: primaryIssue.confidence,
    duplicateIssueIds: primaryIssue.duplicateIssueIds,
    teamId: primaryIssue.teamId,
    teamName: primaryIssue.teamName,
    labels: primaryIssue.labels,
    issues: normalizedIssues,
  });
}

function pluralizeIssue(count: number) {
  return count === 1 ? "issue" : "issues";
}

function buildDraftListSummary(draft: BugReportDraft) {
  const issueCount = issueDraftsFromDraft(draft).length;
  if (issueCount === 0) {
    return CAPABILITY_WORKFLOW_MESSAGES.noGroundedLinearIssuesSummary;
  }

  return listedDraftIssuesSummary({ count: issueCount, issueWord: pluralizeIssue(issueCount) });
}

const REVISION_UNSUPPORTED_SUMMARY =
  "I could not apply that change safely. Try asking to keep, remove, merge, split, rename, rewrite, or reorder specific issues.";

type BugReportRevisionResult = {
  draft: BugReportDraft;
  summary: string;
  isHandled: boolean;
  operation?: BugReportDraftRevisionResponse["operation"];
};

function evidenceBankFromWorkflowContext(context: Record<string, unknown>) {
  const parsed = bugReportEvidenceBankItemSchema.array().safeParse(context.evidenceBank);

  return parsed.success ? parsed.data : [];
}

function addAllowedEvidenceSpan(input: {
  allowedEvidenceSpans: Map<string, BugReportIssueEvidenceSpan>;
  span: BugReportIssueEvidenceSpan;
}) {
  const nextAllowedEvidenceSpans = new Map(input.allowedEvidenceSpans);
  if (input.span.evidenceId.length > 0 && !nextAllowedEvidenceSpans.has(input.span.evidenceId)) {
    nextAllowedEvidenceSpans.set(input.span.evidenceId, input.span);
  }

  return nextAllowedEvidenceSpans;
}

function collectAllowedEvidenceSpans(input: {
  currentDraft: BugReportDraft;
  originalDraft: BugReportDraft | null;
  evidenceBank: BugReportEvidenceBankItem[];
}) {
  const seedSpans = new Map<string, BugReportIssueEvidenceSpan>();
  const fromCurrent = issueDraftsFromDraft(input.currentDraft).reduce(
    (allowedEvidenceSpans, issue) =>
      issue.evidenceSpans.reduce(
        (map, span) => addAllowedEvidenceSpan({ allowedEvidenceSpans: map, span }),
        allowedEvidenceSpans,
      ),
    seedSpans,
  );
  const fromOriginal =
    input.originalDraft === null
      ? fromCurrent
      : issueDraftsFromDraft(input.originalDraft).reduce(
          (allowedEvidenceSpans, issue) =>
            issue.evidenceSpans.reduce(
              (map, span) => addAllowedEvidenceSpan({ allowedEvidenceSpans: map, span }),
              allowedEvidenceSpans,
            ),
          fromCurrent,
        );

  return input.evidenceBank.reduce(
    (allowedEvidenceSpans, evidence) =>
      addAllowedEvidenceSpan({
        allowedEvidenceSpans,
        span: evidenceSpanFromBankItem(evidence),
      }),
    fromOriginal,
  );
}

function normalizeRevisedIssueEvidence(input: {
  issue: BugReportIssueDraft;
  allowedEvidenceSpans: Map<string, BugReportIssueEvidenceSpan>;
}) {
  const seenEvidenceIds = new Set<string>();
  const evidenceSpans = input.issue.evidenceSpans.reduce<BugReportIssueEvidenceSpan[]>((collected, span) => {
    const allowedSpan = input.allowedEvidenceSpans.get(span.evidenceId);
    if (!allowedSpan || seenEvidenceIds.has(allowedSpan.evidenceId)) {
      return collected;
    }
    seenEvidenceIds.add(allowedSpan.evidenceId);

    return [...collected, allowedSpan];
  }, []);

  if (evidenceSpans.length === 0) {
    throw new Error(issueNeedsEvidenceBeforeSaveMessage(input.issue.title));
  }

  return bugReportIssueDraftSchema.parse({
    ...input.issue,
    evidence: evidenceSpans.map((span) => span.excerpt),
    evidenceSpans,
  });
}

function validateRevisedBugReportDraft(input: {
  draft: BugReportDraft;
  currentDraft: BugReportDraft;
  originalDraft: BugReportDraft | null;
  evidenceBank: BugReportEvidenceBankItem[];
  context: BugReportLinearContext;
}) {
  const allowedEvidenceSpans = collectAllowedEvidenceSpans({
    currentDraft: input.currentDraft,
    originalDraft: input.originalDraft,
    evidenceBank: input.evidenceBank,
  });
  const parsedDraft = bugReportDraftSchema.parse(input.draft);
  const issues = issueDraftsFromDraft(parsedDraft);
  if (issues.length === 0) {
    throw new Error(CAPABILITY_WORKFLOW_MESSAGES.revisedDraftNeedsIssue);
  }

  const normalizedIssues = issues.map((issue) =>
    normalizeRevisedIssueEvidence({
      issue,
      allowedEvidenceSpans,
    }),
  );

  return filterDraftDuplicateIdsToContext(
    rebuildBugReportDraftFromIssues({ currentDraft: parsedDraft, issues: normalizedIssues }),
    input.context,
  );
}

function duplicateIdCounts(draft: BugReportDraft) {
  return issueDraftsFromDraft(draft).reduce((counts, issue) => {
    const nextCounts = new Map(counts);
    issue.duplicateIssueIds.forEach((duplicateIssueId) => {
      nextCounts.set(duplicateIssueId, (nextCounts.get(duplicateIssueId) ?? 0) + 1);
    });

    return nextCounts;
  }, new Map<string, number>());
}

function countDuplicateIssueIdRemovals(input: { before: BugReportDraft; after: BugReportDraft }) {
  const beforeCounts = duplicateIdCounts(input.before);
  const afterCounts = duplicateIdCounts(input.after);

  return [...beforeCounts].reduce(
    (removalCount, [duplicateIssueId, beforeCount]) =>
      removalCount + Math.max(0, beforeCount - (afterCounts.get(duplicateIssueId) ?? 0)),
    0,
  );
}

function maybeApplyRelatedIssueUnlinkFallback(input: {
  currentDraft: BugReportDraft;
  context: BugReportLinearContext;
  instruction: string;
}) {
  const unlinkRevision = unlinkRelatedLinearIssues({
    draft: input.currentDraft,
    context: input.context,
    instruction: input.instruction,
  });
  if (!unlinkRevision.handled) {
    return {
      draft: input.currentDraft,
      summary: RELATED_ISSUE_UNCLEAR_SUMMARY,
      isHandled: false,
      operation: "unlink_related_issue" as const,
    } satisfies BugReportRevisionResult;
  }

  return {
    draft: unlinkRevision.draft,
    summary: unlinkRevision.summary,
    isHandled: true,
    operation: "unlink_related_issue" as const,
  } satisfies BugReportRevisionResult;
}

function unsupportedRevision(currentDraft: BugReportDraft): BugReportRevisionResult {
  return {
    draft: currentDraft,
    summary: REVISION_UNSUPPORTED_SUMMARY,
    isHandled: false,
    operation: "unsupported",
  };
}

function shouldRestoreAllIssues(instruction: string) {
  const normalizedInstruction = normalizeForMatch(instruction);

  return (
    /\b(all|everything|every issue|all issues|all bugs|all tickets)\b/.test(normalizedInstruction) &&
    /\b(bring back|restore|show|include|add back|put back|return|recover|list|use|keep)\b/.test(normalizedInstruction)
  );
}

function reviseBugReportRestoreAll(input: {
  currentDraft: BugReportDraft;
  instruction: string;
  originalDraft: BugReportDraft | null;
  issues: BugReportIssueDraft[];
  originalIssues: BugReportIssueDraft[];
}): BugReportRevisionResult | null {
  if (input.originalDraft === null || !shouldRestoreAllIssues(input.instruction)) {
    return null;
  }
  if (input.originalIssues.length <= input.issues.length) {
    return null;
  }

  return {
    draft: rebuildBugReportDraftFromIssues({
      currentDraft: input.originalDraft,
      issues: input.originalIssues,
    }),
    summary: restoredAllIssuesSummary({
      count: input.originalIssues.length,
      issueWord: pluralizeIssue(input.originalIssues.length),
    }),
    isHandled: true,
  } satisfies BugReportRevisionResult;
}

function reviseBugReportExclusiveSelection(input: {
  currentDraft: BugReportDraft;
  instruction: string;
  issues: BugReportIssueDraft[];
  targetIndexes: number[];
}): BugReportRevisionResult | null {
  if (!isExclusiveIssueSelectionInstruction(input.instruction) || input.targetIndexes.length === 0) {
    return null;
  }
  const selectedIssues = input.targetIndexes
    .map((index) => input.issues[index])
    .filter((issue): issue is BugReportIssueDraft => issue !== undefined);
  const draft = rebuildBugReportDraftFromIssues({ currentDraft: input.currentDraft, issues: selectedIssues });
  const onlySelected = selectedIssues.length === 1 ? selectedIssues[0] : undefined;
  if (selectedIssues.length === 1 && onlySelected === undefined) {
    throw new Error(CAPABILITY_WORKFLOW_MESSAGES.selectedIssueNotFound);
  }

  return {
    draft,
    summary:
      onlySelected !== undefined
        ? keptOnlyIssueSummary(onlySelected.title)
        : keptOnlySelectedIssuesSummary({
            count: selectedIssues.length,
            issueWord: pluralizeIssue(selectedIssues.length),
          }),
    isHandled: true,
  } satisfies BugReportRevisionResult;
}

function reviseBugReportRestoreIssues(input: {
  currentDraft: BugReportDraft;
  instruction: string;
  originalDraft: BugReportDraft | null;
  issues: BugReportIssueDraft[];
  originalIssues: BugReportIssueDraft[];
}): BugReportRevisionResult | null {
  if (
    input.originalDraft === null ||
    !isIssueRestoreInstruction(input.instruction) ||
    isExclusiveIssueSelectionInstruction(input.instruction)
  ) {
    return null;
  }
  const restoreIndexes = findIssueIndexesByInstruction({
    issues: input.originalIssues,
    instruction: input.instruction,
  });
  const issuesToRestore = restoreIndexes
    .map((index) => input.originalIssues[index])
    .filter((issue): issue is BugReportIssueDraft => issue !== undefined);
  const existingIssueKeys = new Set(input.issues.map((issue) => normalizeForMatch(issue.title)));
  const restoredIssues = issuesToRestore.filter((issue) => !existingIssueKeys.has(normalizeForMatch(issue.title)));
  if (restoredIssues.length === 0) {
    return null;
  }
  const draft = rebuildBugReportDraftFromIssues({
    currentDraft: input.currentDraft,
    issues: [...input.issues, ...restoredIssues],
  });
  const restoredIssue = restoredIssues.length === 1 ? restoredIssues[0] : undefined;
  if (restoredIssues.length === 1 && restoredIssue === undefined) {
    throw new Error(CAPABILITY_WORKFLOW_MESSAGES.restoredIssueNotFound);
  }

  return {
    draft,
    summary:
      restoredIssue !== undefined
        ? addedIssueBackSummary(restoredIssue.title)
        : addedIssuesBackSummary({
            count: restoredIssues.length,
            issueWord: pluralizeIssue(restoredIssues.length),
          }),
    isHandled: true,
  } satisfies BugReportRevisionResult;
}

function reviseBugReportFilterInstruction(input: {
  currentDraft: BugReportDraft;
  instruction: string;
  issues: BugReportIssueDraft[];
  normalizedInstruction: string;
}): BugReportRevisionResult | null {
  const filteredIssues = applyIssueListFilterInstruction({ issues: input.issues, instruction: input.instruction });
  if (filteredIssues === null) {
    return null;
  }
  const position =
    /\blast\b/.test(input.normalizedInstruction) && !/\bfirst\b/.test(input.normalizedInstruction) ? "last" : "first";

  return {
    draft: rebuildBugReportDraftFromIssues({ currentDraft: input.currentDraft, issues: filteredIssues }),
    summary: keptPositionIssuesSummary({
      position,
      count: filteredIssues.length,
      issueWord: pluralizeIssue(filteredIssues.length),
    }),
    isHandled: true,
  } satisfies BugReportRevisionResult;
}

function reviseBugReportRemoveIssues(input: {
  currentDraft: BugReportDraft;
  normalizedInstruction: string;
  issues: BugReportIssueDraft[];
  targetIndexes: number[];
  targetIndex: number | null;
}): BugReportRevisionResult | null {
  if (!/\b(remove|delete|drop|exclude)\b/.test(input.normalizedInstruction) || input.issues.length <= 1) {
    return null;
  }
  const removeIndexes =
    input.targetIndexes.length !== 0 ? input.targetIndexes : input.targetIndex === null ? [] : [input.targetIndex];
  if (removeIndexes.length === 0) {
    return unsupportedRevision(input.currentDraft);
  }
  const removeIndexSet = new Set(removeIndexes);
  const removedIssues = input.issues.filter((_issue, index) => removeIndexSet.has(index));
  const remainingIssues = input.issues.filter((_issue, index) => !removeIndexSet.has(index));
  const removedIssue = removedIssues.length === 1 ? removedIssues[0] : undefined;

  return {
    draft: rebuildBugReportDraftFromIssues({ currentDraft: input.currentDraft, issues: remainingIssues }),
    summary:
      removedIssue !== undefined
        ? removedSingleIssueSummary({
            title: removedIssue.title,
            remainingCount: remainingIssues.length,
            issueWord: pluralizeIssue(remainingIssues.length),
          })
        : removedMultipleIssuesSummary({
            removedCount: removedIssues.length,
            removedWord: pluralizeIssue(removedIssues.length),
            remainingCount: remainingIssues.length,
          }),
    isHandled: true,
  } satisfies BugReportRevisionResult;
}

function reviseBugReportDraftDeterministically(input: {
  currentDraft: BugReportDraft;
  instruction: string;
  originalDraft?: BugReportDraft | null;
}) {
  const originalDraft = input.originalDraft ?? null;
  const normalizedInstruction = normalizeForMatch(input.instruction);
  const issues = issueDraftsFromDraft(input.currentDraft);
  const originalIssues = originalDraft === null ? [] : issueDraftsFromDraft(originalDraft);
  const targetIndexes = findIssueIndexesByInstruction({ issues, instruction: input.instruction });

  return (
    reviseBugReportRestoreAll({
      currentDraft: input.currentDraft,
      instruction: input.instruction,
      originalDraft,
      issues,
      originalIssues,
    }) ??
    reviseBugReportExclusiveSelection({
      currentDraft: input.currentDraft,
      instruction: input.instruction,
      issues,
      targetIndexes,
    }) ??
    reviseBugReportRestoreIssues({
      currentDraft: input.currentDraft,
      instruction: input.instruction,
      originalDraft,
      issues,
      originalIssues,
    }) ??
    reviseBugReportFilterInstruction({
      currentDraft: input.currentDraft,
      instruction: input.instruction,
      issues,
      normalizedInstruction,
    }) ??
    reviseBugReportRemoveIssues({
      currentDraft: input.currentDraft,
      normalizedInstruction,
      issues,
      targetIndexes,
      targetIndex: findIssueIndexByInstruction({ issues, instruction: input.instruction }),
    }) ??
    unsupportedRevision(input.currentDraft)
  );
}

async function reviseBugReportDraftWithAssistant(input: {
  currentDraft: BugReportDraft;
  originalDraft: BugReportDraft | null;
  evidenceBank: BugReportEvidenceBankItem[];
  context: BugReportLinearContext;
  instruction: string;
  previousSummary: string | null;
  metering?: { meetingId: string; workflowRunId: string } | null;
}): Promise<BugReportRevisionResult> {
  const response = await triggerBugReportDraftRevision({
    draft: input.currentDraft,
    originalDraft: input.originalDraft,
    evidenceBank: input.evidenceBank,
    context: input.context,
    instruction: input.instruction,
    previousSummary: input.previousSummary,
    metering: input.metering ?? null,
  });
  const parsed = bugReportDraftRevisionResponseSchema.parse(response);
  if (parsed.operation === "unsupported") {
    if (isRelatedIssueUnlinkInstruction(input.instruction)) {
      return maybeApplyRelatedIssueUnlinkFallback({
        currentDraft: input.currentDraft,
        context: input.context,
        instruction: input.instruction,
      });
    }

    return unsupportedRevision(input.currentDraft);
  }
  const draft = validateRevisedBugReportDraft({
    draft: parsed.draft,
    currentDraft: input.currentDraft,
    originalDraft: input.originalDraft,
    evidenceBank: input.evidenceBank,
    context: input.context,
  });

  if (
    (parsed.operation === "unlink_related_issue" || isRelatedIssueUnlinkInstruction(input.instruction)) &&
    countDuplicateIssueIdRemovals({ before: input.currentDraft, after: draft }) === 0
  ) {
    return maybeApplyRelatedIssueUnlinkFallback({
      currentDraft: input.currentDraft,
      context: input.context,
      instruction: input.instruction,
    });
  }

  return {
    draft,
    summary: parsed.summary,
    isHandled: true,
    operation: parsed.operation,
  };
}

function reviseBugReportDraftWithDeterministicFallback(input: {
  currentDraft: BugReportDraft;
  originalDraft: BugReportDraft | null;
  evidenceBank: BugReportEvidenceBankItem[];
  context: BugReportLinearContext;
  instruction: string;
}) {
  if (isRelatedIssueUnlinkInstruction(input.instruction)) {
    const unlinkRevision = maybeApplyRelatedIssueUnlinkFallback({
      currentDraft: input.currentDraft,
      context: input.context,
      instruction: input.instruction,
    });
    if (unlinkRevision.isHandled) {
      return {
        ...unlinkRevision,
        draft: validateRevisedBugReportDraft({
          draft: unlinkRevision.draft,
          currentDraft: input.currentDraft,
          originalDraft: input.originalDraft,
          evidenceBank: input.evidenceBank,
          context: input.context,
        }),
      } satisfies BugReportRevisionResult;
    }

    return unlinkRevision;
  }

  const deterministicRevision = reviseBugReportDraftDeterministically({
    currentDraft: input.currentDraft,
    instruction: input.instruction,
    originalDraft: input.originalDraft,
  });
  if (!deterministicRevision.isHandled) {
    return null;
  }

  return {
    ...deterministicRevision,
    draft: validateRevisedBugReportDraft({
      draft: deterministicRevision.draft,
      currentDraft: input.currentDraft,
      originalDraft: input.originalDraft,
      evidenceBank: input.evidenceBank,
      context: input.context,
    }),
  } satisfies BugReportRevisionResult;
}

function cleanSearchTerms(terms: string[]) {
  return Array.from(
    new Set(
      terms
        .map((term) =>
          term
            .replace(/[^a-zA-Z0-9\s/-]/g, " ")
            .replace(/\s+/g, " ")
            .trim(),
        )
        .filter((term) => term.length >= LINEAR_SEARCH_TERM_MIN_LENGTH)
        .map((term) => term.slice(0, LINEAR_SEARCH_TERM_MAX_LENGTH)),
    ),
  ).slice(0, LINEAR_SEARCH_TERMS_LIMIT);
}

function searchTermsForCandidate(input: {
  candidate: BugReportIssuePlanCandidate;
  evidenceSpans: BugReportIssueEvidenceSpan[];
}) {
  return cleanSearchTerms([
    input.candidate.title,
    ...input.candidate.searchTerms,
    ...input.evidenceSpans.map((span) => span.excerpt),
  ]);
}

type LinearIssueSample = {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  labels: { nodes: { name: string }[] };
};

function scoreSampleQuality(samples: LinearIssueSample[]) {
  const useful = samples.filter((issue) => {
    const description = issue.description ?? "";
    const hasSections = /impact|repro|steps|expected|actual|severity/i.test(description);

    return description.length > LINEAR_SAMPLE_DESCRIPTION_MIN_LENGTH && hasSections;
  });

  if (samples.length === 0) {
    return {
      quality: "unknown" as const,
      notes: [CAPABILITY_WORKFLOW_MESSAGES.noLinearSamplesNote],
      suggestedSections: [...CAPABILITY_WORKFLOW_MESSAGES.linearSuggestedSections],
    };
  }

  if (useful.length >= Math.min(LINEAR_SAMPLE_USEFUL_MIN_COUNT, samples.length)) {
    return {
      quality: "good" as const,
      notes: [CAPABILITY_WORKFLOW_MESSAGES.goodLinearSamplesNote],
      suggestedSections: [...CAPABILITY_WORKFLOW_MESSAGES.linearSuggestedSections],
    };
  }

  return {
    quality: "poor" as const,
    notes: [CAPABILITY_WORKFLOW_MESSAGES.poorLinearSamplesNote],
    suggestedSections: [...CAPABILITY_WORKFLOW_MESSAGES.linearSuggestedSections],
  };
}

function linearDuplicateLine(duplicate: BugReportLinearContext["duplicateIssues"][number]) {
  const identifier = duplicate.identifier ?? "";
  const url = duplicate.url ?? "";
  const identifierPrefix = identifier.length > 0 ? [identifier, ": "].join("") : "";
  const urlSuffix = url.length > 0 ? [" (", url, ")"].join("") : "";

  return ["- ", identifierPrefix, duplicate.title, urlSuffix].join("");
}

function buildLinearIssueDescription(input: {
  draft: BugReportIssueDraft;
  duplicates: BugReportLinearContext["duplicateIssues"];
}) {
  const duplicateLines = input.duplicates
    .filter((duplicate) => input.draft.duplicateIssueIds.includes(duplicate.id))
    .map((duplicate) => linearDuplicateLine(duplicate));

  return [
    `## Problem`,
    input.draft.description,
    "",
    `## Impact`,
    input.draft.impact,
    "",
    `## Severity`,
    input.draft.severity,
    "",
    `## Reproduction context`,
    input.draft.reproductionContext ?? CAPABILITY_WORKFLOW_MESSAGES.reproductionNotCaptured,
    "",
    `## Evidence from meeting`,
    ...(input.draft.evidence.length !== 0
      ? input.draft.evidence.map((item) => `- ${item}`)
      : [CAPABILITY_WORKFLOW_MESSAGES.noDirectEvidenceCaptured]),
    "",
    `## Possible duplicates`,
    ...(duplicateLines.length !== 0 ? duplicateLines : [CAPABILITY_WORKFLOW_MESSAGES.noDuplicatesFoundNote]),
  ].join("\n");
}

function validateDraftIssuesForSync(issueDrafts: BugReportIssueDraft[]) {
  if (issueDrafts.length === 0) {
    throw new Error(CAPABILITY_WORKFLOW_MESSAGES.noGroundedIssuesReadyToSync);
  }

  const ungroundedIssue = issueDrafts.find((issue) => issue.evidenceSpans.length === 0);
  if (ungroundedIssue !== undefined) {
    throw new Error(issueNeedsEvidenceBeforeSyncMessage(ungroundedIssue.title));
  }
}

function impactFromEvidence(input: {
  candidate: BugReportIssuePlanCandidate;
  evidenceSpans: BugReportIssueEvidenceSpan[];
}) {
  if (input.candidate.severity === "high") {
    return CAPABILITY_WORKFLOW_MESSAGES.highImpactFromEvidence;
  }
  if (hasEvidenceOverlap({ value: input.candidate.description, evidenceSpans: input.evidenceSpans })) {
    return CAPABILITY_WORKFLOW_MESSAGES.impactConfirmFromEvidence;
  }

  return CAPABILITY_WORKFLOW_MESSAGES.impactConfirmBeforePrioritization;
}

function emptyBugReportDraft(input: { context: BugReportLinearContext }) {
  return bugReportDraftSchema.parse({
    title: CAPABILITY_WORKFLOW_MESSAGES.emptyDraftTitle,
    description: CAPABILITY_WORKFLOW_MESSAGES.emptyDraftDescription,
    severity: "low",
    impact: CAPABILITY_WORKFLOW_MESSAGES.emptyDraftImpact,
    reproductionContext: null,
    evidence: [],
    evidenceSpans: [],
    scopeReason: CAPABILITY_WORKFLOW_MESSAGES.emptyDraftScopeReason,
    confidence: "low",
    duplicateIssueIds: [],
    teamId: input.context.teamId,
    teamName: input.context.teamName,
    labels: ["bug"],
    issues: [],
  });
}

function buildBugReportDraft(input: {
  context: BugReportLinearContext;
  validatedCandidates: {
    candidate: BugReportIssuePlanCandidate;
    evidenceSpans: BugReportIssueEvidenceSpan[];
    duplicateIssueIds: string[];
  }[];
  evidenceBank: BugReportEvidenceBankItem[];
}) {
  if (input.validatedCandidates.length === 0) {
    return emptyBugReportDraft({
      context: input.context,
    });
  }

  const issues = input.validatedCandidates.map(({ candidate, evidenceSpans, duplicateIssueIds }) => {
    const evidence = evidenceSpans.map((span) => span.excerpt);

    return bugReportIssueDraftSchema.parse({
      title: truncate({ value: cleanBugTitle(candidate.title), maxLength: ISSUE_TITLE_TRUNCATE_LENGTH }),
      description: groundedDescription({ candidate, evidenceSpans }),
      severity: candidate.severity,
      impact: impactFromEvidence({ candidate, evidenceSpans }),
      reproductionContext: groundedReproductionContext({ candidate, evidenceSpans }),
      evidence,
      evidenceSpans,
      scopeReason: candidate.scopeReason,
      confidence: candidate.confidence,
      duplicateIssueIds,
      teamId: input.context.teamId,
      teamName: input.context.teamName,
      labels: ["bug"],
    });
  });
  const primaryIssue = issues[0];
  if (!primaryIssue) {
    return emptyBugReportDraft({
      context: input.context,
    });
  }

  return bugReportDraftSchema.parse({
    ...primaryIssue,
    issues,
  });
}

function buildBugReportPlan(input: {
  draft: BugReportDraft;
  context: BugReportLinearContext;
  summary?: string;
  skippedCandidates?: BugReportSkippedCandidate[];
}): BugReportPlan {
  const hasDuplicates = input.context.duplicateIssues.length !== 0;

  return bugReportPlanSchema.parse({
    summary: input.summary ?? buildDraftListSummary(input.draft),
    suggestedAction: hasDuplicates ? "create_new_issue_with_duplicate_links" : "create_new_issue",
    duplicateRationale: hasDuplicates ? CAPABILITY_WORKFLOW_MESSAGES.duplicateRationale : null,
    scopeReason: input.draft.scopeReason,
    confidence: input.draft.confidence,
    skippedCandidates: input.skippedCandidates ?? [],
    draft: input.draft,
  });
}

function linearTokenSetFromSecretRef(secretRef: string): LinearTokenSet {
  const decoded = decryptJsonSecret(secretRef);
  if (!isRecord(decoded)) {
    throw new Error(CAPABILITY_WORKFLOW_MESSAGES.linearNotConnected);
  }
  const accessToken = typeof decoded.accessToken === "string" ? decoded.accessToken : "";
  const refreshToken = typeof decoded.refreshToken === "string" ? decoded.refreshToken : "";
  const expiresAt = typeof decoded.expiresAt === "string" ? decoded.expiresAt : "";
  const scope = typeof decoded.scope === "string" ? decoded.scope : "";
  const tokenType = typeof decoded.tokenType === "string" ? decoded.tokenType : "";
  if (
    accessToken.length === 0 ||
    refreshToken.length === 0 ||
    expiresAt.length === 0 ||
    scope.length === 0 ||
    tokenType.length === 0
  ) {
    throw new Error(CAPABILITY_WORKFLOW_MESSAGES.linearNotConnected);
  }

  return {
    accessToken,
    refreshToken,
    expiresAt,
    scope,
    tokenType,
  };
}

async function getLinearConnection(user: WorkflowUser) {
  const connector = await repositories().getAgentConnectorForUser({ userId: user.id, provider: "linear" });
  if (!connector || connector.status !== "connected") {
    return null;
  }
  const secret = await repositories().getLatestAgentConnectorSecret(connector.id);
  if (!secret) {
    return null;
  }

  const currentTokens = linearTokenSetFromSecretRef(secret.secretRef);
  const expiresAtMs = new Date(currentTokens.expiresAt).getTime();
  const shouldRefresh = Number.isFinite(expiresAtMs) && expiresAtMs - Date.now() < LINEAR_TOKEN_REFRESH_WINDOW_MS;
  const tokens = shouldRefresh ? await refreshLinearToken(currentTokens) : currentTokens;
  if (shouldRefresh) {
    const profile = await repositories().ensureDefaultAgentProfileForUser({
      userId: user.id,
      displayName: user.displayName,
      voiceId: null,
      llmModel: null,
    });
    await repositories().upsertAgentConnector({
      userId: user.id,
      agentProfileId: profile.id,
      provider: "linear",
      status: "connected",
      scope: "private",
      externalAccountEmail: connector.externalAccountEmail,
      secretRef: encryptJsonSecret(tokens),
    });
  }

  return { connector, tokens };
}

async function buildWorkflowToolContext(input: {
  user: WorkflowUser;
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
    utteranceId: `workflow:${input.suffix}`.slice(0, WORKFLOW_UTTERANCE_ID_MAX_LENGTH),
    requestingUserId: input.user.id,
    activeSpeakerUserId: input.user.id,
    agentProfileId: profile.id,
    allowedToolScope: "private",
    createdAt: new Date().toISOString(),
  };
}

async function recordWorkflowCreditUsageSafely(input: {
  user: WorkflowUser;
  meetingId: string;
  workflowRunId: string;
  actionType: string;
  actionLabel: string;
  occurredAfter: Date;
  metadata?: Record<string, unknown>;
}) {
  try {
    await repositories().recordAiCreditUsageForScope({
      userId: input.user.id,
      meetingId: input.meetingId,
      workflowRunId: input.workflowRunId,
      actionType: input.actionType,
      actionLabel: input.actionLabel,
      sources: ["capability_workflow"],
      occurredAfter: input.occurredAfter,
      idempotencyKey: `credit:workflow:${input.workflowRunId}:${input.actionType}:${input.occurredAfter.getTime()}`,
      metadata: input.metadata,
    });
  } catch (error) {
    console.error(CAPABILITY_WORKFLOW_LOG.creditUsageFailed, error instanceof Error ? error.message : error);
  }
}

type LinearTeamSummary = { id: string; name: string; key: string };

function linearTeamsFromToolResult(result: unknown): LinearTeamSummary[] {
  if (!isRecord(result)) {
    return [];
  }
  const teamsValue = result.teams;
  if (!Array.isArray(teamsValue)) {
    return [];
  }

  return teamsValue.flatMap((entry) => {
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

function linearIssueSamplesFromToolResult(result: unknown): LinearIssueSample[] {
  if (!isRecord(result)) {
    return [];
  }
  const issuesValue = result.issues;
  if (!Array.isArray(issuesValue)) {
    return [];
  }

  return issuesValue.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const id = typeof entry.id === "string" ? entry.id : "";
    const identifier = typeof entry.identifier === "string" ? entry.identifier : "";
    const title = typeof entry.title === "string" ? entry.title : "";
    if (id.length === 0 || identifier.length === 0 || title.length === 0) {
      return [];
    }

    return [
      {
        id,
        identifier,
        title,
        description: typeof entry.description === "string" ? entry.description : null,
        labels: { nodes: [] },
      },
    ];
  });
}

function linearSearchIssuesFromToolResult(result: unknown): BugReportLinearContext["duplicateIssues"] {
  if (!isRecord(result)) {
    return [];
  }
  const issuesValue = result.issues;
  if (!Array.isArray(issuesValue)) {
    return [];
  }

  return issuesValue.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const id = typeof entry.id === "string" ? entry.id : "";
    const identifier = typeof entry.identifier === "string" ? entry.identifier : "";
    const title = typeof entry.title === "string" ? entry.title : "";
    const rationale = typeof entry.rationale === "string" ? entry.rationale : "";
    if (id.length === 0 || identifier.length === 0 || title.length === 0) {
      return [];
    }

    return [
      {
        id,
        identifier,
        title,
        status: typeof entry.status === "string" ? entry.status : null,
        url: typeof entry.url === "string" ? entry.url : "",
        rationale,
      },
    ];
  });
}

function linearCreatedIssueFromToolResult(
  result: unknown,
): { id: string; identifier: string; title: string; url: string } | null {
  if (!isRecord(result)) {
    return null;
  }
  const issueValue = result.issue;
  if (!isRecord(issueValue)) {
    return null;
  }
  const id = typeof issueValue.id === "string" ? issueValue.id : "";
  const identifier = typeof issueValue.identifier === "string" ? issueValue.identifier : "";
  const title = typeof issueValue.title === "string" ? issueValue.title : "";
  const url = typeof issueValue.url === "string" ? issueValue.url : "";
  if (id.length === 0 || identifier.length === 0 || title.length === 0 || url.length === 0) {
    return null;
  }

  return { id, identifier, title, url };
}

async function gatherLinearContext(input: {
  user: WorkflowUser;
  meetingId: string;
  existingConnection?: NonNullable<Awaited<ReturnType<typeof getLinearConnection>>>;
}): Promise<BugReportLinearContext> {
  const connection = input.existingConnection ?? (await getLinearConnection(input.user));
  if (!connection) {
    return bugReportLinearContextSchema.parse({
      provider: "linear",
      /** @external bug report linear connected flag */
      connected: false,
      teamId: null,
      teamName: null,
      duplicateIssues: [],
      sampledFormat: {
        quality: "unknown",
        notes: [CAPABILITY_WORKFLOW_MESSAGES.connectLinearNote],
        suggestedSections: [...CAPABILITY_WORKFLOW_MESSAGES.linearSuggestedSections],
      },
    });
  }

  const toolContext = await buildWorkflowToolContext({
    user: input.user,
    meetingId: input.meetingId,
    suffix: "linear-context",
  });
  const teamsResult = await executeAgentTool({
    context: toolContext,
    user: input.user,
    toolName: "linear.list_teams",
    args: {},
    idempotencyKey: `workflow:${input.meetingId}:linear.list_teams`,
  });
  const teams = linearTeamsFromToolResult(teamsResult.result);
  const team = teams[0] ?? null;
  const samplesResult = team
    ? await executeAgentTool({
        context: toolContext,
        user: input.user,
        toolName: "linear.sample_issues",
        args: { teamId: team.id },
        idempotencyKey: `workflow:${input.meetingId}:linear.sample_issues:${team.id}`,
      })
    : null;
  const sampledFormat = scoreSampleQuality(linearIssueSamplesFromToolResult(samplesResult?.result));

  return bugReportLinearContextSchema.parse({
    provider: "linear",
    /** @external bug report linear connected flag */
    connected: true,
    teamId: team?.id ?? null,
    teamName: team?.name ?? null,
    duplicateIssues: [],
    sampledFormat,
  });
}

async function searchLinearDuplicatesForCandidate(input: {
  user: WorkflowUser;
  meetingId: string;
  candidate: BugReportIssuePlanCandidate;
  evidenceSpans: BugReportIssueEvidenceSpan[];
}) {
  const duplicateMap = await searchTermsForCandidate(input).reduce(async (previous, term) => {
    const map = await previous;
    const toolContext = await buildWorkflowToolContext({
      user: input.user,
      meetingId: input.meetingId,
      suffix: `linear-search:${input.candidate.title}:${term}`,
    });
    const results = await executeAgentTool({
      context: toolContext,
      user: input.user,
      toolName: "linear.search_issues",
      args: { term },
      idempotencyKey: `workflow:${input.meetingId}:linear.search_issues:${input.candidate.title}:${term}`,
    });
    const issues = linearSearchIssuesFromToolResult(results.result);
    const nextMap = new Map(map);
    issues.forEach((issue) => {
      nextMap.set(issue.id, {
        ...issue,
        rationale: matchedSearchTermRationale(term),
      });
    });

    return nextMap;
  }, Promise.resolve(new Map<string, BugReportLinearContext["duplicateIssues"][number]>()));

  return Array.from(duplicateMap.values()).slice(0, LINEAR_DUPLICATE_RESULTS_LIMIT);
}

function validatePlannedBugReportCandidates(input: {
  issuePlanning: Awaited<ReturnType<typeof planBugReportIssueCandidates>>;
  evidenceById: Map<string, BugReportEvidenceBankItem>;
}) {
  return input.issuePlanning.candidates.reduce<{
    skippedCandidates: BugReportSkippedCandidate[];
    validatedCandidates: {
      candidate: BugReportIssuePlanCandidate;
      evidenceSpans: BugReportIssueEvidenceSpan[];
      duplicateIssueIds: string[];
    }[];
  }>(
    (state, candidate) => {
      const evidenceSpans = validateIssueCandidateEvidence({
        candidate,
        evidenceById: input.evidenceById,
      });
      if (evidenceSpans === null) {
        return {
          skippedCandidates: [
            ...state.skippedCandidates,
            {
              title: candidate.title,
              reason: CAPABILITY_WORKFLOW_MESSAGES.skippedPlannerNoEvidence,
              evidenceIds: candidate.evidenceIds,
            },
          ],
          validatedCandidates: state.validatedCandidates,
        };
      }

      return {
        skippedCandidates: state.skippedCandidates,
        validatedCandidates: [
          ...state.validatedCandidates,
          {
            candidate,
            evidenceSpans,
            duplicateIssueIds: [],
          },
        ],
      };
    },
    { skippedCandidates: [...input.issuePlanning.skippedCandidates], validatedCandidates: [] },
  );
}

async function searchDuplicatesForValidatedCandidates(input: {
  user: WorkflowUser;
  meetingId: string;
  validatedCandidates: {
    candidate: BugReportIssuePlanCandidate;
    evidenceSpans: BugReportIssueEvidenceSpan[];
    duplicateIssueIds: string[];
  }[];
}) {
  return input.validatedCandidates.reduce<
    Promise<{
      validatedCandidates: {
        candidate: BugReportIssuePlanCandidate;
        evidenceSpans: BugReportIssueEvidenceSpan[];
        duplicateIssueIds: string[];
      }[];
      duplicateMap: Map<string, BugReportLinearContext["duplicateIssues"][number]>;
    }>
  >(
    async (previous, validatedCandidate) => {
      const state = await previous;
      const duplicates = await searchLinearDuplicatesForCandidate({
        user: input.user,
        meetingId: input.meetingId,
        candidate: validatedCandidate.candidate,
        evidenceSpans: validatedCandidate.evidenceSpans,
      });
      const duplicateIssueIds = duplicates.map((duplicate) => duplicate.id);
      const duplicateMap = new Map(state.duplicateMap);
      duplicates.forEach((duplicate) => {
        duplicateMap.set(duplicate.id, duplicate);
      });

      return {
        validatedCandidates: [
          ...state.validatedCandidates,
          {
            ...validatedCandidate,
            duplicateIssueIds,
          },
        ],
        duplicateMap,
      };
    },
    Promise.resolve({ validatedCandidates: [], duplicateMap: new Map() }),
  );
}

async function publishBugReportWorkflowReview(input: {
  user: WorkflowUser;
  workflowRunId: string;
  recommendation: Recommendation;
  context: BugReportLinearContext;
  evidenceBank: BugReportEvidenceBankItem[];
  issuePlanning: Awaited<ReturnType<typeof planBugReportIssueCandidates>>;
  skippedCandidates: BugReportSkippedCandidate[];
  draft: BugReportDraft;
  plan: BugReportPlan;
  draftingStartedAt: Date;
}) {
  const workflow = await repositories().updateCapabilityWorkflowRun({
    workflowRunId: input.workflowRunId,
    status: "awaiting_user",
    phase: "awaiting_user_review",
    context: {
      ...input.context,
      evidenceBank: input.evidenceBank,
      issuePlanning: input.issuePlanning,
      skippedCandidates: input.skippedCandidates,
      originalDraft: input.draft,
    },
    plan: input.plan,
    draft: input.draft,
    error: null,
  });
  const messages = await repositories().listCapabilityWorkflowMessages(workflow.id);
  if (messages.length === 0) {
    await repositories().addCapabilityWorkflowMessage({
      workflowRunId: workflow.id,
      role: "assistant",
      content: input.plan.summary,
      metadata: { plan: input.plan },
    });
  }
  await recordWorkflowCreditUsageSafely({
    user: input.user,
    meetingId: input.recommendation.meetingId,
    workflowRunId: workflow.id,
    actionType: "linear_issue_drafting",
    actionLabel: CAPABILITY_WORKFLOW_MESSAGES.linearIssueDraftingLabel,
    occurredAfter: input.draftingStartedAt,
    metadata: {
      issueCount: issueDraftsFromDraft(input.draft).length,
      recommendationId: input.recommendation.id,
    },
  });
}

async function runConnectedBugReportWorkflow(input: {
  user: WorkflowUser;
  workflowRunId: string;
  recommendation: Recommendation;
  baseContext: BugReportLinearContext;
}) {
  await repositories().updateCapabilityWorkflowRun({
    workflowRunId: input.workflowRunId,
    status: "running",
    phase: "reviewing_evidence",
    context: input.baseContext,
    error: null,
  });
  const evidenceBank = await buildBugReportEvidenceBank(input.recommendation);
  await repositories().updateCapabilityWorkflowRun({
    workflowRunId: input.workflowRunId,
    status: "running",
    phase: "scoping_issues",
    context: { ...input.baseContext, evidenceBank },
    error: null,
  });
  const draftingStartedAt = new Date();
  const issuePlanning = await planBugReportIssueCandidates({
    recommendation: input.recommendation,
    evidenceBank,
    metering: { meetingId: input.recommendation.meetingId, workflowRunId: input.workflowRunId },
  });
  await repositories().updateCapabilityWorkflowRun({
    workflowRunId: input.workflowRunId,
    status: "running",
    phase: "validating_issue_evidence",
    context: { ...input.baseContext, evidenceBank, issuePlanning },
    error: null,
  });
  const evidenceById = new Map(evidenceBank.map((evidence) => [evidence.id, evidence]));
  const validationResult = validatePlannedBugReportCandidates({ issuePlanning, evidenceById });
  await repositories().updateCapabilityWorkflowRun({
    workflowRunId: input.workflowRunId,
    status: "running",
    phase: "searching_linear",
    context: {
      ...input.baseContext,
      evidenceBank,
      issuePlanning,
      skippedCandidates: validationResult.skippedCandidates,
    },
    error: null,
  });
  const duplicateSearch = await searchDuplicatesForValidatedCandidates({
    user: input.user,
    meetingId: input.recommendation.meetingId,
    validatedCandidates: validationResult.validatedCandidates,
  });
  const context = bugReportLinearContextSchema.parse({
    ...input.baseContext,
    duplicateIssues: Array.from(duplicateSearch.duplicateMap.values()).slice(0, LINEAR_DUPLICATE_CONTEXT_LIMIT),
  });
  await repositories().updateCapabilityWorkflowRun({
    workflowRunId: input.workflowRunId,
    status: "running",
    phase: "preparing_drafts",
    context: {
      ...context,
      evidenceBank,
      issuePlanning,
      skippedCandidates: validationResult.skippedCandidates,
    },
    error: null,
  });
  const draft = buildBugReportDraft({
    context,
    validatedCandidates: duplicateSearch.validatedCandidates,
    evidenceBank,
  });
  const plan = buildBugReportPlan({
    draft,
    context,
    summary: issueDraftsFromDraft(draft).length !== 0 ? buildDraftListSummary(draft) : issuePlanning.summary,
    skippedCandidates: validationResult.skippedCandidates,
  });
  await publishBugReportWorkflowReview({
    user: input.user,
    workflowRunId: input.workflowRunId,
    recommendation: input.recommendation,
    context,
    evidenceBank,
    issuePlanning,
    skippedCandidates: validationResult.skippedCandidates,
    draft,
    plan,
    draftingStartedAt,
  });
}

async function executeBugReportWorkflow(input: {
  user: WorkflowUser;
  workflowRunId: string;
  recommendationId: string;
}) {
  try {
    const recommendation = await repositories().getRecommendationById(input.recommendationId);
    if (!recommendation) {
      throw new Error(CAPABILITY_WORKFLOW_MESSAGES.recommendationNotFound);
    }

    await repositories().updateCapabilityWorkflowRun({
      workflowRunId: input.workflowRunId,
      status: "running",
      phase: "checking_connection",
      error: null,
    });
    const connection = await getLinearConnection(input.user);
    const baseContext = await gatherLinearContext({
      user: input.user,
      meetingId: recommendation.meetingId,
      existingConnection: connection ?? undefined,
    });
    if (!connection || !baseContext.connected) {
      await repositories().updateCapabilityWorkflowRun({
        workflowRunId: input.workflowRunId,
        status: "needs_connection",
        phase: "needs_connection",
        context: baseContext,
        error: CAPABILITY_WORKFLOW_MESSAGES.linearNotConnected,
      });

      return;
    }

    await runConnectedBugReportWorkflow({
      user: input.user,
      workflowRunId: input.workflowRunId,
      recommendation,
      baseContext,
    });
  } catch (error) {
    await repositories().updateCapabilityWorkflowRun({
      workflowRunId: input.workflowRunId,
      status: "failed",
      phase: "failed",
      error: error instanceof Error ? error.message : CAPABILITY_WORKFLOW_MESSAGES.bugReportWorkflowFailed,
    });
  }
}

async function executeMeetingCoachingWorkflow(input: {
  user: WorkflowUser;
  workflowRunId: string;
  recommendationId: string;
  focus?: string | null;
  previousFeedback?: MeetingCoachingFeedback | null;
}) {
  try {
    const recommendation = await repositories().getRecommendationById(input.recommendationId);
    if (!recommendation) {
      throw new Error(CAPABILITY_WORKFLOW_MESSAGES.recommendationNotFound);
    }

    await repositories().updateCapabilityWorkflowRun({
      workflowRunId: input.workflowRunId,
      status: "running",
      phase: "reading_meeting",
      error: null,
    });
    const context = await buildMeetingCoachingContext({
      user: input.user,
      recommendation,
    });

    await repositories().updateCapabilityWorkflowRun({
      workflowRunId: input.workflowRunId,
      status: "running",
      phase: "analyzing_meeting",
      context,
      error: null,
    });

    await repositories().updateCapabilityWorkflowRun({
      workflowRunId: input.workflowRunId,
      status: "running",
      phase: "generating_feedback",
      context,
      error: null,
    });
    const coachingStartedAt = new Date();
    const response = meetingCoachingGenerationResponseSchema.parse(
      await triggerMeetingCoachingFeedback({
        context,
        focus: input.focus ?? null,
        previousFeedback: input.previousFeedback ?? null,
        metering: {
          meetingId: recommendation.meetingId,
          workflowRunId: input.workflowRunId,
        },
      }),
    );
    const feedback = filterFeedbackEvidenceToTranscript({
      feedback: response.feedback,
      transcriptData: await repositories().getTranscriptForMeeting(recommendation.meetingId),
    });
    const plan = {
      ...buildMeetingCoachingPlan(feedback),
      model: response.model,
      promptVersion: response.promptVersion,
      focus: input.focus ?? null,
    };

    const workflow = await repositories().updateCapabilityWorkflowRun({
      workflowRunId: input.workflowRunId,
      status: "awaiting_user",
      phase: "awaiting_user_review",
      context,
      plan,
      draft: feedback,
      error: null,
    });

    await repositories().addCapabilityWorkflowMessage({
      workflowRunId: workflow.id,
      role: "assistant",
      content: feedback.summary,
      metadata: {
        plan,
        feedback,
      },
    });
    await recordWorkflowCreditUsageSafely({
      user: input.user,
      meetingId: recommendation.meetingId,
      workflowRunId: workflow.id,
      actionType: "coaching_feedback",
      actionLabel: CAPABILITY_WORKFLOW_MESSAGES.meetingFeedbackLabel,
      occurredAfter: coachingStartedAt,
      metadata: {
        recommendationId: recommendation.id,
        focus: input.focus ?? null,
      },
    });
  } catch (error) {
    await repositories().updateCapabilityWorkflowRun({
      workflowRunId: input.workflowRunId,
      status: "failed",
      phase: "failed",
      error: error instanceof Error ? error.message : CAPABILITY_WORKFLOW_MESSAGES.meetingFeedbackFailed,
    });
  }
}

async function startBugReportWorkflow(input: {
  user: WorkflowUser;
  recommendationId: string;
  /** @external capability workflow force refresh flag */
  forceRefresh?: boolean;
}): Promise<CapabilityWorkflowWithMessages> {
  const recommendation = await repositories().getRecommendationById(input.recommendationId);
  if (!recommendation) {
    throw new Error(CAPABILITY_WORKFLOW_MESSAGES.recommendationNotFound);
  }
  if (recommendation.capabilityKey !== BUG_REPORT_CAPABILITY_KEY) {
    throw new Error(CAPABILITY_WORKFLOW_MESSAGES.bugReportOnly);
  }

  const meeting = await repositories().getMeetingById(recommendation.meetingId);
  if (!meeting || meeting.createdByUserId !== input.user.id) {
    throw new Error(CAPABILITY_WORKFLOW_MESSAGES.meetingNotFound);
  }

  const existing = await repositories().getCapabilityWorkflowRunByRecommendationId(recommendation.id);
  if (
    !(input.forceRefresh ?? false) &&
    existing &&
    existing.phase !== "failed" &&
    existing.phase !== "needs_connection"
  ) {
    return {
      workflow: existing,
      messages: await repositories().listCapabilityWorkflowMessages(existing.id),
    };
  }

  const initial = await repositories().upsertCapabilityWorkflowRun({
    meetingId: recommendation.meetingId,
    recommendationId: recommendation.id,
    capabilityKey: recommendation.capabilityKey,
    status: "running",
    phase: "checking_connection",
    context: {},
    plan: {},
    draft: {},
    result: {},
    error: null,
    completedAt: null,
  });

  void executeBugReportWorkflow({
    user: input.user,
    workflowRunId: initial.id,
    recommendationId: recommendation.id,
  });

  return {
    workflow: initial,
    messages: await repositories().listCapabilityWorkflowMessages(initial.id),
  };
}

async function startMeetingCoachingWorkflow(input: {
  user: WorkflowUser;
  recommendationId: string;
  /** @external capability workflow force refresh flag */
  forceRefresh?: boolean;
}): Promise<CapabilityWorkflowWithMessages> {
  const recommendation = await repositories().getRecommendationById(input.recommendationId);
  if (!recommendation) {
    throw new Error(CAPABILITY_WORKFLOW_MESSAGES.recommendationNotFound);
  }
  if (recommendation.capabilityKey !== MEETING_COACHING_CAPABILITY_KEY) {
    throw new Error(CAPABILITY_WORKFLOW_MESSAGES.meetingFeedbackOnlyPath);
  }

  const meeting = await repositories().getMeetingById(recommendation.meetingId);
  if (!meeting || meeting.createdByUserId !== input.user.id) {
    throw new Error(CAPABILITY_WORKFLOW_MESSAGES.meetingNotFound);
  }

  const existing = await repositories().getCapabilityWorkflowRunByRecommendationId(recommendation.id);
  if (!(input.forceRefresh ?? false) && existing && existing.phase !== "failed") {
    return {
      workflow: existing,
      messages: await repositories().listCapabilityWorkflowMessages(existing.id),
    };
  }

  const initial = await repositories().upsertCapabilityWorkflowRun({
    meetingId: recommendation.meetingId,
    recommendationId: recommendation.id,
    capabilityKey: recommendation.capabilityKey,
    status: "running",
    phase: "reading_meeting",
    context: {},
    plan: {},
    draft: {},
    result: {},
    error: null,
    completedAt: null,
  });

  void executeMeetingCoachingWorkflow({
    user: input.user,
    workflowRunId: initial.id,
    recommendationId: recommendation.id,
  });

  return {
    workflow: initial,
    messages: await repositories().listCapabilityWorkflowMessages(initial.id),
  };
}

export async function startCapabilityWorkflow(input: {
  user: WorkflowUser;
  recommendationId: string;
  /** @external capability workflow force refresh flag */
  forceRefresh?: boolean;
}): Promise<CapabilityWorkflowWithMessages> {
  const recommendation = await repositories().getRecommendationById(input.recommendationId);
  if (!recommendation) {
    throw new Error(CAPABILITY_WORKFLOW_MESSAGES.recommendationNotFound);
  }

  if (recommendation.capabilityKey === BUG_REPORT_CAPABILITY_KEY) {
    return startBugReportWorkflow(input);
  }

  if (recommendation.capabilityKey === MEETING_COACHING_CAPABILITY_KEY) {
    return startMeetingCoachingWorkflow(input);
  }

  throw new Error(CAPABILITY_WORKFLOW_MESSAGES.workflowNotBuilt);
}

async function reviseBugReportWorkflow(input: {
  user: WorkflowUser;
  workflowRunId: string;
  content: string;
}): Promise<CapabilityWorkflowWithMessages> {
  const workflow = await requireWorkflowOwner({ workflowRunId: input.workflowRunId, userId: input.user.id });
  await repositories().addCapabilityWorkflowMessage({
    workflowRunId: workflow.id,
    role: "user",
    content: input.content,
  });

  const currentDraft = bugReportDraftSchema.parse(workflow.draft);
  const context = bugReportLinearContextSchema.parse(workflow.context);
  const currentPlan = bugReportPlanSchema.safeParse(workflow.plan);
  const rawContext = recordOrEmpty(workflow.context);
  const parsedOriginalDraft = bugReportDraftSchema.safeParse(rawContext.originalDraft);
  const originalDraft = parsedOriginalDraft.success ? parsedOriginalDraft.data : currentDraft;
  const evidenceBank = evidenceBankFromWorkflowContext(rawContext);
  const revision = await (async (): Promise<BugReportRevisionResult> => {
    try {
      const assisted = await reviseBugReportDraftWithAssistant({
        currentDraft,
        originalDraft,
        evidenceBank,
        context,
        instruction: input.content,
        previousSummary: currentPlan.success ? currentPlan.data.summary : null,
        metering: {
          meetingId: workflow.meetingId,
          workflowRunId: workflow.id,
        },
      });
      if (assisted.isHandled) {
        return assisted;
      }

      return (
        reviseBugReportDraftWithDeterministicFallback({
          currentDraft,
          originalDraft,
          evidenceBank,
          context,
          instruction: input.content,
        }) ?? assisted
      );
    } catch (error) {
      console.error(CAPABILITY_WORKFLOW_LOG.revisionFallback, error instanceof Error ? error.message : error);
      try {
        return (
          reviseBugReportDraftWithDeterministicFallback({
            currentDraft,
            originalDraft,
            evidenceBank,
            context,
            instruction: input.content,
          }) ?? unsupportedRevision(currentDraft)
        );
      } catch (validationError) {
        console.error(
          CAPABILITY_WORKFLOW_LOG.revisionValidationFailed,
          validationError instanceof Error ? validationError.message : validationError,
        );

        return unsupportedRevision(currentDraft);
      }
    }
  })();
  const plan = {
    ...buildBugReportPlan({ draft: revision.draft, context }),
    summary: revision.summary,
  };

  const updated = await repositories().updateCapabilityWorkflowRun({
    workflowRunId: workflow.id,
    status: "awaiting_user",
    phase: "awaiting_user_review",
    plan,
    draft: revision.draft,
    error: null,
  });
  await repositories().addCapabilityWorkflowMessage({
    workflowRunId: workflow.id,
    role: "assistant",
    content: revision.summary,
    metadata: { plan },
  });

  return {
    workflow: updated,
    messages: await repositories().listCapabilityWorkflowMessages(workflow.id),
  };
}

async function reviseMeetingCoachingWorkflow(input: {
  user: WorkflowUser;
  workflowRunId: string;
  content: string;
}): Promise<CapabilityWorkflowWithMessages> {
  const workflow = await requireWorkflowOwner({ workflowRunId: input.workflowRunId, userId: input.user.id });
  if (workflow.capabilityKey !== MEETING_COACHING_CAPABILITY_KEY) {
    throw new Error(CAPABILITY_WORKFLOW_MESSAGES.meetingFeedbackOnlyPath);
  }

  await repositories().addCapabilityWorkflowMessage({
    workflowRunId: workflow.id,
    role: "user",
    content: input.content,
  });

  const previousFeedback = meetingCoachingFeedbackSchema.safeParse(workflow.draft);
  await repositories().updateCapabilityWorkflowRun({
    workflowRunId: workflow.id,
    status: "running",
    phase: "revising_plan",
    error: null,
  });

  const context = recordOrEmpty(workflow.context);
  const coachingStartedAt = new Date();
  const response = meetingCoachingGenerationResponseSchema.parse(
    await triggerMeetingCoachingFeedback({
      context,
      focus: input.content,
      previousFeedback: previousFeedback.success ? previousFeedback.data : null,
      metering: {
        meetingId: workflow.meetingId,
        workflowRunId: workflow.id,
      },
    }),
  );
  const feedback = filterFeedbackEvidenceToTranscript({
    feedback: response.feedback,
    transcriptData: await repositories().getTranscriptForMeeting(workflow.meetingId),
  });
  const plan = {
    ...buildMeetingCoachingPlan(feedback),
    model: response.model,
    promptVersion: response.promptVersion,
    focus: input.content,
  };
  const updated = await repositories().updateCapabilityWorkflowRun({
    workflowRunId: workflow.id,
    status: "awaiting_user",
    phase: "awaiting_user_review",
    plan,
    draft: feedback,
    error: null,
  });

  await repositories().addCapabilityWorkflowMessage({
    workflowRunId: workflow.id,
    role: "assistant",
    content: feedback.summary,
    metadata: {
      plan,
      feedback,
    },
  });
  await recordWorkflowCreditUsageSafely({
    user: input.user,
    meetingId: workflow.meetingId,
    workflowRunId: workflow.id,
    actionType: "coaching_feedback",
    actionLabel: CAPABILITY_WORKFLOW_MESSAGES.meetingFeedbackFollowUpLabel,
    occurredAfter: coachingStartedAt,
    metadata: {
      focus: input.content,
    },
  });

  return {
    workflow: updated,
    messages: await repositories().listCapabilityWorkflowMessages(workflow.id),
  };
}

export async function reviseCapabilityWorkflow(input: {
  user: WorkflowUser;
  workflowRunId: string;
  content: string;
}): Promise<CapabilityWorkflowWithMessages> {
  const workflow = await requireWorkflowOwner({ workflowRunId: input.workflowRunId, userId: input.user.id });

  if (workflow.capabilityKey === BUG_REPORT_CAPABILITY_KEY) {
    return reviseBugReportWorkflow(input);
  }

  if (workflow.capabilityKey === MEETING_COACHING_CAPABILITY_KEY) {
    return reviseMeetingCoachingWorkflow(input);
  }

  throw new Error(CAPABILITY_WORKFLOW_MESSAGES.workflowNotBuilt);
}

export async function updateBugReportDraft(input: {
  user: WorkflowUser;
  workflowRunId: string;
  draft: BugReportDraft;
}): Promise<CapabilityWorkflowWithMessages> {
  const workflow = await requireWorkflowOwner({ workflowRunId: input.workflowRunId, userId: input.user.id });
  if (workflow.capabilityKey !== BUG_REPORT_CAPABILITY_KEY) {
    throw new Error(CAPABILITY_WORKFLOW_MESSAGES.bugReportDraftOnly);
  }
  const draft = bugReportDraftSchema.parse(input.draft);
  const context = bugReportLinearContextSchema.parse(workflow.context);
  const plan = buildBugReportPlan({ draft, context });
  const updated = await repositories().updateCapabilityWorkflowRun({
    workflowRunId: workflow.id,
    status: "awaiting_user",
    phase: "awaiting_user_review",
    plan,
    draft,
    error: null,
  });

  return {
    workflow: updated,
    messages: await repositories().listCapabilityWorkflowMessages(workflow.id),
  };
}

async function createLinearIssueResultForDraft(input: {
  user: WorkflowUser;
  workflowId: string;
  meetingId: string;
  index: number;
  issueDraft: BugReportIssueDraft;
  duplicates: BugReportLinearContext["duplicateIssues"];
}): Promise<LinearIssueResult> {
  const teamId = input.issueDraft.teamId;
  if (teamId === null || teamId.length === 0) {
    throw new Error(CAPABILITY_WORKFLOW_MESSAGES.chooseLinearTeam);
  }
  const description = buildLinearIssueDescription({
    draft: input.issueDraft,
    duplicates: input.duplicates,
  });
  const toolContext = await buildWorkflowToolContext({
    user: input.user,
    meetingId: input.meetingId,
    suffix: `linear-create:${input.workflowId}:${input.index}`,
  });
  const prepared = await prepareAgentTool({
    context: toolContext,
    user: input.user,
    toolName: "linear.create_issue",
    args: { teamId, title: input.issueDraft.title, description },
    idempotencyKey: `workflow:${input.workflowId}:linear.create_issue:${input.index}`,
  });
  const confirmed = await confirmAgentTool({
    context: toolContext,
    user: input.user,
    pendingInvocationId: prepared.pendingInvocationId,
    confirmationActorUserId: input.user.id,
  });
  const issue = linearCreatedIssueFromToolResult(confirmed.result);
  if (issue === null) {
    throw new Error(CAPABILITY_WORKFLOW_MESSAGES.linearIssueCreateEmpty);
  }

  return linearIssueResultSchema.parse({
    provider: "linear",
    issueId: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    teamId,
    createdAt: new Date().toISOString(),
  });
}

async function syncedNativeTaskCleanup(input: { meetingId: string; issueDrafts: BugReportIssueDraft[] }) {
  try {
    return {
      movedNativeTaskIds: await moveSyncedLinearTasksOutOfReady(input),
      nativeTaskCleanupWarning: null as string | null,
    };
  } catch (cleanupError) {
    console.error(
      CAPABILITY_WORKFLOW_LOG.nativeTaskCleanupFailed,
      cleanupError instanceof Error ? cleanupError.message : cleanupError,
    );

    return {
      movedNativeTaskIds: [],
      nativeTaskCleanupWarning: CAPABILITY_WORKFLOW_MESSAGES.nativeTaskCleanupWarning,
    };
  }
}

async function finalizeBugReportSyncWorkflow(input: {
  workflowId: string;
  results: LinearIssueResult[];
  movedNativeTaskIds: string[];
  nativeTaskCleanupWarning: string | null;
}): Promise<CapabilityWorkflowWithMessages> {
  const syncedIssue = input.results.length === 1 ? input.results[0] : undefined;
  if (input.results.length === 1 && syncedIssue === undefined) {
    throw new Error(CAPABILITY_WORKFLOW_MESSAGES.linearSyncEmpty);
  }
  const result =
    syncedIssue !== undefined
      ? {
          ...syncedIssue,
          movedNativeTaskIds: input.movedNativeTaskIds,
          ...(input.nativeTaskCleanupWarning !== null && input.nativeTaskCleanupWarning.length > 0
            ? { nativeTaskCleanupWarning: input.nativeTaskCleanupWarning }
            : {}),
        }
      : {
          provider: "linear",
          issues: input.results,
          movedNativeTaskIds: input.movedNativeTaskIds,
          ...(input.nativeTaskCleanupWarning !== null && input.nativeTaskCleanupWarning.length > 0
            ? { nativeTaskCleanupWarning: input.nativeTaskCleanupWarning }
            : {}),
        };
  const updated = await repositories().updateCapabilityWorkflowRun({
    workflowRunId: input.workflowId,
    status: "completed",
    phase: "synced",
    result,
    error: null,
    completedAt: new Date(),
  });
  await repositories().addCapabilityWorkflowMessage({
    workflowRunId: input.workflowId,
    role: "assistant",
    content:
      input.results.length === 1
        ? syncedSingleIssueContent(
            input.results[0]?.identifier ?? CAPABILITY_WORKFLOW_MESSAGES.syncedSingleIssueFallback,
          )
        : syncedMultipleIssuesContent(input.results.length),
    metadata: {
      result,
      movedNativeTaskIds: input.movedNativeTaskIds,
      ...(input.nativeTaskCleanupWarning !== null && input.nativeTaskCleanupWarning.length > 0
        ? { nativeTaskCleanupWarning: input.nativeTaskCleanupWarning }
        : {}),
    },
  });

  return {
    workflow: updated,
    messages: await repositories().listCapabilityWorkflowMessages(input.workflowId),
  };
}

export async function syncBugReportWorkflow(input: {
  user: WorkflowUser;
  workflowRunId: string;
}): Promise<CapabilityWorkflowWithMessages> {
  const workflow = await requireWorkflowOwner({ workflowRunId: input.workflowRunId, userId: input.user.id });
  if (workflow.capabilityKey !== BUG_REPORT_CAPABILITY_KEY) {
    throw new Error(CAPABILITY_WORKFLOW_MESSAGES.bugReportSyncOnly);
  }
  if (Object.keys(workflow.result).length !== 0) {
    return {
      workflow,
      messages: await repositories().listCapabilityWorkflowMessages(workflow.id),
    };
  }

  const connection = await getLinearConnection(input.user);
  if (!connection) {
    const updated = await repositories().updateCapabilityWorkflowRun({
      workflowRunId: workflow.id,
      status: "needs_connection",
      phase: "needs_connection",
      error: CAPABILITY_WORKFLOW_MESSAGES.linearNotConnected,
    });

    return {
      workflow: updated,
      messages: await repositories().listCapabilityWorkflowMessages(workflow.id),
    };
  }

  const draft = bugReportDraftSchema.parse(workflow.draft);
  const issueDrafts = issueDraftsFromDraft(draft);
  const context = bugReportLinearContextSchema.parse(workflow.context);
  validateDraftIssuesForSync(issueDrafts);
  if (!issueDrafts.every((issue) => issue.teamId !== null && issue.teamId.length > 0)) {
    throw new Error(CAPABILITY_WORKFLOW_MESSAGES.chooseLinearTeam);
  }

  await repositories().updateCapabilityWorkflowRun({
    workflowRunId: workflow.id,
    status: "running",
    phase: "syncing",
    error: null,
  });

  try {
    const results = await issueDrafts.reduce<Promise<LinearIssueResult[]>>(async (previous, issueDraft, index) => {
      const collected = await previous;

      return [
        ...collected,
        await createLinearIssueResultForDraft({
          user: input.user,
          workflowId: workflow.id,
          meetingId: workflow.meetingId,
          index,
          issueDraft,
          duplicates: context.duplicateIssues,
        }),
      ];
    }, Promise.resolve([]));
    const { movedNativeTaskIds, nativeTaskCleanupWarning } = await syncedNativeTaskCleanup({
      meetingId: workflow.meetingId,
      issueDrafts,
    });

    return await finalizeBugReportSyncWorkflow({
      workflowId: workflow.id,
      results,
      movedNativeTaskIds,
      nativeTaskCleanupWarning,
    });
  } catch (error) {
    const updated = await repositories().updateCapabilityWorkflowRun({
      workflowRunId: workflow.id,
      status: "failed",
      phase: "failed",
      error: error instanceof Error ? error.message : CAPABILITY_WORKFLOW_MESSAGES.linearSyncFailed,
    });

    return {
      workflow: updated,
      messages: await repositories().listCapabilityWorkflowMessages(workflow.id),
    };
  }
}

async function requireWorkflowOwner(input: { workflowRunId: string; userId: string }): Promise<CapabilityWorkflowRun> {
  const workflow = await repositories().getCapabilityWorkflowRunById(input.workflowRunId);
  if (workflow === null) {
    throw new Error(CAPABILITY_WORKFLOW_MESSAGES.workflowNotFound);
  }
  const meeting = await repositories().getMeetingById(workflow.meetingId);
  if (meeting === null || meeting.createdByUserId !== input.userId) {
    throw new Error(CAPABILITY_WORKFLOW_MESSAGES.workflowNotFound);
  }

  return workflow;
}
