import type { BugReportDraft, BugReportIssueDraft, BugReportLinearContext } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import {
  filterDraftDuplicateIdsToContext,
  isRelatedIssueUnlinkInstruction,
  RELATED_ISSUE_UNCLEAR_SUMMARY,
  unlinkRelatedLinearIssues,
} from "../../domain/bug-report-related-issues";

const EMPTY_BUG_REPORT_DRAFT_MESSAGE = "A bug report draft requires at least one issue.";

const evidenceSpan = {
  evidenceId: "evidence-1",
  source: "signal",
  label: "Engineering issue",
  excerpt: "Users on Safari are reporting that dashboard charts are not rendering.",
  lineStart: 1,
  lineEnd: 1,
  segmentIds: [],
  verificationStatus: "verified" as const,
};

function makeIssue(input: { title: string; duplicateIssueIds?: string[] }): BugReportIssueDraft {
  return {
    title: input.title,
    description: `${input.title} needs triage.`,
    severity: "medium",
    impact: "Impact should be confirmed from the meeting evidence below.",
    reproductionContext: null,
    evidence: [evidenceSpan.excerpt],
    evidenceSpans: [evidenceSpan],
    scopeReason: "One independently actionable issue.",
    confidence: "high",
    duplicateIssueIds: input.duplicateIssueIds ?? [],
    teamId: "team-1",
    teamName: "Ready",
    labels: ["bug"],
  };
}

function makeDraft(issues: BugReportIssueDraft[]): BugReportDraft {
  const firstIssue = issues[0];
  if (!firstIssue) {
    throw new Error(EMPTY_BUG_REPORT_DRAFT_MESSAGE);
  }

  return {
    ...firstIssue,
    issues,
  };
}

const context: BugReportLinearContext = {
  provider: "linear",
  /** @external linear connection status */
  connected: true,
  teamId: "team-1",
  teamName: "Ready",
  duplicateIssues: [
    {
      id: "dup-safari",
      identifier: "REA-3423",
      title: "Safari chart rendering regression",
      status: "Todo",
      url: "https://linear.app/ready/issue/REA-3423/safari-chart-rendering-regression",
      rationale: "Both mention Safari chart rendering.",
    },
    {
      id: "dup-mobile",
      identifier: "REA-4444",
      title: "Mobile settings overflow",
      status: "Todo",
      url: "https://linear.app/ready/issue/REA-4444/mobile-settings-overflow",
      rationale: "Both mention settings overflow.",
    },
  ],
  sampledFormat: {
    quality: "unknown",
    notes: [],
    suggestedSections: [],
  },
};

void test("related issue unlink detection catches natural language relationship edits", () => {
  assert.equal(isRelatedIssueUnlinkInstruction("no this issue is not related to that issue"), true);
  assert.equal(isRelatedIssueUnlinkInstruction("not a duplicate of REA-3423"), true);
  assert.equal(isRelatedIssueUnlinkInstruction("remove the related issue"), true);
  assert.equal(isRelatedIssueUnlinkInstruction("make the title shorter"), false);
});

void test("single draft with one duplicate removes the related issue link from vague pronouns", () => {
  const draft = makeDraft([makeIssue({ title: "Safari charts fail to render", duplicateIssueIds: ["dup-safari"] })]);

  const result = unlinkRelatedLinearIssues({
    draft,
    context,
    instruction: "no this issue is not related to that issue",
  });

  assert.equal(result.handled, true);
  assert.equal(result.removedCount, 1);
  assert.deepEqual(result.draft.issues[0]?.duplicateIssueIds, []);
});

void test("single draft with multiple duplicates removes only the named Linear issue", () => {
  const draft = makeDraft([
    makeIssue({
      title: "Safari charts fail to render",
      duplicateIssueIds: ["dup-safari", "dup-mobile"],
    }),
  ]);

  const result = unlinkRelatedLinearIssues({
    draft,
    context,
    instruction: "not related to REA-3423",
  });

  assert.equal(result.handled, true);
  assert.deepEqual(result.draft.issues[0]?.duplicateIssueIds, ["dup-mobile"]);
});

void test("multiple drafts can unlink a named draft and named Linear issue", () => {
  const draft = makeDraft([
    makeIssue({ title: "Safari charts fail to render", duplicateIssueIds: ["dup-safari"] }),
    makeIssue({ title: "Mobile settings overflow", duplicateIssueIds: ["dup-mobile"] }),
  ]);

  const result = unlinkRelatedLinearIssues({
    draft,
    context,
    instruction: "Safari is not related to REA-3423",
  });

  assert.equal(result.handled, true);
  assert.deepEqual(result.draft.issues[0]?.duplicateIssueIds, []);
  assert.deepEqual(result.draft.issues[1]?.duplicateIssueIds, ["dup-mobile"]);
});

void test("multiple drafts with vague pronouns ask for specificity and preserve the draft", () => {
  const draft = makeDraft([
    makeIssue({ title: "Safari charts fail to render", duplicateIssueIds: ["dup-safari"] }),
    makeIssue({ title: "Mobile settings overflow", duplicateIssueIds: ["dup-mobile"] }),
  ]);

  const result = unlinkRelatedLinearIssues({
    draft,
    context,
    instruction: "this issue is not related to that issue",
  });

  assert.equal(result.handled, false);
  assert.equal(result.summary, RELATED_ISSUE_UNCLEAR_SUMMARY);
  assert.deepEqual(result.draft, draft);
});

void test("unknown duplicate ids are filtered from revised drafts", () => {
  const draft = makeDraft([
    makeIssue({
      title: "Safari charts fail to render",
      duplicateIssueIds: ["dup-safari", "unknown-duplicate"],
    }),
  ]);

  const filtered = filterDraftDuplicateIdsToContext(draft, context);

  assert.deepEqual(filtered.issues[0]?.duplicateIssueIds, ["dup-safari"]);
});
