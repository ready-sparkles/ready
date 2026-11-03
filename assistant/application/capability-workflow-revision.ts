import {
  type BugReportDraftRevisionRequest,
  bugReportDraftRevisionRequestSchema,
  type BugReportDraftRevisionResponse,
  bugReportDraftRevisionResponseSchema,
  openAIPromptCacheOptions,
} from "@readymeet/shared";
import { z } from "zod";

import { assistantEnv } from "../ports/assistant-env";
import { createOpenAIClient, openAIClientApiKey } from "../ports/openai-client";

import { parseResponseText } from "./openai-response-text";
import { executeMeteredOpenAIResponse } from "./usage-metering";

const CAPABILITY_WORKFLOW_REVISION_MESSAGES = {
  timedOut: (input: { label: string; timeoutMs: number }) => `${input.label} timed out after ${input.timeoutMs}ms`,
  openAiKeyRequired: "Configured AI provider key is required for bug report draft revision",
  emptyModelText: "Bug report draft revision returned no text",
} as const;

async function timeoutPromise<T>(input: { timeoutMs: number; label: string }): Promise<T> {
  return new Promise((_, reject) => {
    const timeoutId = setTimeout(() => {
      reject(
        new Error(CAPABILITY_WORKFLOW_REVISION_MESSAGES.timedOut({ label: input.label, timeoutMs: input.timeoutMs })),
      );
    }, input.timeoutMs);
    timeoutId.unref();
  });
}

const issueDraftRequired = [
  "title",
  "description",
  "severity",
  "impact",
  "reproductionContext",
  "evidence",
  "evidenceSpans",
  "scopeReason",
  "confidence",
  "duplicateIssueIds",
  "teamId",
  "teamName",
  "labels",
] as const;

const issueDraftSchemaJson = {
  type: "object",
  /** @external OpenAI structured-output JSON schema wire field */
  additionalProperties: false,
  required: issueDraftRequired,
  properties: {
    title: { type: "string" },
    description: { type: "string" },
    severity: { type: "string", enum: ["low", "medium", "high"] },
    impact: { type: "string" },
    reproductionContext: { type: ["string", "null"] },
    evidence: { type: "array", items: { type: "string" } },
    evidenceSpans: {
      type: "array",
      items: {
        type: "object",
        /** @external OpenAI structured-output JSON schema wire field */
        additionalProperties: false,
        required: [
          "evidenceId",
          "source",
          "label",
          "excerpt",
          "lineStart",
          "lineEnd",
          "segmentIds",
          "verificationStatus",
        ],
        properties: {
          evidenceId: { type: "string" },
          source: { type: "string" },
          label: { type: "string" },
          excerpt: { type: "string" },
          lineStart: { type: "number" },
          lineEnd: { type: "number" },
          segmentIds: { type: "array", items: { type: "string" } },
          verificationStatus: { type: "string", enum: ["verified", "corrected"] },
        },
      },
    },
    scopeReason: { type: "string" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    duplicateIssueIds: { type: "array", items: { type: "string" } },
    teamId: { type: ["string", "null"] },
    teamName: { type: ["string", "null"] },
    labels: { type: "array", items: { type: "string" } },
  },
} as const;

const bugReportRevisionResponseJsonSchema = {
  type: "object",
  /** @external OpenAI structured-output JSON schema wire field */
  additionalProperties: false,
  required: ["draft", "summary", "operation"],
  properties: {
    summary: { type: "string" },
    operation: {
      type: "string",
      enum: [
        "keep",
        "remove",
        "restore",
        "merge",
        "split",
        "rewrite_title",
        "rewrite_description",
        "rewrite_issue",
        "reorder",
        "change_severity",
        "deduplicate",
        "unlink_related_issue",
        "add_issue",
        "unsupported",
      ],
    },
    draft: {
      type: "object",
      /** @external OpenAI structured-output JSON schema wire field */
      additionalProperties: false,
      required: [...issueDraftRequired, "issues"],
      properties: {
        ...issueDraftSchemaJson.properties,
        issues: {
          type: "array",
          items: issueDraftSchemaJson,
        },
      },
    },
  },
} as const;

function buildRevisionSystemPrompt(): string {
  return `You revise draft Linear bug tickets from a user's natural-language correction.

Rules:
- Return only valid JSON matching the schema.
- Apply the user's correction to the draft issues, not to Linear.
- Do not create, sync, or claim anything was created.
- Understand these edit intents: keep/select, remove/delete, restore/bring back, merge/combine/collapse/group, split/separate, rewrite title, rewrite description, shorten, expand, reorder, change severity, deduplicate, unlink related Linear issue, and add a missing evidence-backed issue.
- Preserve evidence, evidenceSpans, duplicateIssueIds, teamId, teamName, labels, severity, impact, and reproductionContext unless the user explicitly asks to change them.
- "Related issue", "duplicate", "linked issue", or "connected issue" refers to duplicateIssueIds, not the draft issue itself.
- For requests like "this issue is not related to that issue", "not a duplicate", "remove the related issue", or "not connected to REA-123", set operation to "unlink_related_issue" and remove the matching ID from duplicateIssueIds.
- For pronouns like "this" or "that", infer the target only when there is exactly one visible draft issue or exactly one possible duplicate target. If multiple draft issues or duplicate links could match, return unsupported.
- Never claim a related issue was removed unless the returned draft actually removes at least one duplicateIssueId.
- Never remove all evidenceSpans from an issue. Every resulting issue must keep at least one evidenceSpan from the current draft, originalDraft, or evidenceBank.
- Only create or split into new issues when the needed transcript evidence exists in current draft, originalDraft, or evidenceBank.
- For requests like "make the title better", "make it shorter", "make this clearer", or "make it more Linear-like", rewrite the relevant title or description with better product-quality wording. Never set a field literally to "better", "shorter", "clearer", "one ticket", "Linear-like", or similar instruction words.
- If the user asks to remove, keep, merge, split, reorder, rename, or rewrite issues, update the issues array accordingly.
- Treat instructions like "only add the SSO issue", "just sync Safari", or "only keep the login bug" as requests to keep the named issue or issues and remove the rest from the draft list.
- If the user asks to bring back, restore, include all, show all, or add back issues, use originalDraft when it is provided as the source of all available issues.
- For "merge these into one ticket", "combine into one issue", "make this one Linear ticket", or similar requests, treat "these" as all currently visible draft issues unless the user names or numbers specific issues.
- When merging, create one new issue with a clear combined title and combined description, dedupe evidence/evidenceSpans, union duplicateIssueIds, keep teamId/teamName/labels, use the highest severity among merged issues, and preserve useful impact/reproduction context without inventing facts.
- When merging named issues, merge only the matching issues and leave unrelated issues as separate drafts.
- Keep titles concise and specific. Keep descriptions useful for triage.
- The top-level draft fields must mirror the first issue after revision.
- Set operation to the best matching edit intent.
- The summary must be one short sentence saying what changed, such as "Merged 5 draft issues into 1 ticket." or "Removed the Safari issue."
- If the request cannot be applied safely, set operation to "unsupported", return the original draft, and use this summary exactly: "I could not apply that change safely. Try asking to keep, remove, merge, split, rename, rewrite, or reorder specific issues."`;
}

const bugReportRevisionJsonSchema = z.object({
  draft: z.unknown(),
  summary: z.string(),
  operation: z.string(),
});

export async function reviseBugReportDraftWithModel(
  input: BugReportDraftRevisionRequest,
): Promise<BugReportDraftRevisionResponse> {
  const parsedInput = bugReportDraftRevisionRequestSchema.parse(input);
  const apiKey = openAIClientApiKey();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(CAPABILITY_WORKFLOW_REVISION_MESSAGES.openAiKeyRequired);
  }

  const client = createOpenAIClient({ apiKey });
  const { metering, ...modelInput } = parsedInput;
  const response = await Promise.race([
    executeMeteredOpenAIResponse({
      client,
      body: {
        model: assistantEnv().OPENAI_CAPABILITY_WORKFLOW_MODEL,
        ...openAIPromptCacheOptions(assistantEnv().OPENAI_CAPABILITY_WORKFLOW_MODEL),
        input: [
          {
            role: "system",
            content: buildRevisionSystemPrompt(),
          },
          {
            role: "user",
            content: JSON.stringify(modelInput),
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "bug_report_draft_revision",
            /** @external OpenAI structured-output JSON schema wire field */
            strict: true,
            schema: bugReportRevisionResponseJsonSchema,
          },
        },
      },
      meetingId: metering?.meetingId ?? null,
      workflowRunId: metering?.workflowRunId ?? null,
      source: "capability_workflow",
      operation: "linear_issue_revision",
    }),
    timeoutPromise<never>({
      timeoutMs: assistantEnv().OPENAI_CAPABILITY_WORKFLOW_TIMEOUT_MS,
      label: "Bug report draft revision",
    }),
  ]);

  const text = parseResponseText(response);
  if (text.length === 0) {
    throw new Error(CAPABILITY_WORKFLOW_REVISION_MESSAGES.emptyModelText);
  }

  return bugReportDraftRevisionResponseSchema.parse(bugReportRevisionJsonSchema.parse(JSON.parse(text)));
}
