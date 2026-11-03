import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { classifySlackMeeting } from "../../adapters/secondary/slack/slack-meeting-classifier";
import { apiEnv } from "../../composition/env";
import { configureMeteredProvider } from "../../ports/gate-metered-provider";
import { createLlmResponse } from "../../ports/llm-responses";

const SLACK_CLASSIFIER_MAX_OUTPUT_TOKENS = 4096;
const SALES_CONFIDENCE_FIXTURE = 0.2;
const HTTP_STATUS_BAD_REQUEST = 400;
const OPENAI_UNSUPPORTED_VALUE_ERROR_CODE = "unsupported_value";
const LONG_SUMMARY_REPEAT_COUNT = 1000;
const TRANSCRIPT_PADDING_REPEAT_COUNT = 600;
const SLACK_CLASSIFIER_TRANSCRIPT_SUMMARY_MAX_CHARS = 160_000;
const TRANSCRIPT_OVER_MAX_LENGTH = SLACK_CLASSIFIER_TRANSCRIPT_SUMMARY_MAX_CHARS + 1;

const CLASSIFIER_FAILED_BAD_REQUEST_PATTERN = /classifier failed \(400\)/;
const CONTAINS_SENSITIVE_CONTENT_PATTERN = /contains_sensitive_content/;
const CLASSIFIER_INCOMPLETE_MAX_OUTPUT_PATTERN = /classifier returned incomplete: max_output_tokens/;
const INCOMPLETE_PATTERN = /incomplete/;
const FULL_MEETING_PATTERN = /Full meeting/;

const openAiSlackClassifierRequestBodySchema = z.object({
  model: z.string(),
  reasoning: z.object({ effort: z.string() }),
  max_output_tokens: z.number(),
});

const openAiInputContentSchema = z.union([z.string(), z.array(z.object({ text: z.string() }))]);

const openAiSlackClassifierRequestWithInputSchema = z.object({
  input: z.array(z.object({ content: openAiInputContentSchema })),
});

function openAiInputText(content: z.infer<typeof openAiInputContentSchema> | undefined): string {
  if (typeof content === "string") {
    return content;
  }
  if (content === undefined) {
    return "";
  }

  return content.map((part) => part.text).join("");
}

const slackClassifierUserMessageSchema = z.object({
  transcript: z.string(),
});

function readRequestInitBody(init: RequestInit): string {
  if (typeof init.body === "string") {
    return init.body;
  }
  if (init.body === undefined || init.body === null) {
    return "";
  }

  return JSON.stringify(init.body);
}

function parseOpenAiSlackClassifierRequestBody(init: RequestInit) {
  return openAiSlackClassifierRequestBodySchema.parse(JSON.parse(readRequestInitBody(init)));
}

function parseSlackClassifierUserMessageFromRequest(init: RequestInit) {
  const body = openAiSlackClassifierRequestWithInputSchema.parse(JSON.parse(readRequestInitBody(init)));
  const secondMessage = body.input[1];
  assert.ok(secondMessage);

  return slackClassifierUserMessageSchema.parse(JSON.parse(openAiInputText(secondMessage.content)));
}

const input = {
  userId: "11111111-1111-4111-8111-111111111111",
  meetingId: "22222222-2222-4222-8222-222222222222",
  title: "Invented customer discussion",
  participantNames: ["Personaa", "Personbz"],
  guestCount: 1,
  transcript: "Personaa: I sell this product. Personbz: I am considering buying it for my team.",
  summaryContent: "Discussed the product and next steps.",
};

// Classifier wire/JSON tests isolate billing; metered-provider.test exercises actual admission and settlement.
configureMeteredProvider({
  executeMeetingResponse: ({ request, meetingId, userId }) => {
    assert.equal(meetingId, input.meetingId);
    assert.equal(userId, input.userId);

    return createLlmResponse(request);
  },
  meetingDecisionFetcher: () => globalThis.fetch,
  isProviderAccountingError: () => false,
});

void test("Slack classifier sends supported model options and preserves safety flags", async (t) => {
  const originalKey = apiEnv.OPENAI_API_KEY;
  const originalModel = apiEnv.OPENAI_SLACK_CLASSIFIER_MODEL;
  apiEnv.OPENAI_API_KEY = "fixture-not-a-real-key";
  apiEnv.OPENAI_SLACK_CLASSIFIER_MODEL = "gpt-5.4-mini";
  t.after(() => {
    apiEnv.OPENAI_API_KEY = originalKey;
    apiEnv.OPENAI_SLACK_CLASSIFIER_MODEL = originalModel;
  });
  const requestsState: { requests: Record<string, unknown>[] } = { requests: [] };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    const body = parseOpenAiSlackClassifierRequestBody(init);
    requestsState.requests = [...requestsState.requests, body];
    assert.equal(body.model, "gpt-5.4-mini");
    assert.equal(body.reasoning.effort, "low");
    assert.equal(body.max_output_tokens, SLACK_CLASSIFIER_MAX_OUTPUT_TOKENS);

    return Response.json({
      output_text: JSON.stringify({
        category: "sales",
        is_internal_one_on_one: false,
        /** @external slack classifier sensitive content wire field */
        contains_sensitive_content: true,
        sensitive_reason: "Compensation information",
        /** @external slack classifier pure sales call wire field */
        pure_sales_call: false,
        sales_confidence: SALES_CONFIDENCE_FIXTURE,
        no_sensitive_content_confidence: 0,
        salesperson_evidence: "",
        customer_evidence: "",
      }),
    });
  });
  assert.deepEqual(await classifySlackMeeting(input), {
    category: "sales",
    isInternalOneOnOne: false,
    /** @external slack classifier sensitive content wire field */
    containsSensitiveContent: true,
    sensitiveReason: "Compensation information",
    /** @external slack classifier pure sales call wire field */
    pureSalesCall: false,
    salesConfidence: SALES_CONFIDENCE_FIXTURE,
    noSensitiveContentConfidence: 0,
    salespersonEvidence: "",
    customerEvidence: "",
  });
  assert.equal(requestsState.requests.length, 1);
});

void test("Slack classifier fails closed on provider errors and invalid safety flags", async (t) => {
  const originalKey = apiEnv.OPENAI_API_KEY;
  apiEnv.OPENAI_API_KEY = "fixture-not-a-real-key";
  t.after(() => {
    apiEnv.OPENAI_API_KEY = originalKey;
  });
  const fetchMock = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: { code: OPENAI_UNSUPPORTED_VALUE_ERROR_CODE } }, { status: HTTP_STATUS_BAD_REQUEST }),
  );
  await assert.rejects(classifySlackMeeting(input), CLASSIFIER_FAILED_BAD_REQUEST_PATTERN);
  fetchMock.mock.mockImplementation(async () =>
    Response.json({
      output_text: JSON.stringify({ category: "sales" }),
    }),
  );
  await assert.rejects(classifySlackMeeting(input), CONTAINS_SENSITIVE_CONTENT_PATTERN);
});

void test("Slack classifier rejects incomplete responses even with valid JSON and never retries", async (t) => {
  const originalKey = apiEnv.OPENAI_API_KEY;
  apiEnv.OPENAI_API_KEY = "fixture-not-a-real-key";
  t.after(() => {
    apiEnv.OPENAI_API_KEY = originalKey;
  });
  const fetchMock = t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output_text: JSON.stringify({
        category: "sales",
        is_internal_one_on_one: false,
        /** @external slack classifier sensitive content wire field */
        contains_sensitive_content: false,
      }),
    }),
  );
  await assert.rejects(
    classifySlackMeeting({ ...input, summaryContent: "Long notes. ".repeat(LONG_SUMMARY_REPEAT_COUNT) }),
    CLASSIFIER_INCOMPLETE_MAX_OUTPUT_PATTERN,
  );
  assert.equal(fetchMock.mock.callCount(), 1);
});

void test("classification examines the transcript tail and never silently truncates long input", async (t) => {
  const originalKey = apiEnv.OPENAI_API_KEY;
  apiEnv.OPENAI_API_KEY = "fixture";
  t.after(() => {
    apiEnv.OPENAI_API_KEY = originalKey;
  });
  const transcript = `${"Product discussion. ".repeat(TRANSCRIPT_PADDING_REPEAT_COUNT)}Private medical details at the end.`;
  const mock = t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const data = parseSlackClassifierUserMessageFromRequest(init ?? {});
    assert.equal(data.transcript, transcript);

    return Response.json({ status: "incomplete" });
  });
  await assert.rejects(classifySlackMeeting({ ...input, transcript }), INCOMPLETE_PATTERN);
  await assert.rejects(
    classifySlackMeeting({ ...input, transcript: "x".repeat(TRANSCRIPT_OVER_MAX_LENGTH) }),
    FULL_MEETING_PATTERN,
  );
  await assert.rejects(classifySlackMeeting({ ...input, transcript: "" }), FULL_MEETING_PATTERN);
  assert.equal(mock.mock.callCount(), 1);
});
