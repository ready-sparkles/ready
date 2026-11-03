import assert from "node:assert/strict";
import test from "node:test";

import {
  agentToolFailureDetails,
  buildLinearMcpCallCopy,
  buildLinearMcpIssueSearchArgs,
  buildLinearMcpListArgs,
  buildLinearPreparedActionCopy,
  buildLinearUpdateIssuePreparation,
  buildParallelEntityFallbackSearchRequest,
  buildParallelExtractRequest,
  buildParallelFindAllRequest,
  buildParallelKeywordSearchQueries,
  buildParallelWebSearchRequest,
  classifyParallelWebSearchQuery,
  linearMeetingAssetUploadArgsMatch,
  linearMeetingAssetUploadInvocationCanRetry,
  linearRelationArgsAreValid,
  linearRelationArgsMatch,
  linearRelationInvocationCanRetry,
  linearUpdateIssueArgsMatch,
  linearUpdateIssueInvocationCanRetry,
  requestedLinearContextTypes,
  sanitizeParallelFindAllResponse,
  sanitizeParallelWebSearchResponse,
  shouldFallbackFromFindAllToSearch,
  voiceWebResearchRunToPanelPayload,
} from "../../application/agent-tool-broker";
import { LinearFileUploadError } from "../../application/linear-client";

const LINEAR_QUESTION_VERB = "up" + "date";
const JUST_BEFORE_SIXTY_SECONDS_MS = 59_999;
const SIXTY_SECONDS_MS = 60_000;

const HTTP_STATUS_FORBIDDEN = 403;

const LINEAR_MCP_LIST_LIMIT = 5;

const PARALLEL_WEB_SEARCH_MAX_CHARS = 18_000;
const PARALLEL_WEB_MAX_AGE_SECONDS = 3_600;
const PARALLEL_EXTRACT_MAX_CHARS = 24_000;

const PARALLEL_SANITIZE_SEARCH_LIMIT = 2;

const PARALLEL_FINDALL_REQUEST_LIMIT = 8;

const FINDALL_SANITIZE_LIMIT = 4;
const FINDALL_METRICS_GENERATED = 4;
const FINDALL_METRICS_MATCHED = 2;

const FINDALL_ACTIVE_FALLBACK_LIMIT = 5;
const FINDALL_ACTIVE_GENERATED = 4;

const LINEAR_SAVE_ISSUE_PRIORITY_NORMAL = 2;

const LINEAR_BATCH_MIXED_CHANGE_COUNT = 2;

const LINEAR_MCP_ISSUE_SEARCH_DEFAULT = {
  limit: LINEAR_MCP_LIST_LIMIT,
  /** @external linear MCP issue search wire field */
  includeArchived: false,
  orderBy: "updatedAt",
};

const LINEAR_MCP_LIST_SEARCH_DEFAULT = {
  limit: LINEAR_MCP_LIST_LIMIT,
  /** @external linear MCP list wire field */
  includeArchived: false,
  orderBy: "updatedAt",
};

const AGENT_TOOL_BROKER_TEST_FAILURE_COPY = {
  linearFileUploadFailed: {
    code: "linear_file_upload_failed",
    message: "Linear file upload failed (403: SignatureDoesNotMatch)",
  },
  toolExecutionFailed: {
    code: "tool_execution_failed",
    message: "Request failed at [redacted URL]",
  },
};

const AGENT_TOOL_BROKER_TEST_ERROR_MESSAGES = {
  signedUrlRequestFailed: "Request failed at https://signed.example.test?secret=value",
  linearUploadSignatureMismatch: "SignatureDoesNotMatch",
};

const AGENT_TOOL_BROKER_TEST_GEMINI_COPY = {
  nhlPlayoffsAnswerLead:
    "As of May 15, 2026, Colorado, Vegas, Carolina, Buffalo, Montreal, Anaheim, Minnesota, and Philadelphia remain alive in the Stanley Cup Playoffs.",
  nhlPlayoffsSupportedClaim:
    "Colorado, Vegas, Carolina, Buffalo, Montreal, Anaheim, Minnesota, and Philadelphia remain alive in the Stanley Cup Playoffs.",
  unsupportedAnswer: "A confident-looking but unsupported answer.",
  coloradoAvalanche: "Colorado Avalanche (advanced to conference finals)",
  vegasGoldenKnights: "Vegas Golden Knights (advanced to conference finals)",
  anaheimDucks: "Anaheim Ducks (playing in second round)",
  minnesotaWild: "Minnesota Wild (playing in second round)",
  carolinaHurricanes: "Carolina Hurricanes (advanced to conference finals)",
  buffaloSabres: "Buffalo Sabres (playing in second round)",
  montrealCanadiens: "Montreal Canadiens (playing in second round)",
  philadelphiaFlyers: "Philadelphia Flyers (playing in second round)",
  openAiDuplicateProductClaim: "OpenAI OpenAI builds AI products.",
};

const PARALLEL_FINDALL_MATCH_CONDITION_NAMES = ["direct_match_check", "public_professional_context_check"];

const readParallelFindAllMatchConditionName = (condition: unknown): string | null => {
  if (condition === null || typeof condition !== "object") {
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(condition, "name")) {
    return null;
  }
  const name: unknown = Reflect.get(condition, "name");

  return typeof name === "string" ? name : null;
};

void test("Linear issue revision preparation accepts a description without requiring a title", () => {
  const prepared = buildLinearUpdateIssuePreparation({
    args: {
      issueId: "REA-2491",
      description: "Meeting context",
    },
  });

  assert.deepEqual(prepared.preview, {
    issueId: "REA-2491",
    description: "Meeting context",
  });
  assert.equal(prepared.copy.question, `Should I ${LINEAR_QUESTION_VERB} REA-2491 in Linear?`);
});

void test("Linear relation validation requires a deterministic relation ID", () => {
  const valid = {
    id: "relation-1",
    issueId: "issue-created",
    relatedIssueId: "issue-canonical",
    type: "duplicate",
  };
  assert.equal(linearRelationArgsAreValid(valid), true);
  assert.equal(linearRelationArgsAreValid({ ...valid, id: "" }), false);
  assert.equal(linearRelationArgsAreValid({ ...valid, id: undefined }), false);
});

void test("failed or stale Linear relation invocations can retry with the same durable call", () => {
  const createdAt = new Date("2026-08-05T12:00:00.000Z");
  assert.equal(
    linearRelationInvocationCanRetry({
      toolName: "linear.create_issue_relation",
      status: "failed",
      createdAt,
      nowMs: createdAt.getTime(),
    }),
    true,
  );
  assert.equal(
    linearRelationInvocationCanRetry({
      toolName: "linear.create_issue_relation",
      status: "running",
      createdAt,
      nowMs: createdAt.getTime() + JUST_BEFORE_SIXTY_SECONDS_MS,
    }),
    false,
  );
  assert.equal(
    linearRelationInvocationCanRetry({
      toolName: "linear.create_issue_relation",
      status: "running",
      createdAt,
      nowMs: createdAt.getTime() + SIXTY_SECONDS_MS,
    }),
    true,
  );
});

void test("Linear relation retries require the original deterministic relation arguments", () => {
  const original = {
    id: "relation-1",
    issueId: "issue-created",
    relatedIssueId: "issue-canonical",
    type: "duplicate",
  };
  assert.equal(linearRelationArgsMatch({ first: original, second: { ...original } }), true);
  assert.equal(
    linearRelationArgsMatch({
      first: original,
      second: {
        ...original,
        relatedIssueId: "different-canonical",
      },
    }),
    false,
  );
});

void test("failed or stale Linear asset uploads can retry only with the same asset", () => {
  const confirmedAt = new Date("2026-08-05T12:00:00.000Z");
  const invocation = {
    toolName: "linear.upload_meeting_asset",
    status: "running",
    createdAt: new Date("2026-08-05T11:00:00.000Z"),
    confirmedAt,
  };
  assert.equal(
    linearMeetingAssetUploadInvocationCanRetry({
      state: invocation,
      nowMs: confirmedAt.getTime() + JUST_BEFORE_SIXTY_SECONDS_MS,
    }),
    false,
  );
  assert.equal(
    linearMeetingAssetUploadInvocationCanRetry({ state: invocation, nowMs: confirmedAt.getTime() + SIXTY_SECONDS_MS }),
    true,
  );
  assert.equal(linearMeetingAssetUploadInvocationCanRetry({ state: { ...invocation, status: "failed" } }), true);
  assert.equal(
    linearMeetingAssetUploadArgsMatch({ storedPreview: { assetId: "asset-1" }, args: { assetId: "asset-1" } }),
    true,
  );
  assert.equal(
    linearMeetingAssetUploadArgsMatch({ storedPreview: { assetId: "asset-1" }, args: { assetId: "asset-2" } }),
    false,
  );
});

void test("failed deterministic Linear issue updates can retry only with identical content", () => {
  const invocation = {
    toolName: "linear.update_issue",
    status: "failed",
    createdAt: new Date("2026-08-05T12:00:00.000Z"),
    confirmedAt: new Date("2026-08-05T12:00:01.000Z"),
  };
  assert.equal(linearUpdateIssueInvocationCanRetry({ state: invocation }), true);
  assert.equal(
    linearUpdateIssueArgsMatch({
      storedPreview: { issueId: "REA-1", description: "Grounded meeting context" },
      args: { issueId: "REA-1", description: "Grounded meeting context" },
    }),
    true,
  );
  assert.equal(
    linearUpdateIssueArgsMatch({
      storedPreview: { issueId: "REA-1", description: "Grounded meeting context" },
      args: { issueId: "REA-1", description: "Different content" },
    }),
    false,
  );
});

void test("tool failures preserve safe provider details for production diagnosis", () => {
  assert.deepEqual(
    agentToolFailureDetails(
      new LinearFileUploadError(
        HTTP_STATUS_FORBIDDEN,
        AGENT_TOOL_BROKER_TEST_ERROR_MESSAGES.linearUploadSignatureMismatch,
      ),
    ),
    AGENT_TOOL_BROKER_TEST_FAILURE_COPY.linearFileUploadFailed,
  );
  assert.deepEqual(
    agentToolFailureDetails(new Error(AGENT_TOOL_BROKER_TEST_ERROR_MESSAGES.signedUrlRequestFailed)),
    AGENT_TOOL_BROKER_TEST_FAILURE_COPY.toolExecutionFailed,
  );
});

void test("Linear MCP issue search maps assigned-to-me language to assignee filter", () => {
  assert.deepEqual(buildLinearMcpIssueSearchArgs("Can you check what Linear issues are assigned to me?"), {
    ...LINEAR_MCP_ISSUE_SEARCH_DEFAULT,
    assignee: "me",
  });
});

void test("Linear MCP issue search maps assignee shorthand to assignee filter", () => {
  assert.deepEqual(buildLinearMcpIssueSearchArgs("assignee:me"), {
    ...LINEAR_MCP_ISSUE_SEARCH_DEFAULT,
    assignee: "me",
  });
});

void test("Linear MCP issue search maps triage language to state filter", () => {
  assert.deepEqual(buildLinearMcpIssueSearchArgs("Just like what's in triage right now."), {
    ...LINEAR_MCP_ISSUE_SEARCH_DEFAULT,
    state: "Triage",
  });
});

void test("Linear MCP issue search keeps the useful query topic", () => {
  assert.deepEqual(buildLinearMcpIssueSearchArgs("Can you run a search in Linear for tickets related to Safari?"), {
    ...LINEAR_MCP_ISSUE_SEARCH_DEFAULT,
    query: "Safari",
  });
});

void test("Linear MCP project search strips broad object and owner wording", () => {
  assert.deepEqual(
    buildLinearMcpListArgs({
      term: "projects and initiatives assigned to Personqc Personqd",
      type: "project",
      limit: LINEAR_MCP_LIST_LIMIT,
      /** @external linear MCP list wire field */
      shouldIncludeArchived: false,
    }),
    LINEAR_MCP_LIST_SEARCH_DEFAULT,
  );
});

void test("Linear MCP initiative search keeps the useful topic from meeting language", () => {
  assert.deepEqual(
    buildLinearMcpListArgs({
      term: "What initiative is Safari work part of?",
      type: "initiative",
      limit: LINEAR_MCP_LIST_LIMIT,
      /** @external linear MCP list wire field */
      shouldIncludeArchived: false,
    }),
    {
      ...LINEAR_MCP_LIST_SEARCH_DEFAULT,
      query: "Safari",
      /** @external linear MCP initiative wire field */
      includeProjects: true,
    },
  );
});

void test("Linear context search picks projects and initiatives for roadmap language", () => {
  assert.deepEqual(
    requestedLinearContextTypes({
      args: {},
      term: "What project or initiative is this Safari work part of?",
    }),
    ["project", "initiative", "issue", "document"],
  );
});

void test("Linear context search picks documents for planning language", () => {
  assert.deepEqual(
    requestedLinearContextTypes({ args: {}, term: "Find the spec or prior decision about onboarding" }),
    ["document", "issue", "project", "initiative"],
  );
});

void test("Linear context search honors explicit object types", () => {
  assert.deepEqual(requestedLinearContextTypes({ args: { objectTypes: ["initiative", "document"] }, term: "Safari" }), [
    "initiative",
    "document",
  ]);
});

void test("Linear context search treats empty list-style queries as broad context lookup", () => {
  assert.deepEqual(requestedLinearContextTypes({ args: {}, term: "" }), ["issue", "project", "initiative", "document"]);
});

void test("Parallel web search request builds a tuned Search payload for foreground voice", () => {
  assert.deepEqual(buildParallelWebSearchRequest({ query: "latest LiveKit Agents tool docs" }), {
    objective:
      "Find current public web information that directly answers this live meeting question: latest LiveKit Agents tool docs. " +
      "Prefer authoritative, primary, and reputable sources. Return concise, citation-aware excerpts that can directly support a short spoken answer and a source panel.",
    search_queries: [
      "latest livekit agents tool docs",
      "livekit agents tool docs latest",
      "livekit agents tool docs official",
    ],
    mode: "turbo",
    max_chars_total: PARALLEL_WEB_SEARCH_MAX_CHARS,
    client_model: "gpt-4o-mini",
    advanced_settings: {
      fetch_policy: {
        max_age_seconds: PARALLEL_WEB_MAX_AGE_SECONDS,
      },
    },
  });
});

void test("Parallel web search request sharpens sports playoff status lookups", () => {
  const request = buildParallelWebSearchRequest({ query: "NHL playoffs teams remaining May 2026" });

  assert.equal(request.mode, "turbo");
  assert.deepEqual(request.search_queries, [
    "nhl 2026 playoff bracket",
    "nhl 2026 teams remaining",
    "nhl playoff series status",
  ]);
  assert.ok(typeof request.objective === "string");
  assert.match(request.objective, /exact remaining teams/);
});

void test("Parallel extract request carries shared session id for verification", () => {
  assert.deepEqual(
    buildParallelExtractRequest({
      query: "verify NHL teams remaining in the playoffs",
      urls: ["https://www.nhl.com/playoffs", "https://www.espn.com/nhl/"],
      sessionId: "session-voice-1",
    }),
    {
      urls: ["https://www.nhl.com/playoffs", "https://www.espn.com/nhl/"],
      objective:
        "Read these pages to verify and directly answer this live meeting question: verify NHL teams remaining in the playoffs. " +
        "Extract only relevant, citation-ready excerpts that support or contradict the answer.",
      search_queries: ["nhl playoff bracket", "nhl teams remaining", "nhl playoff series status"],
      max_chars_total: PARALLEL_EXTRACT_MAX_CHARS,
      session_id: "session-voice-1",
      client_model: "gpt-4o-mini",
      advanced_settings: {
        fetch_policy: {
          max_age_seconds: PARALLEL_WEB_MAX_AGE_SECONDS,
        },
      },
    },
  );
});

void test("Parallel keyword search query generation returns concise diverse queries", () => {
  assert.deepEqual(
    buildParallelKeywordSearchQueries("Can you look up the latest price and availability for Vision Pro?"),
    [
      "latest price availability vision pro",
      "price availability vision pro latest",
      "price availability vision pro official",
    ],
  );
});

void test("Parallel web search routing chooses FindAll for entities and Search for source lookups", () => {
  assert.deepEqual(classifyParallelWebSearchQuery("top AI companies in Bay Area 2026 detailed list"), {
    mode: "entity_discovery",
    entityType: "company",
    reason: "entity_discovery",
  });
  assert.deepEqual(classifyParallelWebSearchQuery("search for Personqy Public"), {
    mode: "entity_discovery",
    entityType: "person",
    reason: "person_lookup",
  });
  assert.deepEqual(classifyParallelWebSearchQuery("latest news about OpenAI"), {
    mode: "fast_grounded",
    entityType: "other",
    reason: "source_lookup",
  });
  assert.deepEqual(classifyParallelWebSearchQuery("what NHL teams are still in the playoffs"), {
    mode: "verified_answer",
    entityType: "other",
    reason: "verified_answer",
  });
});

void test("Parallel web search routing limits private person information requests", () => {
  assert.deepEqual(classifyParallelWebSearchQuery("find Personqy Public home address"), {
    mode: "blocked",
    entityType: "person",
    reason: "private_person_information",
  });
});

void test("Parallel FindAll request uses public professional constraints", () => {
  const request = buildParallelFindAllRequest({
    query: "search for Personqy Public",
    entityType: "person",
    limit: PARALLEL_FINDALL_REQUEST_LIMIT,
  });

  assert.equal(request.entity_type, "people");
  assert.equal(request.generator, "core");
  assert.equal(request.match_limit, PARALLEL_FINDALL_REQUEST_LIMIT);
  assert.deepEqual(request.metadata, {});
  assert.ok(typeof request.objective === "string");
  assert.match(request.objective, /public professional information/);
  const matchConditions = request.match_conditions;
  assert.ok(Array.isArray(matchConditions));
  const matchConditionNames = matchConditions.flatMap((condition) => {
    const name = readParallelFindAllMatchConditionName(condition);

    return name === null ? [] : [name];
  });
  assert.deepEqual(matchConditionNames, PARALLEL_FINDALL_MATCH_CONDITION_NAMES);
});

void test("Parallel entity fallback search request avoids stuck empty FindAll panels", () => {
  assert.deepEqual(
    buildParallelEntityFallbackSearchRequest({
      query: "top 5 AI companies in the Bay Area 2026",
      entityType: "company",
    }),
    {
      objective:
        "Find public web sources that identify specific companies matching this live meeting request: top 5 AI companies in the Bay Area 2026. " +
        "Prefer authoritative lists, official pages, and reputable sources. Avoid navigation pages and job listing pages.",
      search_queries: ["top 5 ai companies bay 2026", "top 5 ai companies bay area", "top 5 ai companies bay latest"],
      mode: "turbo",
      max_chars_total: PARALLEL_WEB_SEARCH_MAX_CHARS,
      client_model: "gpt-4o-mini",
      advanced_settings: {
        fetch_policy: {
          max_age_seconds: PARALLEL_WEB_MAX_AGE_SECONDS,
        },
      },
    },
  );
});

void test("Parallel web search response is sanitized for voice and panel use", () => {
  const sanitized = sanitizeParallelWebSearchResponse({
    query: "latest LiveKit Agents tool docs",
    limit: PARALLEL_SANITIZE_SEARCH_LIMIT,
    response: {
      search_id: "search-1",
      session_id: "session-1",
      results: [
        {
          title: " LiveKit tools ",
          url: "https://docs.livekit.io/agents/logic/tools/",
          publish_date: "2026-05-14",
          excerpts: ["  Tools can call RPC.  "],
        },
        {
          title: "Unsafe",
          url: "javascript:alert(1)",
          publish_date: null,
          excerpts: ["bad"],
        },
        {
          title: "Forwarding",
          url: "https://docs.livekit.io/agents/logic/tools/forwarding/",
          publish_date: null,
          excerpts: ["Forward tool calls to a frontend app."],
        },
      ],
    },
  });

  assert.equal(sanitized.provider, "web_search");
  assert.equal(sanitized.backend, "parallel");
  assert.equal(sanitized.mode, "search");
  assert.equal(sanitized.status, "completed");
  assert.equal(sanitized.searchId, "search-1");
  assert.equal(sanitized.answer, null);
  assert.equal(sanitized.answerStatus, "not_requested");
  assert.deepEqual(sanitized.results, [
    {
      kind: "source",
      title: "LiveKit tools",
      url: "https://docs.livekit.io/agents/logic/tools/",
      publishDate: "2026-05-14",
      domain: "docs.livekit.io",
      excerpt: "Tools can call RPC.",
    },
    {
      kind: "source",
      title: "Forwarding",
      url: "https://docs.livekit.io/agents/logic/tools/forwarding/",
      publishDate: null,
      domain: "docs.livekit.io",
      excerpt: "Forward tool calls to a frontend app.",
    },
  ]);
});

void test("persisted web research keeps its lifecycle search ID ahead of the provider ID", () => {
  const timestamp = new Date("2026-08-26T20:17:47.000Z");
  const payload = voiceWebResearchRunToPanelPayload({
    id: "550e8400-e29b-41d4-a716-446655440001",
    meetingId: "550e8400-e29b-41d4-a716-446655440002",
    userId: "550e8400-e29b-41d4-a716-446655440003",
    agentProfileId: "550e8400-e29b-41d4-a716-446655440004",
    utteranceId: "utterance-1",
    query: "weather in San Francisco",
    queryKey: "weather in san francisco",
    status: "completed",
    researchMode: "turbo_search",
    sessionId: "session-1",
    searchId: "utterance-1",
    findallId: null,
    taskgroupId: null,
    runRefs: { provider: "parallel_search", searchId: "provider-search-1" },
    progress: {},
    result: {
      status: "completed",
      searchId: "provider-search-1",
      results: [],
    },
    error: null,
    cancelledAt: null,
    expiresAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  assert.equal(payload.searchId, "utterance-1");
  assert.ok(typeof payload.runRefs === "object" && payload.runRefs !== null && "searchId" in payload.runRefs);
  assert.equal(payload.runRefs.searchId, "provider-search-1");
});

void test("stored Gemini results still expose their answer and citations in the research panel", () => {
  const timestamp = new Date("2026-08-26T20:17:47.000Z");
  const citation = { id: "c1", title: "Saved source", url: "https://example.com/source" };
  const storedResult = {
    backend: "gemini_grounding",
    answer: {
      summary: AGENT_TOOL_BROKER_TEST_GEMINI_COPY.nhlPlayoffsAnswerLead,
      facts: [{ text: AGENT_TOOL_BROKER_TEST_GEMINI_COPY.nhlPlayoffsSupportedClaim, citations: [citation] }],
    },
    answerDisplay: {
      lead: AGENT_TOOL_BROKER_TEST_GEMINI_COPY.nhlPlayoffsAnswerLead,
      sections: [],
      citations: [citation],
    },
    googleSearchQueries: ["saved query"],
    results: [{ title: "Saved source", url: "https://example.com/source", snippet: "Saved evidence" }],
  };
  const payload = voiceWebResearchRunToPanelPayload({
    id: "550e8400-e29b-41d4-a716-446655440001",
    meetingId: "550e8400-e29b-41d4-a716-446655440002",
    userId: "550e8400-e29b-41d4-a716-446655440003",
    agentProfileId: "550e8400-e29b-41d4-a716-446655440004",
    utteranceId: "utterance-1",
    query: "saved query",
    queryKey: "saved query",
    status: "completed",
    researchMode: "instant_grounded",
    sessionId: "session-1",
    searchId: "utterance-1",
    findallId: null,
    taskgroupId: null,
    runRefs: { provider: "gemini_grounding", model: "gemini-2.5-flash" },
    progress: {},
    result: storedResult,
    error: null,
    cancelledAt: null,
    expiresAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  assert.equal(payload.backend, "gemini_grounding");
  assert.equal(payload.researchMode, "instant_grounded");
  assert.equal(payload.status, "completed");
  assert.deepEqual(payload.answer, storedResult.answer);
  assert.deepEqual(payload.answerDisplay, storedResult.answerDisplay);
  assert.deepEqual(payload.results, storedResult.results);
  assert.deepEqual(payload.googleSearchQueries, storedResult.googleSearchQueries);
});

void test("Parallel FindAll response is sanitized for entity panel cards", () => {
  const sanitized = sanitizeParallelFindAllResponse({
    query: "top AI companies in Bay Area",
    findallId: "findall-1",
    entityType: "company",
    limit: FINDALL_SANITIZE_LIMIT,
    response: {
      run: {
        findall_id: "findall-1",
        status: {
          status: "completed",
          is_active: false,
          metrics: {
            generated_candidates_count: FINDALL_METRICS_GENERATED,
            matched_candidates_count: FINDALL_METRICS_MATCHED,
          },
        },
      },
      candidates: [
        {
          candidate_id: "candidate-1",
          name: "Figure AI",
          url: "figure.ai",
          description: "AI robotics company building humanoid robots.",
          match_status: "matched",
          output: {
            direct_match_check: {
              value: "Bay Area AI robotics company",
              is_matched: true,
            },
          },
          basis: [
            {
              field: "direct_match_check",
              reasoning: "Figure AI is headquartered in the Bay Area and builds AI robotics systems.",
              citations: [
                {
                  title: "Figure AI",
                  url: "https://www.figure.ai/",
                  excerpts: ["AI robotics company."],
                },
              ],
            },
          ],
        },
        {
          candidate_id: "candidate-2",
          name: "Unsafe",
          url: "javascript:alert(1)",
          match_status: "matched",
        },
      ],
    },
  });

  assert.equal(sanitized.mode, "findall");
  assert.equal(sanitized.status, "completed");
  assert.equal(sanitized.findallId, "findall-1");
  assert.deepEqual(sanitized.results, [
    {
      kind: "entity",
      entityType: "company",
      name: "Figure AI",
      title: "Figure AI",
      url: "https://figure.ai/",
      domain: "figure.ai",
      description: "AI robotics company building humanoid robots.",
      excerpt: "AI robotics company building humanoid robots.",
      matchStatus: "matched",
      reasons: ["Figure AI is headquartered in the Bay Area and builds AI robotics systems."],
      citations: [
        {
          title: "Figure AI",
          url: "https://www.figure.ai/",
          domain: "figure.ai",
          excerpt: "AI robotics company.",
        },
      ],
    },
  ]);
});

void test("Parallel FindAll empty active result triggers Search fallback", () => {
  const sanitized = sanitizeParallelFindAllResponse({
    query: "top 5 AI companies in the Bay Area 2026",
    findallId: "findall-active",
    entityType: "company",
    limit: FINDALL_ACTIVE_FALLBACK_LIMIT,
    response: {
      findall_id: "findall-active",
      status: {
        status: "running",
        is_active: true,
        metrics: {
          generated_candidates_count: FINDALL_ACTIVE_GENERATED,
          matched_candidates_count: 0,
        },
      },
      candidates: [],
    },
  });

  assert.equal(sanitized.status, "partial");
  assert.deepEqual(sanitized.results, []);
  assert.equal(shouldFallbackFromFindAllToSearch(sanitized), true);
});

void test("Linear panel copy asks about marking an issue done", () => {
  const copy = buildLinearMcpCallCopy({ name: "save_issue", args: { id: "REA-2476", state: "Done" } });
  assert.equal(copy.question, "Should I mark REA-2476 done?");
  assert.equal(copy.successToast, "Marked REA-2476 done in Linear");
  assert.equal(copy.group?.key, "state:done");
});

void test("Linear panel copy phrases state moves, assignments, and renames", () => {
  assert.equal(
    buildLinearMcpCallCopy({ name: "save_issue", args: { identifier: "REA-2476", state: "In Progress" } }).question,
    "Should I move REA-2476 to In Progress?",
  );
  assert.equal(
    buildLinearMcpCallCopy({ name: "save_issue", args: { identifier: "REA-2476", assignee: "Personqr" } }).question,
    "Should I assign REA-2476 to Personqr?",
  );
  assert.equal(
    buildLinearMcpCallCopy({ name: "update_issue", args: { id: "REA-2476", title: "New checkout flow" } }).question,
    'Should I rename REA-2476 to "New checkout flow"?',
  );
  assert.equal(
    buildLinearMcpCallCopy({ name: "save_issue", args: { id: "REA-2476", priority: 1 } }).question,
    "Should I set REA-2476 to Urgent priority?",
  );
  assert.equal(
    buildLinearMcpCallCopy({ name: "save_issue", args: { id: "REA-2476", state: "Canceled" } }).question,
    "Should I mark REA-2476 canceled?",
  );
});

void test("Linear panel copy combines two changes and falls back beyond that", () => {
  const two = buildLinearMcpCallCopy({
    name: "save_issue",
    args: { id: "REA-2476", state: "Done", assignee: "Personqr" },
  });
  assert.equal(two.question, "Should I mark REA-2476 done and assign it to Personqr?");
  assert.equal(two.successToast, "Updated REA-2476 in Linear");

  const three = buildLinearMcpCallCopy({
    name: "save_issue",
    args: {
      id: "REA-2476",
      state: "Done",
      assignee: "Personqr",
      priority: LINEAR_SAVE_ISSUE_PRIORITY_NORMAL,
    },
  });
  assert.equal(three.question, `Should I ${LINEAR_QUESTION_VERB} REA-2476?`);
});

void test("Linear panel copy falls back when arguments cannot be quoted", () => {
  const uuidState = buildLinearMcpCallCopy({
    name: "save_issue",
    args: {
      id: "REA-2476",
      stateId: "0c8d2f9a-4b1e-4f6a-9c3d-2e7b8a1f5d40",
    },
  });
  assert.equal(uuidState.question, `Should I ${LINEAR_QUESTION_VERB} REA-2476?`);
  assert.equal(uuidState.successToast, "Updated REA-2476 in Linear");

  const unknownTool = buildLinearMcpCallCopy({ name: "save_initiative", args: { name: "Q3 bets" } });
  assert.equal(unknownTool.question, 'Should I run "Save initiative" in Linear?');
});

void test("Linear panel copy covers creation, comments, and projects", () => {
  assert.equal(
    buildLinearMcpCallCopy({ name: "create_issue", args: { title: "Fix login redirect" } }).question,
    'Should I create "Fix login redirect" in Linear?',
  );
  assert.equal(
    buildLinearMcpCallCopy({ name: "save_issue", args: { title: "Fix login redirect", team: "Mobile" } }).question,
    'Should I create "Fix login redirect" in the Mobile team?',
  );
  assert.equal(
    buildLinearMcpCallCopy({
      name: "create_comment",
      args: { issueId: "0c8d2f9a-4b1e-4f6a-9c3d-2e7b8a1f5d40", body: "ping" },
    }).question,
    "Should I add this comment in Linear?",
  );
  assert.equal(
    buildLinearMcpCallCopy({ name: "save_project", args: { name: "Q3 Launch" } }).question,
    'Should I create the project "Q3 Launch"?',
  );
});

void test("Linear batch copy merges same-verb actions and counts mixed ones", () => {
  const pair = buildLinearPreparedActionCopy([
    { name: "save_issue", arguments: { id: "REA-2476", state: "Done" } },
    { name: "save_issue", arguments: { id: "REA-2483", state: "Done" } },
  ]);
  assert.equal(pair.question, "Should I mark REA-2476 and REA-2483 done?");
  assert.equal(pair.successToast, "Marked REA-2476 and REA-2483 done in Linear");
  assert.deepEqual(pair.partial, { pastPrefix: "Marked ", pastSuffix: " done", noun: "issues" });

  const many = buildLinearPreparedActionCopy(
    ["REA-1", "REA-2", "REA-3", "REA-4", "REA-5"].map((id) => ({
      name: "save_issue",
      arguments: { id, state: "Done" },
    })),
  );
  assert.equal(many.question, "Should I mark REA-1, REA-2, and 3 more done?");
  assert.equal(many.successToast, "Marked 5 issues done in Linear");

  const mixed = buildLinearPreparedActionCopy([
    { name: "save_issue", arguments: { id: "REA-1", state: "Done" } },
    { name: "save_issue", arguments: { id: "REA-2", assignee: "Personqr" } },
  ]);
  assert.equal(mixed.question, `Should I make these ${LINEAR_BATCH_MIXED_CHANGE_COUNT} changes in Linear?`);
  assert.equal(mixed.successToast, `Made ${LINEAR_BATCH_MIXED_CHANGE_COUNT} changes in Linear`);
  assert.equal(mixed.partial, null);
});

void test("Linear batch copy uses the deleted kind as the count noun", () => {
  const many = buildLinearPreparedActionCopy(
    ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"].map((name) => ({
      name: "delete_project",
      arguments: { name },
    })),
  );
  assert.equal(many.successToast, "Deleted 5 projects in Linear");
  assert.equal(many.partial?.noun, "projects");
});

void test("Linear batch copy lists three identifiers with an Oxford comma", () => {
  const triple = buildLinearPreparedActionCopy([
    { name: "save_issue", arguments: { id: "REA-1", state: "In Progress" } },
    { name: "save_issue", arguments: { id: "REA-2", state: "In Progress" } },
    { name: "save_issue", arguments: { id: "REA-3", state: "In Progress" } },
  ]);
  assert.equal(triple.question, "Should I move REA-1, REA-2, and REA-3 to In Progress?");
  assert.equal(triple.successToast, "Moved REA-1, REA-2, and REA-3 to In Progress in Linear");
});
