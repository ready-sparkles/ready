/**
 * GPT-5.6+ defaults to paid automatic cache writes. Explicit mode without any
 * prompt_cache_breakpoint disables both reads and writes for one-shot requests.
 * Older GPT models keep the prompt cache in memory instead of the 24 hour default.
 * gpt-5.5 rejects in-memory retention. Models outside this GPT range omit both controls.
 * https://developers.openai.com/api/docs/guides/prompt-caching
 */
const EXPLICIT_PROMPT_CACHE_MAJOR_VERSION = 5;
const EXPLICIT_PROMPT_CACHE_MINOR_VERSION = 6;
const IN_MEMORY_PROMPT_CACHE_RETENTION = "in_memory" as const;

export function openAIPromptCacheOptions(model: string): {
  prompt_cache_options?: { mode: "explicit" };
  prompt_cache_retention?: typeof IN_MEMORY_PROMPT_CACHE_RETENTION;
} {
  const generation = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/.exec(model);
  if (!generation) {
    return {};
  }
  const major = Number(generation[1]);
  const minor = Number(generation[2] ?? 0);
  if (
    major > EXPLICIT_PROMPT_CACHE_MAJOR_VERSION ||
    (major === EXPLICIT_PROMPT_CACHE_MAJOR_VERSION && minor >= EXPLICIT_PROMPT_CACHE_MINOR_VERSION)
  ) {
    return { prompt_cache_options: { mode: "explicit" } };
  }
  if (/^gpt-5\.5(?:-pro)?(?:-|$)/.test(model)) {
    return {};
  }

  return { prompt_cache_retention: IN_MEMORY_PROMPT_CACHE_RETENTION };
}
