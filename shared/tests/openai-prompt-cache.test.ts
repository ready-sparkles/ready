import assert from "node:assert/strict";
import test from "node:test";

import { openAIPromptCacheOptions } from "../domain/openai-prompt-cache";

["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-luna-2026-09-01", "gpt-5.10", "gpt-6-astra"].forEach((model) => {
  void test(`${model}: one-shot requests disable cache writes`, () => {
    assert.deepEqual(openAIPromptCacheOptions(model), { prompt_cache_options: { mode: "explicit" } });
  });
});
["gpt-4.1", "gpt-5", "gpt-5.4-mini"].forEach((model) => {
  void test(`${model}: prompt cache stays in memory`, () => {
    assert.deepEqual(openAIPromptCacheOptions(model), { prompt_cache_retention: "in_memory" });
  });
});
["gpt-5.5", "gpt-5.5-pro", "o3", "gpt-live-1", "gpt-realtime", "custom-model"].forEach((model) => {
  void test(`${model}: unsupported controls are omitted`, () => {
    assert.deepEqual(openAIPromptCacheOptions(model), {});
  });
});
