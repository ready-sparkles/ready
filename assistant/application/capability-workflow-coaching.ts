import {
  type MeetingCoachingGenerationRequest,
  meetingCoachingGenerationRequestSchema,
  type MeetingCoachingGenerationResponse,
  meetingCoachingGenerationResponseSchema,
  openAIPromptCacheOptions,
} from "@readymeet/shared";
import { z } from "zod";

import { assistantEnv } from "../ports/assistant-env";
import { createOpenAIClient, openAIClientApiKey } from "../ports/openai-client";

import { parseResponseText } from "./openai-response-text";
import { executeMeteredOpenAIResponse } from "./usage-metering";

const MEETING_COACHING_PROMPT_VERSION = "1.0.0";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVIDENCE_SNIPPETS_MAX_ITEMS = 2;
const FEEDBACK_POINTS_MIN_ITEMS = 1;
const FEEDBACK_POINTS_MAX_ITEMS = 4;
const FOLLOW_UP_PROMPTS_MIN_ITEMS = 2;
const FOLLOW_UP_PROMPTS_MAX_ITEMS = 3;
const DETAIL_PARAGRAPHS_MAX_ITEMS = 4;

const MEETING_COACHING_MESSAGES = {
  timeoutLabel: "Meeting coaching feedback",
  openAiKeyRequired: "Configured AI provider key is required for meeting coaching feedback",
  emptyModelText: "Meeting coaching feedback returned no text",
  fallbackWhatWorkedTitle: "What worked",
  fallbackWhatWorkedBody: "See the detailed coaching response below.",
  fallbackWhatToImproveTitle: "What to improve",
  fallbackWhatToImproveBody: "See the detailed coaching response below.",
  fallbackTryNextTimeTitle: "Try next time",
  fallbackTryNextTimeBody: "See the detailed coaching response below.",
  followUpWorkedId: "worked",
  followUpWorkedLabel: "Tell me more what worked",
  followUpWorkedPrompt: "Focus: what_worked_detail",
  followUpImproveId: "improve",
  followUpImproveLabel: "Tell me more what to improve",
  followUpImprovePrompt: "Focus: what_to_improve_detail",
  followUpTryNextId: "try_next",
  followUpTryNextLabel: "Tell me more what to try next",
  followUpTryNextPrompt: "Focus: try_next_detail",
  timedOut: (input: { label: string; timeoutMs: number }) => `${input.label} timed out after ${input.timeoutMs}ms`,
  systemPrompt: `You are a private meeting coach for Ready.

You give feedback directly to the authenticated requester, using "you" language.

Rules:
- Return only valid JSON matching the schema.
- Start directly with coaching feedback. Do not summarize what the meeting was about first.
- The requester is the person to coach. Prefer transcript turns where speakerUserId matches requester.userId.
- Use surrounding context only to understand how other people responded to the requester.
- Use the meeting type as the coaching lens:
  - one_on_one or manager_check_in: listening, support, clarity, follow-through.
  - sales_call or customer_success: discovery, trust, objections, customer needs, next steps.
  - interview: structure, fairness, signal gathering, candidate experience.
  - team_sync or standup: clarity, pacing, blockers, ownership, participation.
  - planning or product_review: alignment, decision quality, scope clarity, next actions.
  - retrospective or postmortem: safety, root-cause clarity, ownership, closure.
  - brainstorm: participation, idea development, exploration, convergence.
  - other or missing: general meeting facilitation.
- Ground claims in requester-specific transcript evidence whenever possible.
- Do not infer private intent, emotions, personality, or performance traits beyond the transcript.
- If the requester has little or no transcript evidence, say that briefly in summary, set insufficientRequesterEvidence true, and give only conservative advice supported by owner/facilitator context.
- For initial feedback, keep evidence snippets for grounding and debugging only; the UI will not show quotes.
- For initial feedback, keep every visible feedback point extremely short, specific, and practical.
- For initial feedback, make each point.body one concise standalone sentence that can render as a single bullet.
- For initial feedback, set detailFocus to null and detailParagraphs to [].
- If focus contains "what_worked_detail", set detailFocus to "worked".
- If focus contains "what_to_improve_detail", set detailFocus to "improve".
- If focus contains "try_next_detail", set detailFocus to "try_next".
- If focus contains "custom_question_detail", set detailFocus to "custom".
- In detailed "tell me more" mode, put the visible answer only in detailParagraphs as paragraph-style coaching text, not bullet text.
- In detailed "tell me more" mode, focus only on the selected topic. Do not provide all three themes again.
- In custom question detail mode, answer the user's specific question directly from the meeting transcript, using detailParagraphs as paragraph-style coaching text.
- In custom question detail mode, do not return the three-theme overview unless the user explicitly asks for it.
- In detailed "tell me more" mode, include one or two exact quote examples in each detailParagraph.evidence when transcript evidence supports the paragraph.
- Never return more than two evidence snippets for any feedback point or detail paragraph.
- In detailed "tell me more" mode, keep whatWorked, whatToImprove, and tryNextTime as minimal required placeholders with exactly one item each because the UI ignores them for focused detail responses.
- Do not put quote text, speaker names, or timestamps inside point.body.
- Titles can be terse labels, but the UI may hide titles and show only point.body.
- Generate 2 or 3 follow-up prompt buttons that are specific to this transcript and requester. Reference actual moments, participants, questions, objections, decisions, pacing, handoffs, or facilitation choices.
- Do not use generic follow-up prompts like "How can I improve?" unless the transcript is too weak.
- If the user provided a custom question, answer that question directly in detailParagraphs instead of preserving the three-section overview.`,
} as const;

async function timeoutPromise<T>(input: { timeoutMs: number; label: string }): Promise<T> {
  return new Promise((_, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(MEETING_COACHING_MESSAGES.timedOut({ label: input.label, timeoutMs: input.timeoutMs })));
    }, input.timeoutMs);
    timeoutId.unref();
  });
}

const evidenceSnippetJsonSchema = {
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
} as const;

const feedbackPointJsonSchema = {
  type: "object",
  /** @external OpenAI structured-output JSON schema wire field. */
  additionalProperties: false,
  required: ["title", "body", "evidence"],
  properties: {
    title: { type: "string" },
    body: { type: "string" },
    evidence: {
      type: "array",
      maxItems: EVIDENCE_SNIPPETS_MAX_ITEMS,
      items: evidenceSnippetJsonSchema,
    },
  },
} as const;

const detailParagraphJsonSchema = {
  type: "object",
  /** @external OpenAI structured-output JSON schema wire field. */
  additionalProperties: false,
  required: ["body", "evidence"],
  properties: {
    body: { type: "string" },
    evidence: {
      type: "array",
      maxItems: EVIDENCE_SNIPPETS_MAX_ITEMS,
      items: evidenceSnippetJsonSchema,
    },
  },
} as const;

const meetingCoachingResponseJsonSchema = {
  type: "object",
  /** @external OpenAI structured-output JSON schema wire field. */
  additionalProperties: false,
  required: ["feedback", "model", "promptVersion"],
  properties: {
    model: { type: "string" },
    promptVersion: { type: "string" },
    feedback: {
      type: "object",
      /** @external OpenAI structured-output JSON schema wire field. */
      additionalProperties: false,
      required: [
        "summary",
        "whatWorked",
        "whatToImprove",
        "tryNextTime",
        "followUpPrompts",
        "detailFocus",
        "detailParagraphs",
        "insufficientRequesterEvidence",
      ],
      properties: {
        summary: { type: "string" },
        whatWorked: {
          type: "array",
          minItems: FEEDBACK_POINTS_MIN_ITEMS,
          maxItems: FEEDBACK_POINTS_MAX_ITEMS,
          items: feedbackPointJsonSchema,
        },
        whatToImprove: {
          type: "array",
          minItems: FEEDBACK_POINTS_MIN_ITEMS,
          maxItems: FEEDBACK_POINTS_MAX_ITEMS,
          items: feedbackPointJsonSchema,
        },
        tryNextTime: {
          type: "array",
          minItems: FEEDBACK_POINTS_MIN_ITEMS,
          maxItems: FEEDBACK_POINTS_MAX_ITEMS,
          items: feedbackPointJsonSchema,
        },
        followUpPrompts: {
          type: "array",
          minItems: FOLLOW_UP_PROMPTS_MIN_ITEMS,
          maxItems: FOLLOW_UP_PROMPTS_MAX_ITEMS,
          items: {
            type: "object",
            /** @external OpenAI structured-output JSON schema wire field. */
            additionalProperties: false,
            required: ["id", "label", "prompt"],
            properties: {
              id: { type: "string" },
              label: { type: "string" },
              prompt: { type: "string" },
            },
          },
        },
        detailFocus: {
          type: ["string", "null"],
          enum: ["worked", "improve", "try_next", "custom", null],
        },
        detailParagraphs: {
          type: "array",
          maxItems: DETAIL_PARAGRAPHS_MAX_ITEMS,
          items: detailParagraphJsonSchema,
        },
        // @external insufficientRequesterEvidence
        insufficientRequesterEvidence: { type: "boolean" },
      },
    },
  },
} as const;

export function buildMeetingCoachingSystemPrompt(): string {
  return MEETING_COACHING_MESSAGES.systemPrompt;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeEvidenceSnippet(value: unknown): unknown {
  if (typeof value === "string") {
    return {
      quote: value,
      speaker: null,
      timestamp: null,
      segmentId: null,
    };
  }

  if (!isRecord(value)) {
    return value;
  }

  return {
    ...value,
    segmentId: typeof value.segmentId === "string" && UUID_PATTERN.test(value.segmentId) ? value.segmentId : null,
  };
}

function normalizeEvidenceArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value.slice(0, EVIDENCE_SNIPPETS_MAX_ITEMS).map(normalizeEvidenceSnippet) : [];
}

function normalizeEvidenceBearingItem(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  return {
    ...value,
    evidence: normalizeEvidenceArray(value.evidence),
  };
}

function normalizeFeedbackPointArray(params: {
  value: unknown;
  fallback: { title: string; body: string };
  shouldFillFallback: boolean;
}): unknown[] {
  const normalized = Array.isArray(params.value)
    ? params.value.slice(0, FEEDBACK_POINTS_MAX_ITEMS).map(normalizeEvidenceBearingItem)
    : [];

  return normalized.length !== 0 || !params.shouldFillFallback ? normalized : [{ ...params.fallback, evidence: [] }];
}

function normalizeFollowUpPrompts(value: unknown): unknown[] {
  const normalized = Array.isArray(value) ? value.slice(0, FOLLOW_UP_PROMPTS_MAX_ITEMS) : [];
  if (normalized.length >= FOLLOW_UP_PROMPTS_MIN_ITEMS) {
    return normalized;
  }

  return normalized
    .concat([
      {
        id: MEETING_COACHING_MESSAGES.followUpWorkedId,
        label: MEETING_COACHING_MESSAGES.followUpWorkedLabel,
        prompt: MEETING_COACHING_MESSAGES.followUpWorkedPrompt,
      },
      {
        id: MEETING_COACHING_MESSAGES.followUpImproveId,
        label: MEETING_COACHING_MESSAGES.followUpImproveLabel,
        prompt: MEETING_COACHING_MESSAGES.followUpImprovePrompt,
      },
      {
        id: MEETING_COACHING_MESSAGES.followUpTryNextId,
        label: MEETING_COACHING_MESSAGES.followUpTryNextLabel,
        prompt: MEETING_COACHING_MESSAGES.followUpTryNextPrompt,
      },
    ])
    .slice(0, FOLLOW_UP_PROMPTS_MAX_ITEMS);
}

export function normalizeMeetingCoachingResponseForValidation(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.feedback)) {
    return value;
  }

  const feedback = value.feedback;
  const normalizedDetailFocus =
    feedback.detailFocus ??
    (Array.isArray(feedback.detailParagraphs) && feedback.detailParagraphs.length !== 0 ? "custom" : null);
  const isDetailMode =
    normalizedDetailFocus === "worked" ||
    normalizedDetailFocus === "improve" ||
    normalizedDetailFocus === "custom" ||
    normalizedDetailFocus === "try_next" ||
    (Array.isArray(feedback.detailParagraphs) && feedback.detailParagraphs.length !== 0);

  return {
    ...value,
    feedback: {
      ...feedback,
      detailFocus: normalizedDetailFocus,
      detailParagraphs: Array.isArray(feedback.detailParagraphs)
        ? feedback.detailParagraphs.slice(0, DETAIL_PARAGRAPHS_MAX_ITEMS).map(normalizeEvidenceBearingItem)
        : [],
      followUpPrompts: normalizeFollowUpPrompts(feedback.followUpPrompts),
      whatWorked: normalizeFeedbackPointArray({
        value: feedback.whatWorked,
        fallback: {
          title: MEETING_COACHING_MESSAGES.fallbackWhatWorkedTitle,
          body: MEETING_COACHING_MESSAGES.fallbackWhatWorkedBody,
        },
        shouldFillFallback: isDetailMode,
      }),
      whatToImprove: normalizeFeedbackPointArray({
        value: feedback.whatToImprove,
        fallback: {
          title: MEETING_COACHING_MESSAGES.fallbackWhatToImproveTitle,
          body: MEETING_COACHING_MESSAGES.fallbackWhatToImproveBody,
        },
        shouldFillFallback: isDetailMode,
      }),
      tryNextTime: normalizeFeedbackPointArray({
        value: feedback.tryNextTime,
        fallback: {
          title: MEETING_COACHING_MESSAGES.fallbackTryNextTimeTitle,
          body: MEETING_COACHING_MESSAGES.fallbackTryNextTimeBody,
        },
        shouldFillFallback: isDetailMode,
      }),
    },
  };
}

const meetingCoachingValidatedResponseSchema = z
  .object({
    feedback: z.unknown().optional(),
    followUpPrompts: z.unknown().optional(),
    summary: z.unknown().optional(),
    insufficientRequesterEvidence: z.unknown().optional(),
  })
  .passthrough()
  .transform((value) => normalizeMeetingCoachingResponseForValidation(value))
  .pipe(meetingCoachingGenerationResponseSchema);

export async function generateMeetingCoachingFeedbackWithModel(
  input: MeetingCoachingGenerationRequest,
): Promise<MeetingCoachingGenerationResponse> {
  const parsedInput = meetingCoachingGenerationRequestSchema.parse(input);
  const apiKey = openAIClientApiKey();
  if (apiKey === undefined || apiKey === "") {
    throw new Error(MEETING_COACHING_MESSAGES.openAiKeyRequired);
  }

  const client = createOpenAIClient({ apiKey });
  const model = assistantEnv().OPENAI_CAPABILITY_WORKFLOW_MODEL;
  const { metering, ...modelInput } = parsedInput;
  const response = await Promise.race([
    executeMeteredOpenAIResponse({
      client,
      body: {
        model,
        ...openAIPromptCacheOptions(model),
        input: [
          {
            role: "system",
            content: buildMeetingCoachingSystemPrompt(),
          },
          {
            role: "user",
            content: JSON.stringify({
              ...modelInput,
              outputContract: {
                model,
                promptVersion: MEETING_COACHING_PROMPT_VERSION,
              },
            }),
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "meeting_coaching_feedback",
            /** @external OpenAI structured-output JSON schema wire field */
            strict: true,
            schema: meetingCoachingResponseJsonSchema,
          },
        },
      },
      meetingId:
        metering?.meetingId ??
        (typeof parsedInput.context.meetingId === "string" ? parsedInput.context.meetingId : null),
      workflowRunId: metering?.workflowRunId ?? null,
      source: "capability_workflow",
      operation: "meeting_coaching_feedback",
    }),
    timeoutPromise<never>({
      timeoutMs: assistantEnv().OPENAI_CAPABILITY_WORKFLOW_TIMEOUT_MS,
      label: MEETING_COACHING_MESSAGES.timeoutLabel,
    }),
  ]);

  const text = parseResponseText(response);
  if (text === "") {
    throw new Error(MEETING_COACHING_MESSAGES.emptyModelText);
  }

  const parsed = meetingCoachingValidatedResponseSchema.parse(JSON.parse(text));

  return {
    ...parsed,
    model,
    promptVersion: MEETING_COACHING_PROMPT_VERSION,
  };
}
