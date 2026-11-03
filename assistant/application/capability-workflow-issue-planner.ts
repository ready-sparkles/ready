import {
  type BugReportIssuePlanningRequest,
  bugReportIssuePlanningRequestSchema,
  type BugReportIssuePlanningResponse,
  bugReportIssuePlanningResponseSchema,
  openAIPromptCacheOptions,
} from "@readymeet/shared";

import { assistantEnv } from "../ports/assistant-env";
import { createOpenAIClient, openAIClientApiKey } from "../ports/openai-client";

import { parseResponseText } from "./openai-response-text";
import { executeMeteredOpenAIResponse } from "./usage-metering";

const BUG_REPORT_ISSUE_PLANNING_TIMEOUT_LABEL = "Bug report issue planning";
const TIMEOUT_ERROR_AFTER = "timed out after";
const TIMEOUT_ERROR_MS_SUFFIX = "ms";
const AI_GATEWAY_API_KEY_REQUIRED_MESSAGE = "Configured AI provider key is required for bug report issue planning";
const BUG_REPORT_ISSUE_PLANNING_EMPTY_RESPONSE_MESSAGE = "Bug report issue planning returned no text";
const BUG_REPORT_PLANNING_TIMEOUT_MESSAGE = `${BUG_REPORT_ISSUE_PLANNING_TIMEOUT_LABEL} ${TIMEOUT_ERROR_AFTER} ${assistantEnv().OPENAI_CAPABILITY_WORKFLOW_TIMEOUT_MS}${TIMEOUT_ERROR_MS_SUFFIX}`;

const bugReportIssuePlanningResponseJsonSchema = {
  type: "object",
  /** @external OpenAI structured-output JSON schema wire field. */
  additionalProperties: false,
  required: ["candidates", "skippedCandidates", "summary"],
  properties: {
    summary: { type: "string" },
    candidates: {
      type: "array",
      items: {
        type: "object",
        /** @external OpenAI structured-output JSON schema wire field. */
        additionalProperties: false,
        required: [
          "title",
          "description",
          "severity",
          "reproductionContext",
          "evidenceIds",
          "searchTerms",
          "scopeReason",
          "confidence",
        ],
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          severity: { type: "string", enum: ["low", "medium", "high"] },
          reproductionContext: { type: ["string", "null"] },
          evidenceIds: { type: "array", items: { type: "string" } },
          searchTerms: { type: "array", items: { type: "string" } },
          scopeReason: { type: "string" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
        },
      },
    },
    skippedCandidates: {
      type: "array",
      items: {
        type: "object",
        /** @external OpenAI structured-output JSON schema wire field. */
        additionalProperties: false,
        required: ["title", "reason", "evidenceIds"],
        properties: {
          title: { type: "string" },
          reason: { type: "string" },
          evidenceIds: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

function buildIssuePlanningSystemPrompt(): string {
  return `You plan Linear bug issues from a grounded meeting evidence bank.

Rules:
- Use only the evidenceBank. Do not invent owners, dates, accounts, root causes, reproduction steps, or impact.
- Every candidate must reference one or more evidenceIds from the evidenceBank.
- Create one candidate per independently actionable problem.
- Merge symptoms only when the evidence clearly points to the same root cause or fix path.
- If the transcript only mentions an undifferentiated batch, such as "five cosmetic bugs", create one scoped batch issue instead of inventing separate bugs.
- Skip any possible issue that lacks direct evidence or is too vague to scope.
- Keep titles concise and Linear-like.
- Keep descriptions short and useful for triage.
- Search terms should be focused phrases from the title, affected system, error terms, or exact evidence language.
- Return only valid JSON matching the schema.`;
}

export async function planBugReportIssuesWithModel(
  input: BugReportIssuePlanningRequest,
): Promise<BugReportIssuePlanningResponse> {
  const parsedInput = bugReportIssuePlanningRequestSchema.parse(input);
  const apiKey = openAIClientApiKey();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(AI_GATEWAY_API_KEY_REQUIRED_MESSAGE);
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
            content: buildIssuePlanningSystemPrompt(),
          },
          {
            role: "user",
            content: JSON.stringify(modelInput),
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "bug_report_issue_planning",
            /** @external OpenAI structured-output JSON schema wire field */
            strict: true,
            schema: bugReportIssuePlanningResponseJsonSchema,
          },
        },
      },
      meetingId: metering?.meetingId ?? null,
      workflowRunId: metering?.workflowRunId ?? null,
      source: "capability_workflow",
      operation: "linear_issue_planning",
    }),
    new Promise<never>((_, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(BUG_REPORT_PLANNING_TIMEOUT_MESSAGE));
      }, assistantEnv().OPENAI_CAPABILITY_WORKFLOW_TIMEOUT_MS);
      timeoutId.unref();
    }),
  ]);

  const text = parseResponseText(response);
  if (text.length === 0) {
    throw new Error(BUG_REPORT_ISSUE_PLANNING_EMPTY_RESPONSE_MESSAGE);
  }

  return bugReportIssuePlanningResponseSchema.parse(JSON.parse(text));
}
