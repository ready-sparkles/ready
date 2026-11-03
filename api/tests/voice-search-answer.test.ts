import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { z } from "zod";

import {
  sanitizeParallelWebSearchResponse,
  synthesizeParallelTurboAnswer,
  synthesizeParallelTurboAnswerWithFallback,
} from "../application/agent-tool-broker";
import { apiEnv } from "../composition/env";

const MIN_SYNTHESIS_MAX_OUTPUT_TOKENS = 4000;
const SYNTHESIS_REQUEST_MIN_INPUT_MESSAGES = 2;
const EXCERPT_MAX_LENGTH = 900;
const GENERAL_INFO_REPEAT_COUNT = 60;
const RESEARCH_SOURCE_COUNT = 8;
const LONG_EXCERPT_CHAR_COUNT = 30000;
const PARALLEL_WEB_SEARCH_MAX_CHARS_TOTAL = 18_000;
const BACKGROUND_REPEAT_COUNT = 800;
const SPOKEN_ANSWER_REPEAT_COUNT = 4;

const EXPECTED_VOICE_CARD_MESSAGE = "Expected a voice card";
const EXPECTED_SYNTHESIS_REQUEST_MESSAGE = "Expected a synthesis request";
const EXPECTED_SYNTHESIS_EVIDENCE_MESSAGE = "Expected synthesis evidence";
const EXPECTED_RESEARCH_CLAIM_MESSAGE = "Expected a research claim";
const MALFORMED_CLAIM_TEXT = "Pro costs $25.";
const INFERENCE_CLAIM_TEXT = "A monthly plan may fit a short trial.";

const openAiSynthesisRequestBodySchema = z.object({
  text: z.object({
    format: z.object({
      type: z.literal("json_schema"),
      strict: z.boolean(),
    }),
  }),
  max_output_tokens: z.number(),
  reasoning: z.object({ effort: z.literal("none") }),
});

const openAiInputContentSchema = z.union([z.string(), z.array(z.object({ text: z.string() }))]);

function openAiInputText(content: z.infer<typeof openAiInputContentSchema> | undefined): string {
  if (typeof content === "string") {
    return content;
  }
  if (content === undefined) {
    return "";
  }

  return content.map((part) => part.text).join("");
}

const openAiSynthesisRequestInputSchema = z.object({
  input: z.array(z.object({ content: openAiInputContentSchema })).min(SYNTHESIS_REQUEST_MIN_INPUT_MESSAGES),
});

const fetchInitForTestSchema = z.object({
  body: z.union([z.string(), z.undefined(), z.null()]).optional(),
});

const synthesisSourcesContentSchema = z.object({
  sources: z.array(
    z.object({
      quote_or_excerpt: z.string(),
    }),
  ),
});

function readFetchOptionsBody(options: unknown): string {
  const parsed = fetchInitForTestSchema.parse(options ?? {});
  const bodyValue = parsed.body;
  if (typeof bodyValue === "string") {
    return bodyValue;
  }

  return "";
}

function parseSynthesisRequestBody(options: unknown) {
  return openAiSynthesisRequestBodySchema.parse(JSON.parse(readFetchOptionsBody(options)));
}

function parseSynthesisSourcesFromFetchOptions(options: unknown) {
  const body = openAiSynthesisRequestInputSchema.parse(JSON.parse(readFetchOptionsBody(options)));
  const secondMessage = body.input[1];
  if (secondMessage === undefined) {
    throw new Error(EXPECTED_SYNTHESIS_REQUEST_MESSAGE);
  }

  return synthesisSourcesContentSchema.parse(JSON.parse(openAiInputText(secondMessage.content)));
}

const source = { title: "Official pricing", url: "https://example.com/pricing", excerpts: ["Pro: $25 monthly"] };
const answer = {
  answer_brief: "Pro costs $25 monthly before tax.",
  spoken_answer: "Pro costs $25 monthly before tax.",
  confidence: "high",
  claims: [{ text: "Pro costs $25 monthly before tax.", citation_ids: ["c1"] }],
  caveats: [],
};
function mockSynthesis({ t, payload }: { t: TestContext; payload: unknown }) {
  const oldKey = apiEnv.OPENAI_API_KEY;
  const oldModel = apiEnv.OPENAI_AMBIENT_CONTEXT_MODEL;
  apiEnv.OPENAI_API_KEY = "test-only";
  apiEnv.OPENAI_AMBIENT_CONTEXT_MODEL = "gpt-5.4-nano";
  t.after(() => {
    apiEnv.OPENAI_API_KEY = oldKey;
    apiEnv.OPENAI_AMBIENT_CONTEXT_MODEL = oldModel;
  });

  return t.mock.method(globalThis, "fetch", async (_url: unknown, options?: RequestInit) => {
    const body = parseSynthesisRequestBody(options);
    assert.equal(body.text.format.type, "json_schema");
    assert.equal(body.text.format.strict, true);
    assert.ok(body.max_output_tokens >= MIN_SYNTHESIS_MAX_OUTPUT_TOKENS);
    assert.deepEqual(body.reasoning, { effort: "none" });

    return Response.json(payload);
  });
}
function results({
  excerpts = source.excerpts,
  isIncludeEvidence = true,
}: {
  excerpts?: string[];
  isIncludeEvidence?: boolean;
} = {}) {
  return sanitizeParallelWebSearchResponse({
    query: "Pro price?",
    response: { results: [{ ...source, excerpts }] },
    /** @external parallel web search include evidence wire field */
    includeEvidence: isIncludeEvidence,
  }).results;
}

void test("voice and post-meeting cards preserve short prices, scores and dates with longer context", () => {
  ["| Pro | $25 |", "* Pro: $25", "Lakers 112, Celtics 108", "Launch: May 5"].forEach((fact) => {
    const card = results({
      excerpts: [`A detailed description of the current official results.\n${fact}`],
      isIncludeEvidence: false,
    })[0];
    if (!card) {
      throw new Error(EXPECTED_VOICE_CARD_MESSAGE);
    }
    assert.match(card.excerpt, /\$25|112|May 5/);
    assert.equal(card.evidenceExcerpts, undefined, "existing research callers retain compact source shape");
    assert.ok(card.excerpt.length <= EXCERPT_MAX_LENGTH);
  });
});

void test("synthesis evidence preserves later excerpts and content beyond the card limit", async (t) => {
  const evidence = results({
    excerpts: [`${"General information. ".repeat(GENERAL_INFO_REPEAT_COUNT)}Price: $25.`, "Renewal: $30."],
  });
  const mock = mockSynthesis({ t, payload: { status: "completed", output_text: JSON.stringify(answer) } });
  await synthesizeParallelTurboAnswer({ query: "Pro price?", results: evidence });
  const synthesisCall = mock.mock.calls[0];
  if (!synthesisCall) {
    throw new Error(EXPECTED_SYNTHESIS_REQUEST_MESSAGE);
  }
  const sourcesPayload = parseSynthesisSourcesFromFetchOptions(synthesisCall.arguments[1]);
  const firstSource = sourcesPayload.sources[0];
  if (!firstSource) {
    throw new Error(EXPECTED_SYNTHESIS_REQUEST_MESSAGE);
  }
  assert.match(firstSource.quote_or_excerpt, /Price: \$25/);
  assert.match(firstSource.quote_or_excerpt, /Renewal: \$30/);
  const firstEvidence = evidence[0];
  if (!firstEvidence) {
    throw new Error(EXPECTED_SYNTHESIS_EVIDENCE_MESSAGE);
  }
  assert.ok(firstEvidence.excerpt.length <= EXCERPT_MAX_LENGTH);
});

void test("research evidence stays bounded and retains evidence from each selected source", () => {
  const cards = sanitizeParallelWebSearchResponse({
    query: "prices",
    /** @external parallel web search include evidence wire field */
    includeEvidence: true,
    response: {
      results: Array.from({ length: RESEARCH_SOURCE_COUNT }, (_, i) => ({
        ...source,
        url: `https://example.com/${i}`,
        excerpts: ["x".repeat(LONG_EXCERPT_CHAR_COUNT), `Source ${i} price: $25`],
      })),
    },
  }).results;
  assert.ok(
    cards.reduce((sum, card) => sum + (card.evidenceExcerpts ?? []).join("\n").length, 0) <=
      PARALLEL_WEB_SEARCH_MAX_CHARS_TOTAL,
  );
  assert.ok(cards.every((card) => (card.evidenceExcerpts ?? []).some((text) => text.includes("price: $25"))));
});

void test("keeps all evidence under the provider budget even when one source is much longer", () => {
  const long = `${"Background. ".repeat(BACKGROUND_REPEAT_COUNT)}The relevant price is $25.`;
  const cards = sanitizeParallelWebSearchResponse({
    query: "price",
    /** @external parallel web search include evidence wire field */
    includeEvidence: true,
    response: {
      results: [
        { ...source, excerpts: [long] },
        { ...source, url: "https://example.org", excerpts: ["A short second source."] },
      ],
    },
  }).results;
  assert.equal(cards[0]?.evidenceExcerpts?.[0], long);
});

["high", "High", " HIGH ", "medium", "low", "unverified"].forEach((confidence) => {
  void test(`normalizes ${JSON.stringify(confidence)} without changing a supported spoken answer`, async (t) => {
    mockSynthesis({ t, payload: { status: "completed", output_text: JSON.stringify({ ...answer, confidence }) } });
    const result = await synthesizeParallelTurboAnswer({ query: "Pro price?", results: results() });
    assert.equal(result.confidence, confidence.trim().toLowerCase());
    assert.equal(result.spoken_answer, answer.spoken_answer);
  });
});

[
  { confidence: undefined },
  { confidence: "certain" },
  { claims: [{ text: MALFORMED_CLAIM_TEXT, citation_ids: ["missing"] }] },
].forEach((change) => {
  void test(`rejects malformed synthesis metadata instead of mislabelling evidence: ${JSON.stringify(change)}`, async (t) => {
    mockSynthesis({ t, payload: { status: "completed", output_text: JSON.stringify({ ...answer, ...change }) } });
    await assert.rejects(synthesizeParallelTurboAnswer({ query: "price", results: results() }), /synthesis/i);
  });
});

void test("longer spoken answers preserve their ending and material caveats without clipping", async (t) => {
  const spoken = `${"The published price covers each person using the service monthly. ".repeat(
    SPOKEN_ANSWER_REPEAT_COUNT,
  )}That excludes tax and requires an annual contract.`;
  mockSynthesis({
    t,
    payload: {
      status: "completed",
      output_text: JSON.stringify({ ...answer, spoken_answer: spoken, caveats: ["Requires an annual contract."] }),
    },
  });
  const result = await synthesizeParallelTurboAnswer({ query: "price", results: results() });
  assert.equal(result.spoken_answer, spoken);
  assert.deepEqual(result.caveats, ["Requires an annual contract."]);
});

[
  { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] },
  { status: "completed", output_text: '{"answer_brief":' },
  { status: "completed", output: [{ content: [{ type: "refusal", refusal: "No" }] }] },
].forEach((payload) => {
  void test(`synthesis failure retains sources without retrying: ${JSON.stringify(payload)}`, async (t) => {
    const mock = mockSynthesis({ t, payload });
    const result = await synthesizeParallelTurboAnswerWithFallback({ query: "price", results: results() });
    assert.equal(result.answerStatus, "synthesis_failed");
    assert.equal(result.researchResult.claims.length, 0);
    assert.equal(result.researchResult.citations[0]?.url, source.url);
    assert.match(result.researchResult.spoken_answer, /preparing the answer/);
    assert.equal(mock.mock.calls.length, 1);
  });
});

void test("insufficient evidence is distinct from failed synthesis", async (t) => {
  mockSynthesis({
    t,
    payload: {
      status: "completed",
      output_text: JSON.stringify({
        ...answer,
        confidence: "unverified",
        claims: [],
        answer_brief: "",
        spoken_answer: "",
      }),
    },
  });
  const result = await synthesizeParallelTurboAnswerWithFallback({ query: "price", results: results() });
  assert.equal(result.answerStatus, "insufficient_evidence");
  assert.equal(result.researchResult.confidence, "unverified");
  assert.doesNotMatch(result.researchResult.spoken_answer, /\$25|preparing the answer/);
});

void test("reasonable inference can be retained without a citation on every claim", async (t) => {
  const inference = {
    ...answer,
    answer_brief: "That suggests the monthly plan fits a short trial.",
    spoken_answer: "That suggests the monthly plan fits a short trial.",
    confidence: "medium",
    claims: [{ text: INFERENCE_CLAIM_TEXT, citation_ids: [] }],
  };
  mockSynthesis({ t, payload: { status: "completed", output_text: JSON.stringify(inference) } });
  const output = await synthesizeParallelTurboAnswerWithFallback({
    query: "Would this fit a short trial?",
    results: results(),
  });
  assert.equal(output.answerStatus, "ready");
  assert.equal(output.researchResult.confidence, "medium");
  assert.equal(output.researchResult.spoken_answer, inference.spoken_answer);
  const firstClaim = output.researchResult.claims[0];
  if (!firstClaim) {
    throw new Error(EXPECTED_RESEARCH_CLAIM_MESSAGE);
  }
  assert.deepEqual(firstClaim.citation_ids, []);
});

void test("no usable excerpts is insufficient evidence, without a paid synthesis or search error", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => assert.fail("No synthesis without evidence"));
  await [[], results({ excerpts: [] })].reduce(async (previous, sources) => {
    await previous;
    const result = await synthesizeParallelTurboAnswerWithFallback({ query: "price", results: sources });
    assert.equal(result.answerStatus, "insufficient_evidence");
    assert.equal(result.synthesisError, null);
    assert.equal(result.researchResult.claims.length, 0);
  }, Promise.resolve());
  assert.equal(mock.mock.calls.length, 0);
});
