/* eslint-disable @typescript-eslint/no-magic-numbers -- Fixed token and allowance fixtures. */
import "../../composition/wire";

import assert from "node:assert/strict";
import test from "node:test";

import { assistantEnvSchema, configureAssistantEnv } from "../../ports/assistant-env";
import { openAIClientApiKey } from "../../ports/openai-client";

void test("counted assistant callers select the direct OpenAI credential, never the Gateway credential", () => {
  const env = assistantEnvSchema.parse({
    DATABASE_URL: "postgres://localhost/unused",
    ASSISTANT_SERVICE_SECRET: "fixture",
    AI_GATEWAY_API_KEY: "gateway-fixture",
    OPENAI_API_KEY: "openai-fixture",
  });
  configureAssistantEnv(env);
  assert.equal(openAIClientApiKey(), env.AI_GATEWAY_API_KEY);
  configureAssistantEnv({ ...env, OPENAI_INPUT_TOKEN_COUNT_BILLING: "free" });
  assert.equal(openAIClientApiKey(), env.OPENAI_API_KEY);
  configureAssistantEnv({ ...env, OPENAI_INPUT_TOKEN_COUNT_BILLING: "free", OPENAI_API_KEY: "" });
  assert.equal(openAIClientApiKey(), "");
});

void test("normal snapshot runner uses direct count credentials and preserves included Gateway traffic", async (t) => {
  const { createOpenAIClient: createRealClient } = await import("../../adapters/secondary/openai/client");
  const { configureOpenAIClient } = await import("../../ports/openai-client");
  const { runMeetingSnapshot } = await import("../../application/extraction-snapshot");
  const { assistantEnv } = await import("../../ports/assistant-env");
  const { mockAssistantUsageMetering, gatewayTextResponse } = await import("../usage-metering-fixture");
  const fixture = mockAssistantUsageMetering(t);
  const env = assistantEnv();
  configureAssistantEnv({
    ...env,
    OPENAI_INPUT_TOKEN_COUNT_BILLING: "free",
    OPENAI_API_KEY: "openai-fixture",
    AI_GATEWAY_API_KEY: "gateway-fixture",
  });
  const result = JSON.stringify({
    title: "Planning",
    summary: "Overview\n- Reviewed the plan.",
    actionItems: [],
    taskCandidates: [],
  });
  const capture: { requests: { url: string; authorization: string | null }[] } = { requests: [] };
  const inputTokens = 1000;
  const outputTokens = 20;
  configureOpenAIClient({
    createOpenAIClient: (options) =>
      createRealClient({
        ...options,
        fetch: (async (url, init) => {
          const address = url instanceof Request ? url.url : url.toString();
          capture.requests = [
            ...capture.requests,
            { url: address, authorization: new Headers(init?.headers).get("authorization") },
          ];
          if (address.endsWith("/input_tokens")) {
            return Response.json({ object: "response.input_tokens", input_tokens: inputTokens });
          }
          if (address.includes("ai-gateway")) {
            return Response.json(gatewayTextResponse(result));
          }

          return Response.json({
            id: "response",
            status: "completed",
            output: [
              {
                type: "message",
                id: "message",
                role: "assistant",
                content: [{ type: "output_text", text: result, annotations: [] }],
              },
            ],
            usage: { input_tokens: inputTokens, output_tokens: outputTokens },
          });
        }) satisfies typeof globalThis.fetch,
      }),
  });
  t.after(() => configureOpenAIClient({ createOpenAIClient: createRealClient }));
  const run = () =>
    runMeetingSnapshot({
      input: { meetingId: "11111111-1111-4111-8111-111111111111", transcript: [], metadata: { title: "Planning" } },
      model: "gpt-5.4-mini",
    });
  await run();
  assert.deepEqual(
    capture.requests.map((request) => request.authorization),
    ["Bearer openai-fixture", "Bearer openai-fixture"],
  );
  assert.equal(capture.requests[0]?.url, "https://api.openai.com/v1/responses/input_tokens");
  fixture.port.getWorkspaceById = async () => ({ plan: "free" });
  fixture.port.getWorkspaceMemberCreditAccess = async () => ({
    subscriptionActive: false,
    allowanceRemaining: 0,
    poolBalance: 0,
  });
  await run();
  assert.equal(capture.requests.at(-1)?.url, "https://ai-gateway.vercel.sh/v4/ai/language-model");
  assert.equal(capture.requests.at(-1)?.authorization, "Bearer gateway-fixture");
});

void test("default OpenAI-only configuration admits a short Pro snapshot within 250 credits", async (t) => {
  const { createOpenAIClient: createRealClient } = await import("../../adapters/secondary/openai/client");
  const { configureOpenAIClient } = await import("../../ports/openai-client");
  const { runMeetingSnapshot } = await import("../../application/extraction-snapshot");
  const { mockAssistantUsageMetering } = await import("../usage-metering-fixture");
  const fixture = mockAssistantUsageMetering(t);
  const env = assistantEnvSchema.parse({
    DATABASE_URL: "postgres://localhost/unused",
    ASSISTANT_SERVICE_SECRET: "fixture",
    OPENAI_API_KEY: "openai-fixture",
  });
  configureAssistantEnv(env);
  t.after(() => configureAssistantEnv(env));
  fixture.admission.mock.mockImplementation(async (input) => {
    // Pro retains 7% of the $0.10 credit value for provider spend.
    assert.ok(Number(input.maximumCostMicroUsd) <= 1_750_000, "short snapshot must fit the Pro allowance");

    return { id: "reservation" };
  });
  const fetch = t.mock.fn(async (url: Parameters<typeof globalThis.fetch>[0]) => {
    assert.equal(url instanceof Request ? url.url : url.toString(), "https://api.openai.com/v1/responses");

    return Response.json({
      id: "response",
      status: "completed",
      output: [
        {
          type: "message",
          id: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                title: "Planning",
                summary: "Overview\n- Reviewed the plan.",
                actionItems: [],
                taskCandidates: [],
              }),
              annotations: [],
            },
          ],
        },
      ],
      usage: { input_tokens: 100, output_tokens: 20 },
    });
  });
  configureOpenAIClient({ createOpenAIClient: (options) => createRealClient({ ...options, fetch }) });
  t.after(() => configureOpenAIClient({ createOpenAIClient: createRealClient }));
  const run = () =>
    runMeetingSnapshot({
      input: { meetingId: "11111111-1111-4111-8111-111111111111", transcript: [], metadata: { title: "Planning" } },
      model: env.OPENAI_MEETING_SNAPSHOT_MODEL,
    });
  await run();
  fixture.port.getWorkspaceById = async () => ({ plan: "free" });
  fixture.port.getWorkspaceMemberCreditAccess = async () => ({
    subscriptionActive: false,
    allowanceRemaining: 0,
    poolBalance: 0,
  });
  await run();
  assert.equal(fetch.mock.callCount(), 2);
});
