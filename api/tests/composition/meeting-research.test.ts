import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeParallelWebSearchResponse } from "../../application/agent-tool-broker";
import { buildResearchPaper, normalizeSourceResults } from "../../application/meeting-research";

const PARALLEL_SEARCH_LIMIT = 12;
const MAX_SOURCE_EXCERPT_LENGTH = 900;
const ENTITY_FALLBACK_CASES = [false, true] as const;

ENTITY_FALLBACK_CASES.forEach((isEntityFallback) => {
  void test(`shared search cleaning retains short facts in post-meeting research (entity fallback: ${isEntityFallback})`, () => {
    const result = sanitizeParallelWebSearchResponse({
      query: "Pro pricing",
      limit: PARALLEL_SEARCH_LIMIT,
      response: {
        results: [
          {
            title: "Official pricing",
            url: "https://example.com/pricing",
            excerpts: [
              "Current pricing for individuals and business subscriptions.\n| Pro | $25 monthly |\nLaunch: May 5\nSkip to main content",
            ],
          },
        ],
      },
    });
    assert.equal(result.results[0]?.evidenceExcerpts, undefined);
    const sources = normalizeSourceResults(result);
    assert.ok(sources.every((source) => source.excerpt.length <= MAX_SOURCE_EXCERPT_LENGTH));
    const paper = buildResearchPaper({
      runId: "test-run",
      query: "Pro pricing",
      sources,
      entityResults: isEntityFallback ? [{ name: "Pro", url: "https://example.com", description: "A team plan." }] : [],
      generatedAt: "2026-09-24T00:00:00Z",
    });
    assert.match(paper.markdown, /\$25 monthly/);
    assert.match(paper.markdown, /May 5/);
    assert.doesNotMatch(paper.markdown, /Skip to main content/);
  });
});
