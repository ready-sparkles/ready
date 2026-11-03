import {
  LINEAR_TASK_REVIEW_PROMPT_VERSION,
  type LinearTaskReviewCandidate,
  type LinearTaskReviewClassificationRequest,
  linearTaskReviewClassificationRequestSchema,
  type LinearTaskReviewClassificationResponse,
  linearTaskReviewClassificationResponseSchema,
  type LinearTaskReviewRevisionRequest,
  linearTaskReviewRevisionRequestSchema,
  openAIPromptCacheOptions,
} from "@readymeet/shared";

import { assistantEnv } from "../ports/assistant-env";
import { createOpenAIClient, openAIClientApiKey } from "../ports/openai-client";
import { withOpenAIRetry } from "../ports/openai-retry";

import { parseResponseText } from "./openai-response-text";
import { executeMeteredOpenAIResponse } from "./usage-metering";

const LINEAR_TASK_REVIEW_MAX_OUTPUT_TOKENS = 3200;
const REPRODUCTION_STEPS_MAX_ITEMS = 10;
const EVIDENCE_MAX_ITEMS = 12;
const EVIDENCE_MIN_ITEMS = 1;
const SOURCE_TASK_IDS_MIN_ITEMS = 1;
const CONFIDENCE_MIN = 0;
const CONFIDENCE_MAX = 1;

const LINEAR_TASK_REVIEW_MESSAGES = {
  openAiKeyRequired: "Configured AI provider key is required for Linear task review",
  emptyModelText: "Linear task review returned no text",
  policyRejectionReasoning: "This is a general business deliverable rather than product or technical work.",
  systemPrompt: `You decide which already-extracted meeting tasks should be offered as Linear issues.

Linear is for durable product and technical work that a product team would track in an issue system: engineering, product design, product-scoped research, technical documentation, and product delivery. Design, research, documentation, or delivery work qualifies only when its subject is explicitly a product, software system, or technical implementation.

General business operations do not belong in Linear. This includes fundraising and investor work (such as investor shortlists, outreach, pitch decks, fundraising decks, and investor updates), sales or CRM work, marketing collateral, recruiting, finance, legal work, board materials, customer follow-ups, scheduling, email, personal reminders, and vague discussion notes. The fact that a task says create, build, design, research, document, or deliver does not make a business deliverable a product issue.

Rules:
- Evaluate only the supplied tasks and their supplied transcript evidence. Never assume missing meeting context.
- Require explicit product or technical scope for decision "linear". If that scope is absent, use "not_linear", not "uncertain".
- Treat workKind "customer_follow_up", "sales_or_crm", and "scheduling" as "not_linear".
- Return every source task exactly once, either alone or in a merged candidate.
- Merge tasks only when they clearly describe the same deliverable or fix. Preserve every merged sourceTaskId.
- Use decision "linear" when the task belongs in Linear, "not_linear" when it does not, and "uncertain" when user confirmation is genuinely needed.
- Do not invent requirements, behavior, impact, reproduction steps, owners, dates, teams, or implementation details.
- Keep issue titles concise and descriptions grounded in the task text and evidence.
- For each Linear candidate, produce issueDraft using only sourceQuotes and contextQuotes from its source tasks.
- issueDraft.evidence must copy supplied quotes verbatim, including their speaker, timestamp, and segmentId.
- problem describes the concrete issue or requested work supported by evidence.
- observedBehavior is only for behavior explicitly observed or described. Otherwise null.
- expectedBehavior is only for behavior explicitly described as expected, desired, previous, or correct. Otherwise null.
- requestedChange is only for an explicit request. Otherwise null.
- reproductionSteps contains only actions explicitly described in sequence. Do not turn general discussion into steps.
- impact is only for impact explicitly stated in evidence. Otherwise null.
- Omit unsupported information by using null or an empty array. Never write placeholder copy such as "not specified".
- Choose a team only from availableTeams. When the right team is unclear, use the first available team and lower confidence.
- Return only JSON matching the schema.`,
} as const;

const responseJsonSchema = {
  type: "object",
  /** @external OpenAI structured-output JSON schema wire field. */
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        /** @external OpenAI structured-output JSON schema wire field. */
        additionalProperties: false,
        required: [
          "sourceTaskIds",
          "decision",
          "confidence",
          "reasoning",
          "title",
          "description",
          "issueDraft",
          "teamId",
          "teamName",
        ],
        properties: {
          sourceTaskIds: { type: "array", minItems: SOURCE_TASK_IDS_MIN_ITEMS, items: { type: "string" } },
          decision: { type: "string", enum: ["linear", "uncertain", "not_linear"] },
          confidence: { type: "number", minimum: CONFIDENCE_MIN, maximum: CONFIDENCE_MAX },
          reasoning: { type: "string" },
          title: { type: "string" },
          description: { type: ["string", "null"] },
          issueDraft: {
            anyOf: [
              {
                type: "object",
                /** @external OpenAI structured-output JSON schema wire field. */
                additionalProperties: false,
                required: [
                  "problem",
                  "observedBehavior",
                  "expectedBehavior",
                  "requestedChange",
                  "reproductionSteps",
                  "impact",
                  "evidence",
                ],
                properties: {
                  problem: { type: "string" },
                  observedBehavior: { type: ["string", "null"] },
                  expectedBehavior: { type: ["string", "null"] },
                  requestedChange: { type: ["string", "null"] },
                  reproductionSteps: {
                    type: "array",
                    maxItems: REPRODUCTION_STEPS_MAX_ITEMS,
                    items: { type: "string" },
                  },
                  impact: { type: ["string", "null"] },
                  evidence: {
                    type: "array",
                    minItems: EVIDENCE_MIN_ITEMS,
                    maxItems: EVIDENCE_MAX_ITEMS,
                    items: {
                      type: "object",
                      /** @external OpenAI structured-output JSON schema wire field. */
                      additionalProperties: false,
                      required: ["quote", "speaker", "timestamp", "segmentId"],
                      properties: {
                        quote: { type: "string" },
                        speaker: { type: ["string", "null"] },
                        timestamp: { type: ["string", "null"] },
                        segmentId: { type: ["string", "null"] },
                      },
                    },
                  },
                },
              },
              { type: "null" },
            ],
          },
          teamId: { type: ["string", "null"] },
          teamName: { type: ["string", "null"] },
        },
      },
    },
  },
} as const;

const linearTaskReviewCandidatesResponseSchema = linearTaskReviewClassificationResponseSchema.pick({
  /** @external zod pick spec */
  candidates: true,
});

function buildLinearTaskReviewSystemPrompt(): string {
  return LINEAR_TASK_REVIEW_MESSAGES.systemPrompt;
}

const ALWAYS_NON_LINEAR_WORK_KINDS = new Set(["customer_follow_up", "sales_or_crm", "scheduling"]);
const FUNDRAISING_OR_INVESTOR_DELIVERABLE =
  /(?:\b(?:fundrais(?:e|ing|er|ers)|investors?)\b.{0,120}\b(?:deck|presentation|pitch|shortlist|outreach|materials?)\b|\b(?:deck|presentation|pitch|shortlist|outreach|materials?)\b.{0,120}\b(?:fundrais(?:e|ing|er|ers)|investors?)\b)/i;

function isClearlyNonLinearBusinessTask(
  task: Pick<
    LinearTaskReviewClassificationRequest["tasks"][number],
    "title" | "description" | "workKind" | "sourceQuotes" | "contextQuotes"
  >,
): boolean {
  if (ALWAYS_NON_LINEAR_WORK_KINDS.has(task.workKind)) {
    return true;
  }

  const groundedText = [
    task.title,
    task.description ?? "",
    ...task.sourceQuotes.map((quote) => quote.quote),
    ...task.contextQuotes.map((quote) => quote.quote),
  ].join(" ");

  return FUNDRAISING_OR_INVESTOR_DELIVERABLE.test(groundedText);
}

function policyRejectionCandidate(
  task: LinearTaskReviewClassificationRequest["tasks"][number],
): LinearTaskReviewCandidate {
  return {
    sourceTaskIds: [task.id],
    decision: "not_linear",
    confidence: 1,
    reasoning: LINEAR_TASK_REVIEW_MESSAGES.policyRejectionReasoning,
    title: task.title,
    description: task.description,
    issueDraft: null,
    teamId: null,
    teamName: null,
    duplicateIssues: [],
    targetAction: "create",
    targetIssue: null,
    relationId: null,
  };
}

async function runModel(input: {
  meetingId: string;
  jobId?: string | null;
  operation: "classify" | "revise";
  payload: Record<string, unknown>;
}): Promise<LinearTaskReviewCandidate[]> {
  const apiKey = openAIClientApiKey();
  if (apiKey === undefined || apiKey === "") {
    throw new Error(LINEAR_TASK_REVIEW_MESSAGES.openAiKeyRequired);
  }
  const model = assistantEnv().OPENAI_CAPABILITY_SELECTION_MODEL;
  const client = createOpenAIClient({ apiKey });
  const response = await withOpenAIRetry({
    operation: () =>
      executeMeteredOpenAIResponse({
        client,
        body: {
          model,
          ...openAIPromptCacheOptions(model),
          max_output_tokens: LINEAR_TASK_REVIEW_MAX_OUTPUT_TOKENS,
          input: [
            { role: "system", content: buildLinearTaskReviewSystemPrompt() },
            { role: "user", content: JSON.stringify(input.payload) },
          ],
          text: {
            format: {
              type: "json_schema",
              name: "linear_task_review",
              /** @external OpenAI structured-output JSON schema wire field */
              strict: true,
              schema: responseJsonSchema,
            },
          },
        },
        meetingId: input.meetingId,
        jobId: input.jobId ?? null,
        source: "linear_task_review",
        operation: input.operation === "classify" ? "classify_linear_tasks" : "revise_linear_tasks",
      }),
  });

  const text = parseResponseText(response);
  if (text === "") {
    throw new Error(LINEAR_TASK_REVIEW_MESSAGES.emptyModelText);
  }
  const parsed = linearTaskReviewCandidatesResponseSchema.parse(JSON.parse(text));

  return parsed.candidates;
}

export async function classifyLinearTasksWithModel(
  input: LinearTaskReviewClassificationRequest,
): Promise<LinearTaskReviewClassificationResponse> {
  const parsed = linearTaskReviewClassificationRequestSchema.parse(input);
  const modelTasks = parsed.tasks.filter((task) => !isClearlyNonLinearBusinessTask(task));
  const policyRejections = parsed.tasks.filter(isClearlyNonLinearBusinessTask).map(policyRejectionCandidate);
  const candidates =
    modelTasks.length !== 0
      ? await runModel({
          meetingId: parsed.meetingId,
          jobId: parsed.jobId,
          operation: "classify",
          payload: {
            tasks: modelTasks,
            availableTeams: parsed.availableTeams,
          },
        })
      : [];

  return linearTaskReviewClassificationResponseSchema.parse({
    candidates: [...candidates, ...policyRejections],
    model: assistantEnv().OPENAI_CAPABILITY_SELECTION_MODEL,
    promptVersion: LINEAR_TASK_REVIEW_PROMPT_VERSION,
  });
}

export async function reviseLinearTaskReviewWithModel(
  input: LinearTaskReviewRevisionRequest,
): Promise<LinearTaskReviewClassificationResponse> {
  const parsed = linearTaskReviewRevisionRequestSchema.parse(input);
  const modelTasks = parsed.tasks.filter((task) => !isClearlyNonLinearBusinessTask(task));
  const modelTaskIds = new Set(modelTasks.map((task) => task.id));
  const policyRejections = parsed.tasks.filter(isClearlyNonLinearBusinessTask).map(policyRejectionCandidate);
  const currentCandidates = parsed.currentCandidates.flatMap((candidate) => {
    const sourceTaskIds = candidate.sourceTaskIds.filter((taskId) => modelTaskIds.has(taskId));

    return sourceTaskIds.length !== 0 ? [{ ...candidate, sourceTaskIds }] : [];
  });
  const candidates =
    modelTasks.length !== 0
      ? await runModel({
          meetingId: parsed.meetingId,
          operation: "revise",
          payload: {
            instruction: parsed.instruction,
            tasks: modelTasks,
            currentCandidates,
            availableTeams: parsed.availableTeams,
          },
        })
      : [];

  return linearTaskReviewClassificationResponseSchema.parse({
    candidates: [...candidates, ...policyRejections],
    model: assistantEnv().OPENAI_CAPABILITY_SELECTION_MODEL,
    promptVersion: LINEAR_TASK_REVIEW_PROMPT_VERSION,
  });
}
