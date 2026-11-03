import "../composition/wire";
import "../adapters/secondary/node/env";

import assert from "node:assert/strict";
import test from "node:test";

import { createOpenAIClient as createRealOpenAIClient } from "../adapters/secondary/openai/client";
import { runMeetingSnapshot } from "../application/extraction-snapshot";
import { runMeetingTaskChunkExtraction } from "../application/extraction-tasks";
import { assistantEnv } from "../ports/assistant-env";
import { configureOpenAIClient, type OpenAIModelResponse } from "../ports/openai-client";

import { mockAssistantUsageMetering } from "./usage-metering-fixture";

const CACHE_WRITE_OPT_OUT_MODELS = ["gpt-5.6-sol", "gpt-5.4-mini"] as const;
const FIXTURE_INPUT_TOKENS = 100;
const FIXTURE_OUTPUT_TOKENS = 50;
const EXPECTED_OPENAI_REQUEST_COUNT = 2;

CACHE_WRITE_OPT_OUT_MODELS.forEach((model) => {
  void test(`notes and final tasks opt out of cache writes: ${model}`, async (t) => {
    mockAssistantUsageMetering(t);
    const previousKey = assistantEnv().AI_GATEWAY_API_KEY;
    assistantEnv().AI_GATEWAY_API_KEY = "test-not-a-real-key";
    t.after(() => {
      assistantEnv().AI_GATEWAY_API_KEY = previousKey;
    });
    const captureState = { requests: [] as Record<string, unknown>[] };
    configureOpenAIClient({
      createOpenAIClient: () => ({
        responses: {
          async create(body): Promise<OpenAIModelResponse> {
            captureState.requests = [...captureState.requests, body];

            return {
              totalUsage: {
                inputTokens: FIXTURE_INPUT_TOKENS,
                outputTokens: FIXTURE_OUTPUT_TOKENS,
                cachedInputTokens: 0,
              },
              status: "completed",
              output: [],
              output_text: JSON.stringify({
                title: "Launch planning",
                summary: "Overview\n- Personbr reviewed the launch.",
                actionItems: [],
                taskCandidates: [],
                tasks: [],
                operations: [],
              }),
            };
          },
        },
      }),
    });
    t.after(() => {
      configureOpenAIClient({ createOpenAIClient: createRealOpenAIClient });
    });
    const meetingId = "11111111-1111-4111-8111-111111111111";
    await runMeetingTaskChunkExtraction({
      input: {
        meetingId,
        title: "Launch",
        participants: [],
        chunkIndex: 0,
        totalChunks: 1,
        taskHintScore: 0,
        transcriptText: "Personbr: The launch is on Friday.",
      },
      model,
    });
    await runMeetingSnapshot({
      input: { meetingId, transcript: [], metadata: { title: "Launch" } },
      model,
    });
    assert.equal(captureState.requests.length, EXPECTED_OPENAI_REQUEST_COUNT);
    assert.deepEqual(
      captureState.requests.map((request) => request.prompt_cache_options),
      model === "gpt-5.6-sol" ? [{ mode: "explicit" }, { mode: "explicit" }] : [undefined, undefined],
    );
    assert.deepEqual(
      captureState.requests.map((request) => request.prompt_cache_retention),
      model === "gpt-5.4-mini" ? ["in_memory", "in_memory"] : [undefined, undefined],
    );
    assert.equal(JSON.stringify(captureState.requests).includes("prompt_cache_breakpoint"), false);
  });
});
