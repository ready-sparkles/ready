import { type CapabilitySelectionCapability, extractionConfidenceSchema } from "@readymeet/shared";
import { z } from "zod";

interface SelectionToolDefinition {
  type: "function";
  name: string;
  description: string;
  /** @external OpenAI function tool wire field */
  strict: boolean;
  parameters: Record<string, unknown>;
}

export interface SelectionPayloadResult {
  capabilityKey: string;
  reasoning: string;
  confidence: z.infer<typeof extractionConfidenceSchema>;
  payload: Record<string, unknown>;
}

const basePayloadSchema = z.object({
  reasoning: z.string().trim().min(1),
  confidence: extractionConfidenceSchema,
});

const bugIssueSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  severity_hint: z.enum(["low", "medium", "high"]).optional(),
  reproduction_context: z.string().trim().min(1).optional(),
});

const payloadSchemas = {
  draft_external_follow_up: basePayloadSchema.extend({
    recipient_hint: z.string().trim().min(1),
    subject: z.string().trim().min(1),
    body_outline: z.array(z.string().trim().min(1)).min(1),
    next_steps: z.array(z.string().trim().min(1)).default([]),
  }),
  file_issue_or_bug: basePayloadSchema.extend({
    title: z.string().trim().min(1),
    description: z.string().trim().min(1),
    severity_hint: z.enum(["low", "medium", "high"]),
    reproduction_context: z.string().trim().min(1).optional(),
    issues: z.array(bugIssueSchema).min(1),
  }),
  update_crm: basePayloadSchema.extend({
    account_hint: z.string().trim().min(1),
    opportunity_stage_hint: z.string().trim().min(1).optional(),
    notes: z.array(z.string().trim().min(1)).min(1),
    next_steps: z.array(z.string().trim().min(1)).default([]),
  }),
  schedule_follow_up: basePayloadSchema.extend({
    purpose: z.string().trim().min(1),
    attendees: z.array(z.string().trim().min(1)).default([]),
    timing_hint: z.string().trim().min(1).optional(),
    agenda: z.array(z.string().trim().min(1)).min(1),
  }),
  research_open_question: basePayloadSchema.extend({
    query: z.string().trim().min(1),
    action_label: z.string().trim().min(1),
    task_kind: z.enum(["answer_question", "compare_entities", "extract_sources", "build_dataset", "market_map"]),
    context: z.string().trim().min(1),
    expected_output: z.string().trim().min(1),
    seed_urls: z.array(z.string().trim().min(1)).default([]),
  }),
} as const;

type PayloadCapabilityKey = keyof typeof payloadSchemas;

function stringProperty(description?: string): Record<string, unknown> {
  const hasDescription = description !== undefined && description.length > 0;

  return {
    type: "string",
    ...(hasDescription ? { description } : {}),
  };
}

function stringArrayProperty(description?: string): Record<string, unknown> {
  const hasDescription = description !== undefined && description.length > 0;

  return {
    type: "array",
    items: stringProperty(),
    ...(hasDescription ? { description } : {}),
  };
}

function baseProperties() {
  return {
    reasoning: stringProperty("One sentence explaining why this capability fits this meeting."),
    confidence: {
      type: "string",
      enum: extractionConfidenceSchema.options,
    },
  };
}

const toolParametersByCapability: Record<PayloadCapabilityKey, Record<string, unknown>> = {
  draft_external_follow_up: {
    type: "object",
    /** @external additionalProperties */
    additionalProperties: false,
    required: ["reasoning", "confidence", "recipient_hint", "subject", "body_outline", "next_steps"],
    properties: {
      ...baseProperties(),
      recipient_hint: stringProperty(),
      subject: stringProperty(),
      body_outline: stringArrayProperty(),
      next_steps: stringArrayProperty(),
    },
  },
  file_issue_or_bug: {
    type: "object",
    /** @external additionalProperties */
    additionalProperties: false,
    required: ["reasoning", "confidence", "title", "description", "severity_hint", "issues"],
    properties: {
      ...baseProperties(),
      title: stringProperty(
        "A concise summary title for the overall bug-report batch when multiple distinct bugs are present.",
      ),
      description: stringProperty(
        'A grounded batch summary. If multiple distinct bugs are present, include one numbered section per bug using headings like "1) CSV export fails for large accounts".',
      ),
      severity_hint: {
        type: "string",
        enum: ["low", "medium", "high"],
      },
      reproduction_context: stringProperty(
        "Overall reproduction context. If multiple distinct bugs are present, include per-bug numbered reproduction notes.",
      ),
      issues: {
        type: "array",
        description:
          "One entry per distinct bug or engineering defect found in the extraction. Do not collapse unrelated bugs into one issue.",
        items: {
          type: "object",
          /** @external additionalProperties */
          additionalProperties: false,
          required: ["title", "description"],
          properties: {
            title: stringProperty("A concise Linear issue title for this specific bug."),
            description: stringProperty(
              "A concise issue description grounded in the meeting evidence for this specific bug.",
            ),
            severity_hint: {
              type: "string",
              enum: ["low", "medium", "high"],
            },
            reproduction_context: stringProperty("Reproduction clues for this specific bug when available."),
          },
        },
      },
    },
  },
  update_crm: {
    type: "object",
    /** @external additionalProperties */
    additionalProperties: false,
    required: ["reasoning", "confidence", "account_hint", "notes", "next_steps"],
    properties: {
      ...baseProperties(),
      account_hint: stringProperty(),
      opportunity_stage_hint: stringProperty(),
      notes: stringArrayProperty(),
      next_steps: stringArrayProperty(),
    },
  },
  schedule_follow_up: {
    type: "object",
    /** @external additionalProperties */
    additionalProperties: false,
    required: ["reasoning", "confidence", "purpose", "attendees", "agenda"],
    properties: {
      ...baseProperties(),
      purpose: stringProperty(),
      attendees: stringArrayProperty(),
      timing_hint: stringProperty(),
      agenda: stringArrayProperty(),
    },
  },
  research_open_question: {
    type: "object",
    /** @external additionalProperties */
    additionalProperties: false,
    required: [
      "reasoning",
      "confidence",
      "query",
      "action_label",
      "task_kind",
      "context",
      "expected_output",
      "seed_urls",
    ],
    properties: {
      ...baseProperties(),
      query: stringProperty(
        "A standalone web research query grounded in the transcript. Include enough context to run Search, Extract, FindAll, or synthesis without rereading the meeting.",
      ),
      action_label: stringProperty(
        'A concise visible action label, for example "Deep research on relevant workflow automation companies".',
      ),
      task_kind: {
        type: "string",
        enum: ["answer_question", "compare_entities", "extract_sources", "build_dataset", "market_map"],
      },
      context: stringProperty("Transcript-grounded context that explains why this research is useful."),
      expected_output: stringProperty("The concrete deliverable the research run should produce."),
      seed_urls: stringArrayProperty(
        "Any URLs, PDFs, pages, or domains mentioned in the meeting. Empty when none were mentioned.",
      ),
    },
  },
};

const payloadToolDescriptions: Record<PayloadCapabilityKey, string> = {
  draft_external_follow_up: "Generate the reasoning and prefill for a follow-up message to external participants.",
  file_issue_or_bug:
    "Generate the reasoning and prefill for filing bug issues. If the meeting contains multiple distinct bugs, return multiple issues.",
  update_crm: "Generate the reasoning and prefill for updating CRM/account context.",
  schedule_follow_up: "Generate the reasoning and prefill for scheduling a follow-up meeting.",
  research_open_question:
    "Generate the reasoning and prefill for durable deep research using Search, Extract, FindAll, and synthesis.",
};

function isPayloadCapabilityKey(key: string): key is PayloadCapabilityKey {
  return key in payloadSchemas;
}

const SELECTION_TOOL_MESSAGES = {
  unknownPayloadTool: (input: { toolName: string }) => `Unknown selection payload tool "${input.toolName}"`,
} as const;

function payloadToolNameForCapability(key: string): string {
  return `payload_${key}`;
}

export function buildSelectionPayloadTools(capabilities: CapabilitySelectionCapability[]): SelectionToolDefinition[] {
  return capabilities.flatMap((capability): SelectionToolDefinition[] => {
    if (!isPayloadCapabilityKey(capability.key)) {
      return [];
    }

    return [
      {
        type: "function",
        /** @external OpenAI function tool wire field */
        strict: true,
        name: payloadToolNameForCapability(capability.key),
        description: payloadToolDescriptions[capability.key],
        parameters: toolParametersByCapability[capability.key],
      },
    ];
  });
}

export function parseSelectionPayloadToolCall(input: { toolName: string; rawInput: unknown }): SelectionPayloadResult {
  const capabilityKey = input.toolName.replace(/^payload_/, "");
  if (!isPayloadCapabilityKey(capabilityKey)) {
    throw new Error(SELECTION_TOOL_MESSAGES.unknownPayloadTool({ toolName: input.toolName }));
  }

  const parsed = payloadSchemas[capabilityKey].parse(input.rawInput);
  const { reasoning, confidence, ...payload } = parsed;

  return {
    capabilityKey,
    reasoning,
    confidence,
    payload,
  };
}
