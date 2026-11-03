import "../../composition/wire";
import "../../adapters/secondary/node/env";

import { closeDbPool } from "@readymeet/db";
import {
  memoryFailureDiagnostic,
  type MemoryGeneration,
  type MemoryGenerationInput,
  MemoryGenerationRejected,
  memoryPreferencesSchema,
} from "@readymeet/shared";
import Fastify from "fastify";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, beforeEach } from "node:test";
import { z } from "zod";

import { internalRoutes } from "../../adapters/primary/http/routes";
import { generateMeetingMemory } from "../../application/memory-generation";
import { createMemoryModelRunner, type MemoryModelRunner } from "../../application/relationship-memory";
import { assistantEnv } from "../../ports/assistant-env";
import { repositories } from "../../ports/repository-runtime";
import { gatewayTextResponse, mockAssistantUsageMetering } from "../usage-metering-fixture";

after(closeDbPool);

beforeEach((t) => {
  if ("mock" in t) {
    mockAssistantUsageMetering(t);
  }
});

const MEMORY_GENERATION_TEST_MESSAGES = {
  mustNotContactProvider: "Must not contact provider",
  privateProviderMessage: "private provider message",
  providerErrorCode: "provider_error",
  providerStageModel: "model",
  creditBalanceExhausted: "credit_balance_exhausted",
  insufficientQuota: "insufficient_quota",
  responseSchemaCode: "response_schema",
  invalidStringCode: "invalid_string",
  jussiSummaryLine: "Personqa offered to discuss your proposal with Personqg.",
  allSegmentsTogether: /All transcript segments are supplied together/,
  singleCallContextBudget: /single-call context budget/,
  fixtureOversizedPrompt: "prompt",
  rejectedMemoryRef: "secret@example.com",
  privateUnfinishedSummary: "private unfinished sentence",
} as const;

type MemoryModelRunInput<T> = {
  prompt: string;
  payload: unknown;
  schema: z.ZodType<T>;
  name: string;
  meetingId: string | null;
};

const memoryFixtureSuccessSchema = z.object({ isSuccessful: z.boolean() });

const MEMORY_GENERATION_TEST_IMPORTANCE = 4;
const MEMORY_GENERATION_TEST_SEGMENT_MINUTES = 240;
const MEMORY_GENERATION_TEST_MS_PER_MINUTE = 60_000;
const MEMORY_GENERATION_TEST_SEGMENT_CONTENT_REPEAT = 12;
const MEMORY_GENERATION_TEST_SEGMENT_COUNT_WITH_OPENING = 241;
const MEMORY_GENERATION_TEST_LAST_SEGMENT_INDEX = 240;
const MEMORY_GENERATION_TEST_PEOPLE_COUNT = 2;
const MEMORY_GENERATION_TEST_OVERSIZED_INPUT_CHARS = 960_000;
const MEMORY_GENERATION_TEST_HTTP_STATUS_SERVICE_UNAVAILABLE = 503;
const MEMORY_GENERATION_TEST_HTTP_STATUS_UNPROCESSABLE = 422;
const MEMORY_GENERATION_TEST_HTTP_STATUS_TOO_MANY_REQUESTS = 429;

const memoryRunnerPayloadSchema = z.object({
  segments: z.array(z.object({ text: z.string(), speaker: z.string() })),
  history: z.array(z.object({ memories: z.array(z.object({ id: z.string() })) })),
});

const memoryRouteProviderErrorDiagnosticSchema = z.object({
  code: z.literal(MEMORY_GENERATION_TEST_MESSAGES.providerErrorCode),
  stage: z.literal(MEMORY_GENERATION_TEST_MESSAGES.providerStageModel),
  httpStatus: z.literal(MEMORY_GENERATION_TEST_HTTP_STATUS_TOO_MANY_REQUESTS),
  providerCode: z.literal(MEMORY_GENERATION_TEST_MESSAGES.creditBalanceExhausted),
});

const memoryRouteInjectErrorBodySchema = z.object({
  diagnostic: memoryRouteProviderErrorDiagnosticSchema,
});

const memoryRouteValidationDiagnosticSchema = z.object({
  code: z.literal(MEMORY_GENERATION_TEST_MESSAGES.responseSchemaCode),
  stage: z.literal(MEMORY_GENERATION_TEST_MESSAGES.providerStageModel),
  issues: z.array(
    z.object({
      code: z.literal(MEMORY_GENERATION_TEST_MESSAGES.invalidStringCode),
      path: z.array(z.union([z.string(), z.number()])),
    }),
  ),
});

const memoryRouteValidationBodySchema = z.object({
  diagnostic: memoryRouteValidationDiagnosticSchema,
});

const memoryGenerationLogLineSchema = z.object({
  diagnostic: z.object({ code: z.string() }).optional(),
});

function memorySensitiveWire(isSensitive: boolean) {
  return {
    /** @external sensitive */
    sensitive: isSensitive,
  };
}

const MEMORY_GENERATION_TEST_ASSERT_MESSAGES = {
  expectedFirstPerson: "Expected fixture first person",
  expectedFirstHistory: "Expected fixture first history entry",
  expectedFirstSegment: "Expected fixture first segment",
  expectedFirstMemory: "Expected generated first memory",
  expectedFirstEvidence: "Expected first evidence entry",
  expectedFirstPersonOutput: "Expected first person in model output",
  expectedFirstSummary: "Expected first summary entry",
  expectedMappedLastSegment: "Expected mapped last segment",
  expectedMappedHistoryMemory: "Expected mapped history memory",
} as const;

function requiredAt<T>(input: { items: readonly T[]; index: number; message: string }): T {
  const value = input.items.at(input.index);
  assert.ok(value !== undefined, input.message);

  return value;
}

function firstFixturePerson(input: MemoryGenerationInput) {
  return requiredAt({
    items: input.people,
    index: 0,
    message: MEMORY_GENERATION_TEST_ASSERT_MESSAGES.expectedFirstPerson,
  });
}

function firstFixtureHistory(input: MemoryGenerationInput) {
  return requiredAt({
    items: input.history,
    index: 0,
    message: MEMORY_GENERATION_TEST_ASSERT_MESSAGES.expectedFirstHistory,
  });
}

function firstFixtureSegment(input: MemoryGenerationInput) {
  return requiredAt({
    items: input.segments,
    index: 0,
    message: MEMORY_GENERATION_TEST_ASSERT_MESSAGES.expectedFirstSegment,
  });
}

function createCallCounter() {
  return { count: 0 };
}

type GeneratedMemoryWire = Omit<MemoryGeneration["memories"][number], "evidence"> & {
  evidence: { segmentId: string }[];
};
type MemoryGenerationOutput = Omit<MemoryGeneration, "memories"> & { memories: GeneratedMemoryWire[] };

function firstGeneratedMemory(result: MemoryGenerationOutput) {
  return requiredAt({
    items: result.memories,
    index: 0,
    message: MEMORY_GENERATION_TEST_ASSERT_MESSAGES.expectedFirstMemory,
  });
}

function firstGeneratedPerson(result: MemoryGenerationOutput) {
  return requiredAt({
    items: result.people,
    index: 0,
    message: MEMORY_GENERATION_TEST_ASSERT_MESSAGES.expectedFirstPersonOutput,
  });
}

function firstGeneratedSummary(result: MemoryGenerationOutput) {
  const person = firstGeneratedPerson(result);

  return requiredAt({
    items: person.summary,
    index: 0,
    message: MEMORY_GENERATION_TEST_ASSERT_MESSAGES.expectedFirstSummary,
  });
}

function firstGeneratedEvidence(result: MemoryGenerationOutput) {
  const memory = firstGeneratedMemory(result);

  return requiredAt({
    items: memory.evidence,
    index: 0,
    message: MEMORY_GENERATION_TEST_ASSERT_MESSAGES.expectedFirstEvidence,
  });
}

function fixture(): MemoryGenerationInput {
  const person = { id: randomUUID(), userId: randomUUID(), name: "Personqa" };

  return {
    meetingId: randomUUID(),
    ownerUserId: randomUUID(),
    title: "Joining discussion",
    occurredAt: "2026-09-01T14:00:00Z",
    preferences: memoryPreferencesSchema.parse({}),
    people: [person],
    segments: [
      {
        id: randomUUID(),
        speakerUserId: person.userId,
        speakerName: "Personqa",
        content: "Puhun Personqf kanssa ehdotuksesta sinulle huomenna.",
        startedAt: "2026-09-01T10:00:00Z",
      },
    ],
    history: [
      {
        meetingId: null,
        personId: person.id,
        name: person.name,
        language: "English",
        memories: [],
      },
    ],
  };
}
function output(input: MemoryGenerationInput): MemoryGenerationOutput {
  const primaryPerson = firstFixturePerson(input);

  return {
    memories: [
      {
        ref: "N1",
        title: "Personqa will discuss your proposal with Personqg",
        description: "Personqa offered to discuss your proposal with Personqg the following day.",
        category: "Recruiting",
        factIdentity: {
          subject: primaryPerson.id,
          predicate: "offered owner",
          object: "joining proposal",
          context: "",
        },
        existingFactKey: null,
        importance: MEMORY_GENERATION_TEST_IMPORTANCE,
        personIds: [primaryPerson.id],
        candidateSubjectId: null,
        candidateSubjectKey: null,
        ...memorySensitiveWire(false),
        confidence: "high",
        evidence: [{ segmentId: "S1" }],
      },
    ],
    people: input.people.map((p) => ({
      personId: p.id,
      summary:
        p.id === primaryPerson.id
          ? [{ text: MEMORY_GENERATION_TEST_MESSAGES.jussiSummaryLine, memoryRefs: ["N1"] }]
          : [],
      standing: [],
    })),
  };
}

function buildMultilingualMeetingInput() {
  const base = fixture();
  const other = { id: randomUUID(), userId: randomUUID(), name: "Personqw" };
  const earlier = {
    id: randomUUID(),
    title: "You asked about joining",
    description: "Compensation was an open question.",
    occurredAt: "2026-08-01T12:00:00Z",
  };
  const openingSegment = firstFixtureSegment(base);
  const primaryHistory = firstFixtureHistory(base);

  return {
    earlier,
    input: {
      ...base,
      people: [...base.people, other],
      history: [
        { ...primaryHistory, memories: [...primaryHistory.memories, earlier] },
        {
          meetingId: null,
          personId: other.id,
          name: other.name,
          language: "English",
          memories: [],
        },
      ],
      segments: [
        ...base.segments,
        ...Array.from({ length: MEMORY_GENERATION_TEST_SEGMENT_MINUTES }, (_, index) => {
          const minute = index + 1;

          return {
            id: randomUUID(),
            speakerUserId: base.ownerUserId,
            speakerName: "Personqc",
            startedAt: new Date(
              Date.parse(openingSegment.startedAt) + minute * MEMORY_GENERATION_TEST_MS_PER_MINUTE,
            ).toISOString(),
            content:
              minute === MEMORY_GENERATION_TEST_SEGMENT_MINUTES
                ? "Joo, katsotaan ehdotus huomenna. Time commitment is still open."
                : "We discussed the practical details of working together. ".repeat(
                    MEMORY_GENERATION_TEST_SEGMENT_CONTENT_REPEAT,
                  ),
          };
        }),
      ],
    } satisfies MemoryGenerationInput,
  };
}

function createMultilingualMeetingRunner(params: {
  generationInput: MemoryGenerationInput;
  calls: ReturnType<typeof createCallCounter>;
}): MemoryModelRunner {
  const { generationInput, calls } = params;

  return {
    async run<T>(runInput: MemoryModelRunInput<T>) {
      calls.count = calls.count + 1;
      assert.equal(runInput.name, "relationship_meeting");
      assert.match(runInput.prompt, MEMORY_GENERATION_TEST_MESSAGES.allSegmentsTogether);
      const mapped = memoryRunnerPayloadSchema.parse(runInput.payload);
      assert.equal(mapped.segments.length, MEMORY_GENERATION_TEST_SEGMENT_COUNT_WITH_OPENING);
      const mappedLastSegment = requiredAt({
        items: mapped.segments,
        index: MEMORY_GENERATION_TEST_LAST_SEGMENT_INDEX,
        message: MEMORY_GENERATION_TEST_ASSERT_MESSAGES.expectedMappedLastSegment,
      });
      assert.equal(mappedLastSegment.speaker, "You");
      assert.match(mappedLastSegment.text, /Time commitment/);
      const mappedHistoryMemory = requiredAt({
        items: requiredAt({
          items: mapped.history,
          index: 0,
          message: MEMORY_GENERATION_TEST_ASSERT_MESSAGES.expectedFirstHistory,
        }).memories,
        index: 0,
        message: MEMORY_GENERATION_TEST_ASSERT_MESSAGES.expectedMappedHistoryMemory,
      });
      assert.equal(mappedHistoryMemory.id, "H1");
      const generated = output(generationInput);
      const memory = firstGeneratedMemory(generated);
      const summary = firstGeneratedSummary(generated);
      const parsedResult = {
        ...generated,
        memories: [{ ...memory, evidence: [...memory.evidence, { segmentId: "S241" }] }],
        people: generated.people.map((person, personIndex) =>
          personIndex === 0
            ? { ...person, summary: [{ ...summary, memoryRefs: [...summary.memoryRefs, "H1"] }] }
            : person,
        ),
      };

      return { value: runInput.schema.parse(parsedResult), model: "fixture" };
    },
  };
}

function assertMultilingualMeetingResult(input: {
  generationInput: MemoryGenerationInput;
  result: Awaited<ReturnType<typeof generateMeetingMemory>>;
  earlierId: string;
}) {
  const generatedMemory = requiredAt({
    items: input.result.value.memories,
    index: 0,
    message: MEMORY_GENERATION_TEST_ASSERT_MESSAGES.expectedFirstMemory,
  });
  assert.deepEqual(
    generatedMemory.evidence.map((e) => e.segmentId),
    [
      firstFixtureSegment(input.generationInput).id,
      requiredAt({
        items: input.generationInput.segments,
        index: MEMORY_GENERATION_TEST_LAST_SEGMENT_INDEX,
        message: MEMORY_GENERATION_TEST_ASSERT_MESSAGES.expectedFirstSegment,
      }).id,
    ],
  );
  assert.equal(
    requiredAt({
      items: generatedMemory.evidence,
      index: 0,
      message: MEMORY_GENERATION_TEST_ASSERT_MESSAGES.expectedFirstEvidence,
    }).quote,
    firstFixtureSegment(input.generationInput).content,
  );
  assert.deepEqual(
    requiredAt({
      items: requiredAt({
        items: input.result.value.people,
        index: 0,
        message: MEMORY_GENERATION_TEST_ASSERT_MESSAGES.expectedFirstPersonOutput,
      }).summary,
      index: 0,
      message: MEMORY_GENERATION_TEST_ASSERT_MESSAGES.expectedFirstSummary,
    }).memoryRefs,
    ["N1", input.earlierId],
  );
  assert.equal(input.result.value.people.length, MEMORY_GENERATION_TEST_PEOPLE_COUNT);
}

void test("a four-hour multilingual group meeting extracts distant evidence and every summary in one call", async () => {
  const { input, earlier } = buildMultilingualMeetingInput();
  const calls = createCallCounter();
  const result = await generateMeetingMemory({
    input,
    runner: createMultilingualMeetingRunner({ generationInput: input, calls }),
  });
  assert.equal(calls.count, 1);
  assertMultilingualMeetingResult({ generationInput: input, result, earlierId: earlier.id });
});

void test("zero memories completes in one call with empty person summaries", async () => {
  const input = fixture();
  const calls = createCallCounter();
  const result = await generateMeetingMemory({
    input,
    runner: {
      async run<T>(runInput: MemoryModelRunInput<T>) {
        calls.count += 1;

        return {
          value: runInput.schema.parse({
            memories: [],
            people: [{ personId: firstFixturePerson(input).id, summary: [], standing: [] }],
          }),
          model: "fixture",
        };
      },
    },
  });
  assert.equal(calls.count, 1);
  assert.deepEqual(result.value.memories, []);
});

function applyCombinedValidationScenario(input: {
  result: MemoryGenerationOutput;
  scenario: string;
}): MemoryGenerationOutput {
  const { result, scenario } = input;
  const memory = firstGeneratedMemory(result);
  const person = firstGeneratedPerson(result);
  const summary = firstGeneratedSummary(result);
  const evidence = firstGeneratedEvidence(result);

  if (scenario === "unknown evidence") {
    return { ...result, memories: [{ ...memory, evidence: [{ ...evidence, segmentId: "S999" }] }] };
  }
  if (scenario === "unknown citation") {
    return {
      ...result,
      people: [{ ...person, summary: [{ ...summary, memoryRefs: ["H999"] }] }],
    };
  }
  if (scenario === "cross person") {
    return { ...result, people: [{ ...person, personId: randomUUID() }] };
  }
  if (scenario === "missing person") {
    return { ...result, people: [] };
  }
  if (scenario === "duplicate ref") {
    return { ...result, memories: [...result.memories, memory] };
  }
  if (scenario === "sensitive") {
    return { ...result, memories: [{ ...memory, ...memorySensitiveWire(true) }] };
  }
  if (scenario === "low confidence") {
    return { ...result, memories: [{ ...memory, confidence: "low" }] };
  }

  return result;
}

(
  [
    "unknown evidence",
    "unknown citation",
    "cross person",
    "missing person",
    "duplicate ref",
    "sensitive",
    "low confidence",
  ] as const
).forEach((scenario) => {
  void test(`combined output validates ${scenario} without another model call`, async () => {
    const input = fixture();
    const result = applyCombinedValidationScenario({ result: output(input), scenario });
    const calls = createCallCounter();
    const run = () =>
      generateMeetingMemory({
        input,
        runner: {
          async run<T>(runInput: MemoryModelRunInput<T>) {
            calls.count += 1;

            return { value: runInput.schema.parse(result), model: "fixture" };
          },
        },
      });
    if (scenario === "sensitive" || scenario === "low confidence") {
      const generated = await run();
      assert.deepEqual(generated.value.memories, []);
      assert.deepEqual(firstGeneratedPerson(generated.value).summary, []);
    } else {
      await assert.rejects(run);
    }
    assert.equal(calls.count, 1);
  });
});

void test("oversized complete input is rejected before any paid call", async (t) => {
  const original = { model: assistantEnv().OPENAI_MEMORY_MODEL, key: assistantEnv().AI_GATEWAY_API_KEY };
  assistantEnv().OPENAI_MEMORY_MODEL = "gpt-5.6-sol";
  assistantEnv().AI_GATEWAY_API_KEY = "fixture";
  t.after(() => {
    assistantEnv().OPENAI_MEMORY_MODEL = original.model;
    assistantEnv().AI_GATEWAY_API_KEY = original.key;
  });
  t.mock.method(globalThis, "fetch", () => {
    throw new Error(MEMORY_GENERATION_TEST_MESSAGES.mustNotContactProvider);
  });
  await assert.rejects(
    () =>
      createMemoryModelRunner({
        authorization: {
          jobId: "job",
          leaseToken: "lease",
          ownerUserId: "owner",
          meetingId: "fixture",
        },
      }).run({
        prompt: MEMORY_GENERATION_TEST_MESSAGES.fixtureOversizedPrompt,
        payload: { text: "a".repeat(MEMORY_GENERATION_TEST_OVERSIZED_INPUT_CHARS) },
        schema: memoryFixtureSuccessSchema,
        name: "relationship_meeting",
        meetingId: null,
      }),
    MEMORY_GENERATION_TEST_MESSAGES.singleCallContextBudget,
  );
});

function applyRejectedScenario(input: { result: MemoryGenerationOutput; scenario: string }): MemoryGenerationOutput {
  const { result, scenario } = input;
  const memory = firstGeneratedMemory(result);
  const person = firstGeneratedPerson(result);
  const summary = firstGeneratedSummary(result);
  const evidence = firstGeneratedEvidence(result);

  if (scenario === "malformed new reference") {
    return { ...result, memories: [{ ...memory, ref: "private-invalid-ref" }] };
  }
  if (scenario === "invented existing fact") {
    return { ...result, memories: [{ ...memory, existingFactKey: "invented" }] };
  }
  if (scenario === "missing person") {
    return { ...result, people: [] };
  }
  if (scenario === "unknown evidence") {
    return { ...result, memories: [{ ...memory, evidence: [{ ...evidence, segmentId: "S999" }] }] };
  }
  if (scenario === "unknown citation") {
    return {
      ...result,
      people: [{ ...person, summary: [{ ...summary, memoryRefs: ["H999"] }] }],
    };
  }
  if (scenario === "unfinished summary") {
    return {
      ...result,
      people: [
        { ...person, summary: [{ ...summary, text: MEMORY_GENERATION_TEST_MESSAGES.privateUnfinishedSummary }] },
      ],
    };
  }

  return result;
}

(
  [
    ["malformed new reference", "response_schema"],
    ["missing person", "response_schema"],
    ["invented existing fact", "response_schema"],
    ["unknown evidence", "invalid_segment_reference"],
    ["unknown citation", "unknown_memory_reference"],
    ["unfinished summary", "incomplete_summary"],
  ] as const
).forEach(([scenario, code]) => {
  void test(`rejected ${scenario} preserves the exact failure code without a repair call`, async () => {
    const input = fixture();
    const result = applyRejectedScenario({ result: output(input), scenario });
    const calls = createCallCounter();
    await assert.rejects(
      () =>
        generateMeetingMemory({
          input,
          runner: {
            async run<T>(runInput: MemoryModelRunInput<T>) {
              calls.count += 1;

              return { value: runInput.schema.parse(result), model: "fixture" };
            },
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof MemoryGenerationRejected);
        assert.equal(memoryFailureDiagnostic(error).code, code);
        assert.equal(JSON.stringify(memoryFailureDiagnostic(error)).includes("private"), false);

        return true;
      },
    );
    assert.equal(calls.count, 1);
  });
});

void test("real assistant route preserves exhausted-credit codes without SDK retries or private messages", async (t) => {
  const oldKey = assistantEnv().AI_GATEWAY_API_KEY;
  assistantEnv().AI_GATEWAY_API_KEY = "fixture";
  t.after(() => {
    assistantEnv().AI_GATEWAY_API_KEY = oldKey;
  });
  const calls = createCallCounter();
  t.mock.method(globalThis, "fetch", async () => {
    calls.count += 1;

    return new Response(
      JSON.stringify({
        error: {
          code: MEMORY_GENERATION_TEST_MESSAGES.creditBalanceExhausted,
          type: MEMORY_GENERATION_TEST_MESSAGES.insufficientQuota,
          message: MEMORY_GENERATION_TEST_MESSAGES.privateProviderMessage,
        },
      }),
      {
        status: MEMORY_GENERATION_TEST_HTTP_STATUS_TOO_MANY_REQUESTS,
        headers: { "content-type": "application/json" },
      },
    );
  });
  const app = Fastify();
  t.mock.method(repositories(), "consumeMemoryGeneration", async () => undefined);
  await app.register(internalRoutes);
  t.after(() => app.close());
  const input = fixture();
  const route = "generate";
  const payload = { ...input, jobId: randomUUID(), leaseToken: randomUUID() };
  const before = calls.count;
  const response = await app.inject({
    method: "POST",
    url: `/internal/memory/${route}`,
    headers: { "x-assistant-service-secret": assistantEnv().ASSISTANT_SERVICE_SECRET },
    payload,
  });
  assert.equal(response.statusCode, MEMORY_GENERATION_TEST_HTTP_STATUS_SERVICE_UNAVAILABLE);
  assert.deepEqual(
    memoryRouteInjectErrorBodySchema.parse(response.json()).diagnostic,
    memoryRouteProviderErrorDiagnosticSchema.parse({
      code: MEMORY_GENERATION_TEST_MESSAGES.providerErrorCode,
      stage: MEMORY_GENERATION_TEST_MESSAGES.providerStageModel,
      httpStatus: MEMORY_GENERATION_TEST_HTTP_STATUS_TOO_MANY_REQUESTS,
      providerCode: MEMORY_GENERATION_TEST_MESSAGES.creditBalanceExhausted,
    }),
  );
  assert.equal(response.body.includes(MEMORY_GENERATION_TEST_MESSAGES.privateProviderMessage), false);
  assert.equal(calls.count, before + 1);
});

void test("real assistant route and SDK return privacy-safe diagnostics for rejected output", async (t) => {
  const oldKey = assistantEnv().AI_GATEWAY_API_KEY;
  assistantEnv().AI_GATEWAY_API_KEY = "fixture";
  t.after(() => {
    assistantEnv().AI_GATEWAY_API_KEY = oldKey;
  });
  const input = fixture();
  const result = {
    ...output(input),
    memories: [{ ...firstGeneratedMemory(output(input)), ref: MEMORY_GENERATION_TEST_MESSAGES.rejectedMemoryRef }],
  };
  const calls = createCallCounter();
  t.mock.method(globalThis, "fetch", async () => {
    calls.count += 1;

    return new Response(JSON.stringify(gatewayTextResponse(JSON.stringify(result))), {
      headers: { "content-type": "application/json" },
    });
  });
  const logState = { lines: [] as string[] };
  const app = Fastify({
    logger: {
      stream: {
        write(line: string) {
          logState.lines = [...logState.lines, line];
        },
      },
    },
  });
  t.mock.method(repositories(), "consumeMemoryGeneration", async () => undefined);
  await app.register(internalRoutes);
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/internal/memory/generate",
    headers: { "x-assistant-service-secret": assistantEnv().ASSISTANT_SERVICE_SECRET },
    payload: { ...input, jobId: randomUUID(), leaseToken: randomUUID() },
  });
  assert.equal(response.statusCode, MEMORY_GENERATION_TEST_HTTP_STATUS_UNPROCESSABLE);
  const diagnostic = memoryRouteValidationBodySchema.parse(response.json()).diagnostic;
  assert.deepEqual(diagnostic, {
    code: MEMORY_GENERATION_TEST_MESSAGES.responseSchemaCode,
    stage: MEMORY_GENERATION_TEST_MESSAGES.providerStageModel,
    issues: [{ code: MEMORY_GENERATION_TEST_MESSAGES.invalidStringCode, path: ["memories", 0, "ref"] }],
  });
  assert.ok(
    logState.lines.some(
      (line) =>
        memoryGenerationLogLineSchema.parse(JSON.parse(line)).diagnostic?.code ===
        MEMORY_GENERATION_TEST_MESSAGES.responseSchemaCode,
    ),
  );
  const privateTexts = [
    MEMORY_GENERATION_TEST_MESSAGES.rejectedMemoryRef,
    firstFixtureSegment(input).content,
    firstGeneratedMemory(result).title,
  ];
  privateTexts.forEach((privateText) => {
    assert.equal(response.body.includes(privateText), false);
    assert.equal(logState.lines.join("").includes(privateText), false);
  });
  assert.equal(calls.count, 1);
});
