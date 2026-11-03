import { executeOpenAIResponses, OpenAIRequestNotDispatchedError } from "@readymeet/openai-responses";
import {
  calculatePlanCredits,
  DEFAULT_OPENAI_MODEL_PRICES_JSON,
  maximumOpenAITextInputTokens,
  PLAN_CREDITS,
} from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

const SNAPSHOT_MODEL = "gpt-5.6-sol";
const SNAPSHOT_MAX_OUTPUT_TOKENS = 32_000;
const TRANSCRIPT_LINES = 800;
const WIRE_REACHED = "wire reached";
const SPEAKER_COUNT = 4;
const TOOL_MAX_OUTPUT_TOKENS = 2000;
const TOOL_TASK_COUNT = 60;

const line = (index: number) =>
  `Speaker ${String(index % SPEAKER_COUNT)}: "We ship step ${String(index)}" — naïve café ✓ 漢字 \\ C:\\path, then next.\n`;
const transcript = Array.from({ length: TRANSCRIPT_LINES }, (_, index) => line(index)).join("");

const snapshotBody = {
  model: SNAPSHOT_MODEL,
  max_output_tokens: SNAPSHOT_MAX_OUTPUT_TOKENS,
  reasoning: { effort: "medium" },
  text: { format: { type: "json_object" } },
  input: [
    { role: "system", content: 'Return a JSON object like {"overview": []}.' },
    { role: "user", content: transcript },
  ],
};
const toolBody = {
  model: "gpt-5.4-mini",
  max_output_tokens: TOOL_MAX_OUTPUT_TOKENS,
  tools: [
    {
      type: "function",
      name: "save_tasks",
      description: "Save tasks",
      parameters: {
        type: "object",
        properties: { tasks: { type: "array", items: { type: "string" } } },
        required: ["tasks"],
      },
    },
  ],
  input: [
    { role: "user", content: transcript },
    {
      type: "function_call",
      call_id: "call_1",
      name: "save_tasks",
      arguments: JSON.stringify({
        tasks: Array.from({ length: TOOL_TASK_COUNT }, (_, index) => `task "${String(index)}" \\ ✓`),
      }),
    },
    {
      type: "function_call_output",
      call_id: "call_1",
      output: JSON.stringify({ status: "saved", note: 'quoted "x"' }),
    },
  ],
};

async function dispatchesWithin(input: { body: object; isGateway: boolean }): Promise<boolean> {
  const wire = { isReached: false };
  const fetch: typeof globalThis.fetch = async () => {
    wire.isReached = true;
    throw new Error(WIRE_REACHED);
  };
  try {
    await executeOpenAIResponses({
      apiKey: "test-key",
      body: input.body,
      maxRetries: 0,
      fetch,
      billing: {
        userId: "user",
        workspaceId: "workspace",
        feature: "test",
        gatewayApiKey: input.isGateway ? "gateway-test-key" : "",
        maxInputTokens: maximumOpenAITextInputTokens(input.body),
      },
    });
  } catch (error) {
    if (error instanceof OpenAIRequestNotDispatchedError) {
      return false;
    }
  }

  return wire.isReached;
}

const cases = Object.entries({ snapshot: snapshotBody, tools: toolBody }).flatMap(([name, body]) =>
  [false, true].map((isGateway) => ({ name, body, isGateway })),
);
cases.forEach(({ name, body, isGateway }) => {
  void test(`the ${name} reservation bound admits the real ${isGateway ? "Gateway" : "OpenAI"} wire body`, async () => {
    assert.equal(await dispatchesWithin({ body, isGateway }), true);
  });
});

void test("a long Pro meeting snapshot reserves less than the monthly allowance", () => {
  const price = z
    .object({ inputPerMillion: z.number(), cacheWritePerMillion: z.number(), outputPerMillion: z.number() })
    .parse(z.record(z.unknown()).parse(JSON.parse(DEFAULT_OPENAI_MODEL_PRICES_JSON))[SNAPSHOT_MODEL]);
  const inputTokens = maximumOpenAITextInputTokens(snapshotBody);
  const bytes = new TextEncoder().encode(JSON.stringify(snapshotBody)).length;
  assert.ok(inputTokens >= bytes, "the bound never drops below the byte ceiling");
  // Same arithmetic as usage-metering's estimate: worst input tariff for every input token, plus the output cap.
  const inputRate = Math.max(price.inputPerMillion, price.cacheWritePerMillion);
  const maximumCostMicroUsd = Math.ceil(inputTokens * inputRate + SNAPSHOT_MAX_OUTPUT_TOKENS * price.outputPerMillion);
  const credits = calculatePlanCredits({ providerCostMicroUsd: maximumCostMicroUsd, plan: "pro", isIncluded: false });
  assert.ok(
    credits < PLAN_CREDITS.pro.monthlyAllowance,
    `snapshot of ${String(bytes)} bytes reserves ${String(credits)} credits`,
  );
});
