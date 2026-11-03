import {
  type BugReportDraft,
  bugReportDraftSchema,
  type BugReportIssueDraft,
  bugReportIssueDraftSchema,
  type BugReportLinearContext,
} from "@readymeet/shared";

export const RELATED_ISSUE_UNCLEAR_SUMMARY =
  "I could not tell which draft issue or related Linear issue to update. Tell me the draft title or Linear issue ID to remove.";

const BUG_REPORT_MISSING_PRIMARY_ISSUE_MESSAGE = "Bug report draft is missing a primary issue";

const MATCH_MIN_WORD_LENGTH = 3;
const DUPLICATE_MATCH_MIN_SCORE = 2;
const ISSUE_TITLE_MATCH_BONUS = 5;
const ISSUE_MATCH_MIN_SCORE = 2;

const RELATED_ISSUE_UNLINK_STOP_WORDS = new Set([
  "bug",
  "connected",
  "duplicate",
  "issue",
  "issues",
  "link",
  "linked",
  "linear",
  "not",
  "related",
  "that",
  "this",
  "ticket",
  "tickets",
  "unlink",
]);

type RelatedIssueUnlinkResult = {
  draft: BugReportDraft;
  summary: string;
  /** @external bug report unlink handled flag */
  handled: boolean;
  removedCount: number;
};

function normalizeForMatch(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function issueDraftsFromDraft(draft: BugReportDraft): BugReportIssueDraft[] {
  if (draft.issues.length !== 0) {
    return draft.issues;
  }

  return draft.evidenceSpans.length !== 0 || draft.evidence.length !== 0 ? [draft] : [];
}

function rebuildBugReportDraftFromIssues(input: { currentDraft: BugReportDraft; issues: BugReportIssueDraft[] }) {
  const normalizedIssues = input.issues.length !== 0 ? input.issues : issueDraftsFromDraft(input.currentDraft);
  const primaryIssue = normalizedIssues[0];
  if (primaryIssue === undefined) {
    throw new Error(BUG_REPORT_MISSING_PRIMARY_ISSUE_MESSAGE);
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

export function isRelatedIssueUnlinkInstruction(instruction: string): boolean {
  const normalized = normalizeForMatch(instruction);

  return (
    /\bunlink\b/.test(normalized) ||
    /\b(remove|delete|drop|clear)\b.*\b(related|relation|duplicate|linked|link|connected)\b/.test(normalized) ||
    /\bnot\b.*\b(related|duplicate|linked|connected)\b/.test(normalized) ||
    /\b(isn t|isnt|is not|not a)\b.*\b(duplicate|related|linked|connected)\b/.test(normalized)
  );
}

function duplicateSearchText(duplicate: BugReportLinearContext["duplicateIssues"][number]) {
  return [duplicate.id, duplicate.identifier, duplicate.title, duplicate.status, duplicate.rationale]
    .filter((entry) => entry !== null && entry !== undefined && entry !== "")
    .join(" ");
}

function findDuplicateIdsByInstruction(input: {
  duplicates: BugReportLinearContext["duplicateIssues"];
  instruction: string;
}) {
  const normalizedInstruction = normalizeForMatch(input.instruction);
  const exactMatches = input.duplicates.filter((duplicate) => {
    const identifiers = [duplicate.id, duplicate.identifier].filter(
      (identifier): identifier is string => identifier !== null && identifier !== undefined && identifier !== "",
    );

    return identifiers.some((identifier) => {
      const normalizedIdentifier = normalizeForMatch(identifier);

      return normalizedIdentifier !== "" && normalizedInstruction.includes(normalizedIdentifier);
    });
  });

  if (exactMatches.length !== 0) {
    return exactMatches.map((duplicate) => duplicate.id);
  }

  const instructionWords = normalizedInstruction.split(/\s+/).filter((word) => word.length >= MATCH_MIN_WORD_LENGTH);
  const scored = input.duplicates
    .map((duplicate) => {
      const duplicateWords = new Set(normalizeForMatch(duplicateSearchText(duplicate)).split(/\s+/));
      const score = instructionWords.filter((word) => duplicateWords.has(word)).length;

      return { duplicate, score };
    })
    .filter((item) => item.score >= DUPLICATE_MATCH_MIN_SCORE)
    .sort((left, right) => right.score - left.score);

  if (scored.length === 0) {
    return [];
  }

  const bestScore = scored[0]?.score ?? 0;

  return scored.filter((item) => item.score === bestScore).map((item) => item.duplicate.id);
}

function issueSearchText(issue: BugReportIssueDraft) {
  return [
    issue.title,
    issue.description,
    issue.reproductionContext,
    issue.scopeReason,
    ...issue.evidence,
    ...issue.evidenceSpans.flatMap((span) => [span.label, span.excerpt]),
  ]
    .filter((entry) => entry !== null && entry !== undefined && entry !== "")
    .join(" ");
}

function findIssueIndexesByInstruction(input: { issues: BugReportIssueDraft[]; instruction: string }) {
  const normalizedInstruction = normalizeForMatch(input.instruction);
  const instructionWords = normalizedInstruction
    .split(/\s+/)
    .filter((word) => word.length >= MATCH_MIN_WORD_LENGTH && !RELATED_ISSUE_UNLINK_STOP_WORDS.has(word));
  const scored = input.issues
    .map((issue, index) => {
      const issueText = normalizeForMatch(issueSearchText(issue));
      const issueWords = new Set(issueText.split(/\s+/).filter((word) => word.length >= MATCH_MIN_WORD_LENGTH));
      const titleText = normalizeForMatch(issue.title);
      const exactTitleBonus =
        titleText !== "" && normalizedInstruction.includes(titleText) ? ISSUE_TITLE_MATCH_BONUS : 0;
      const wordScore = instructionWords.filter((word) => issueWords.has(word)).length;

      return { index, score: wordScore + exactTitleBonus };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);

  if (scored.length === 0) {
    return [];
  }

  const bestScore = scored[0]?.score ?? 0;

  return scored
    .filter((item) => item.score === bestScore || item.score >= ISSUE_MATCH_MIN_SCORE)
    .map((item) => item.index);
}

function getLinkedIssueIndexes(input: { issues: BugReportIssueDraft[]; duplicateIds: string[] }) {
  const duplicateIdSet = new Set(input.duplicateIds);

  return input.issues
    .map((issue, index) => ({ issue, index }))
    .filter(({ issue }) => issue.duplicateIssueIds.some((duplicateId) => duplicateIdSet.has(duplicateId)))
    .map(({ index }) => index);
}

export function unlinkRelatedLinearIssues(input: {
  draft: BugReportDraft;
  context: BugReportLinearContext;
  instruction: string;
}): RelatedIssueUnlinkResult {
  const issues = issueDraftsFromDraft(input.draft);
  if (!isRelatedIssueUnlinkInstruction(input.instruction) || issues.length === 0) {
    return {
      draft: input.draft,
      summary: RELATED_ISSUE_UNCLEAR_SUMMARY,
      handled: false,
      removedCount: 0,
    };
  }

  const knownDuplicateIds = new Set(input.context.duplicateIssues.map((duplicate) => duplicate.id));
  const requestedDuplicateIds = findDuplicateIdsByInstruction({
    duplicates: input.context.duplicateIssues,
    instruction: input.instruction,
  }).filter((duplicateId) => knownDuplicateIds.has(duplicateId));
  const explicitIssueIndexes = findIssueIndexesByInstruction({ issues, instruction: input.instruction });

  const targetIssueIndexes =
    issues.length === 1
      ? [0]
      : explicitIssueIndexes.length === 1
        ? explicitIssueIndexes
        : requestedDuplicateIds.length === 1
          ? getLinkedIssueIndexes({ issues, duplicateIds: requestedDuplicateIds })
          : [];
  const targetIssueIndex = targetIssueIndexes[0];

  if (targetIssueIndexes.length !== 1 || targetIssueIndex === undefined) {
    return {
      draft: input.draft,
      summary: RELATED_ISSUE_UNCLEAR_SUMMARY,
      handled: false,
      removedCount: 0,
    };
  }

  const targetIssue = issues[targetIssueIndex];
  if (targetIssue === undefined || targetIssue.duplicateIssueIds.length === 0) {
    return {
      draft: input.draft,
      summary: RELATED_ISSUE_UNCLEAR_SUMMARY,
      handled: false,
      removedCount: 0,
    };
  }

  const duplicateIdsToRemove =
    requestedDuplicateIds.length !== 0 ? new Set(requestedDuplicateIds) : new Set(targetIssue.duplicateIssueIds);
  const nextDuplicateIssueIds = targetIssue.duplicateIssueIds.filter(
    (duplicateId) => !duplicateIdsToRemove.has(duplicateId),
  );
  const removedCount = targetIssue.duplicateIssueIds.length - nextDuplicateIssueIds.length;
  if (removedCount <= 0) {
    return {
      draft: input.draft,
      summary: RELATED_ISSUE_UNCLEAR_SUMMARY,
      handled: false,
      removedCount: 0,
    };
  }

  const nextIssues = issues.map((issue, index) =>
    index === targetIssueIndex
      ? bugReportIssueDraftSchema.parse({
          ...issue,
          duplicateIssueIds: nextDuplicateIssueIds,
        })
      : issue,
  );

  const draft = rebuildBugReportDraftFromIssues({ currentDraft: input.draft, issues: nextIssues });

  return {
    draft,
    summary:
      removedCount === 1
        ? `Removed the related Linear issue from "${targetIssue.title}".`
        : `Removed ${removedCount} related Linear issues from "${targetIssue.title}".`,
    handled: true,
    removedCount,
  };
}

function filterDraftDuplicateIdsToContextWithInput(input: {
  draft: BugReportDraft;
  context: BugReportLinearContext;
}): ReturnType<typeof rebuildBugReportDraftFromIssues> {
  const allowedIds = new Set(input.context.duplicateIssues.map((duplicate) => duplicate.id));
  const issues = issueDraftsFromDraft(input.draft).map((issue) => ({
    ...issue,
    duplicateIssueIds: issue.duplicateIssueIds.filter((duplicateIssueId) => allowedIds.has(duplicateIssueId)),
  }));

  return rebuildBugReportDraftFromIssues({ currentDraft: input.draft, issues });
}

export function filterDraftDuplicateIdsToContext(
  ...args: [draft: BugReportDraft, context: BugReportLinearContext]
): ReturnType<typeof rebuildBugReportDraftFromIssues> {
  const [draft, context] = args;

  return filterDraftDuplicateIdsToContextWithInput({ draft, context });
}
