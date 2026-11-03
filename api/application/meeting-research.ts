import type { AiWorkflowJobView } from "@readymeet/shared";

import { repositories } from "../ports/repository-runtime";

import {
  buildParallelEntityFallbackSearchRequest,
  buildParallelExtractRequest,
  buildParallelFindAllRequest,
  buildParallelWebSearchRequest,
  classifyParallelWebSearchQuery,
  sanitizeParallelFindAllResponse,
  sanitizeParallelWebSearchResponse,
  shouldFallbackFromFindAllToSearch,
} from "./agent-tool-broker";
import {
  parallelClientFromEnv,
  type ParallelExtractResponse,
  type ParallelFindAllResultResponse,
  type ParallelMeetingPrepClient,
} from "./calendar-meeting-prep";

const CLEAN_TEXT_DEFAULT_MAX_LENGTH = 900;
const SOURCE_TITLE_MAX_LENGTH = 180;
const SLUG_FILENAME_MAX_LENGTH = 70;
const QUERY_TITLE_MAX_LENGTH = 72;
const QUERY_TITLE_TRUNCATED_LENGTH = 69;
const RESEARCH_PAPER_RUN_ID_SLICE_LENGTH = 8;
const MAX_ENTITY_SECTION_ROWS = 20;
const ENTITY_LABEL_MAX_LENGTH = 160;
const ENTITY_DESCRIPTION_MAX_LENGTH = 700;
const SUMMARY_SOURCE_SLICE_COUNT = 5;
const RESEARCH_DESCRIPTION_MAX_LENGTH = 220;
const PARALLEL_FIND_ALL_RESULT_LIMIT = 20;
const PARALLEL_WEB_SEARCH_LIMIT = 12;
const DEFAULT_HEARTBEAT_PHASE = "running";
const FALLBACK_SLUG_FILENAME = "meeting-research";

const MEETING_RESEARCH_MESSAGES = {
  jobMissingResearchRunId: "Meeting research job payload is missing researchRunId",
  parallelNotConfiguredCode: "parallel_not_configured",
  researchServiceNotConfigured: "Research service is not configured.",
  researchUnavailableLabel: "Research unavailable",
  researchBlockedCode: "research_blocked",
  researchBlockedMessage: "This request cannot be completed safely.",
  researchBlockedLabel: "Research blocked",
  runCompletedLog: "Meeting research run completed",
};

type LoggerLike = {
  info(...args: [bindings: Record<string, unknown>, message: string]): void;
  warn(...args: [bindings: Record<string, unknown>, message: string]): void;
  error(...args: [bindings: Record<string, unknown>, message: string]): void;
};

type ResearchPaper = {
  title: string;
  description: string;
  markdown: string;
  filename: string;
  generatedAt: string;
};

type MeetingResearchJobResult = {
  status: string;
  runId: string;
};

type ActiveWebSearchClassification = Exclude<ReturnType<typeof classifyParallelWebSearchQuery>, { mode: "blocked" }>;

type ResearchSource = {
  title: string;
  url: string;
  excerpt: string;
};

async function sleep(ms: number) {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    timeout.unref();
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanText(input: { value: unknown; maxLength?: number }) {
  const maxLength = input.maxLength ?? CLEAN_TEXT_DEFAULT_MAX_LENGTH;

  return asString(input.value).replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function meetingResearchRunNotFoundMessage(runId: string) {
  return `Meeting research run "${runId}" was not found`;
}

function slugifyFilename(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_FILENAME_MAX_LENGTH);

  return slug !== "" ? slug : FALLBACK_SLUG_FILENAME;
}

function titleFromQuery(query: string) {
  const trimmed = query.replace(/\s+/g, " ").trim();
  if (trimmed.length <= QUERY_TITLE_MAX_LENGTH) {
    return `Deep Research: ${trimmed}`;
  }

  return `Deep Research: ${trimmed.slice(0, QUERY_TITLE_TRUNCATED_LENGTH).trim()}...`;
}

function normalizeExtractSources(response: ParallelExtractResponse | null): ResearchSource[] {
  if (!response?.results) {
    return [];
  }

  return response.results.flatMap((result) => {
    const url = asString(result.url);
    if (url === "") {
      return [];
    }
    const excerptSource = Array.isArray(result.excerpts)
      ? result.excerpts.find((item) => cleanText({ value: item }) !== "")
      : result.full_content;
    const excerpt = cleanText({ value: excerptSource, maxLength: CLEAN_TEXT_DEFAULT_MAX_LENGTH });
    const titleText = cleanText({ value: result.title, maxLength: SOURCE_TITLE_MAX_LENGTH });

    return [
      {
        title: titleText !== "" ? titleText : url,
        url,
        excerpt,
      },
    ];
  });
}

export function normalizeSourceResults(result: unknown): ResearchSource[] {
  if (!isRecord(result) || !Array.isArray(result.results)) {
    return [];
  }

  return result.results.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const url = asString(item.url);
    if (url === "") {
      return [];
    }
    const titleText = cleanText({
      value: item.title ?? item.name,
      maxLength: SOURCE_TITLE_MAX_LENGTH,
    });

    return [
      {
        title: titleText !== "" ? titleText : url,
        url,
        excerpt: cleanText({
          value: item.excerpt ?? item.description,
          maxLength: CLEAN_TEXT_DEFAULT_MAX_LENGTH,
        }),
      },
    ];
  });
}

const MAX_UNIQUE_SOURCES = 16;

function uniqueSources(sources: ResearchSource[]) {
  return sources
    .filter((source, index, all) => source.url !== "" && all.findIndex((item) => item.url === source.url) === index)
    .slice(0, MAX_UNIQUE_SOURCES);
}

function markdownBullet(value: string) {
  return value.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
}

export function buildResearchPaper(input: {
  runId: string;
  query: string;
  sources: ResearchSource[];
  entityResults: unknown[];
  generatedAt: string;
}): ResearchPaper {
  const title = titleFromQuery(input.query);
  const filename = `${slugifyFilename(title)}-${input.runId.slice(0, RESEARCH_PAPER_RUN_ID_SLICE_LENGTH)}.md`;
  const sources = uniqueSources(input.sources);
  const entityRows = input.entityResults.filter(isRecord).slice(0, MAX_ENTITY_SECTION_ROWS);
  const entitySection =
    entityRows.length !== 0
      ? [
          "## Findings",
          "",
          ...entityRows.flatMap((entity, index) => {
            const labelText = cleanText({
              value: entity.name ?? entity.title,
              maxLength: ENTITY_LABEL_MAX_LENGTH,
            });
            const label = labelText !== "" ? labelText : `Result ${index + 1}`;
            const url = asString(entity.url);
            const description = cleanText({
              value: entity.description ?? entity.excerpt,
              maxLength: ENTITY_DESCRIPTION_MAX_LENGTH,
            });

            return [
              `### ${index + 1}. ${label}`,
              url !== "" ? `Source: ${url}` : "",
              description !== "" ? `- ${markdownBullet(description)}` : "",
            ].filter(Boolean);
          }),
          "",
        ]
      : [];
  const sourceSection =
    sources.length !== 0
      ? [
          "## Source Notes",
          "",
          ...sources.map((source, index) => {
            const detail = source.excerpt !== "" ? ` - ${markdownBullet(source.excerpt)}` : "";

            return `${index + 1}. [${source.title}](${source.url})${detail}`;
          }),
        ]
      : ["## Source Notes", "", "No source notes were returned before the research run completed."];
  const summaryLines = sources
    .slice(0, SUMMARY_SOURCE_SLICE_COUNT)
    .map((source) => source.excerpt)
    .filter((excerpt) => excerpt !== "");
  const firstSummaryLine = summaryLines[0];
  const description =
    firstSummaryLine !== undefined && firstSummaryLine !== ""
      ? firstSummaryLine.slice(0, RESEARCH_DESCRIPTION_MAX_LENGTH)
      : `Research paper generated from the meeting request: ${input.query}`;
  const markdown = [
    `# ${title}`,
    "",
    `Generated: ${input.generatedAt}`,
    "",
    "## Research Request",
    "",
    input.query,
    "",
    ...entitySection,
    ...sourceSection,
    "",
    "## Next Steps",
    "",
    "- Review the sourced notes above.",
    "- Follow the linked sources for any claims that need higher confidence before acting.",
    "- Turn the strongest findings into a task, brief, or dataset as needed.",
  ].join("\n");

  return {
    title,
    description,
    markdown,
    filename,
    generatedAt: input.generatedAt,
  };
}

async function loadRunOrThrow(input: { meetingId: string; runId: string }) {
  const run = await repositories().getMeetingResearchRunById(input);
  if (run === null) {
    throw new Error(meetingResearchRunNotFoundMessage(input.runId));
  }

  return run;
}

async function updateProgress(input: {
  runId: string;
  job: AiWorkflowJobView;
  workerId: string;
  label: string;
  detail: string;
  runRefs?: Record<string, unknown>;
}) {
  await repositories().updateMeetingResearchRun({
    id: input.runId,
    status: "running",
    progressLabel: input.label,
    progressDetail: input.detail,
    runRefs: input.runRefs,
  });
  const heartbeatPhase = input.label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  await repositories().heartbeatAiWorkflowJob({
    jobId: input.job.id,
    workerId: input.workerId,
    phase: heartbeatPhase !== "" ? heartbeatPhase : DEFAULT_HEARTBEAT_PHASE,
    result: {
      researchRunId: input.runId,
      progressLabel: input.label,
      progressDetail: input.detail,
      runRefs: input.runRefs ?? {},
    },
  });
}

async function shouldStopForCancellation(input: { meetingId: string; runId: string }) {
  const run = await loadRunOrThrow(input);

  return run.status === "cancelled";
}

const FIND_ALL_POLL_ATTEMPTS = 24;
const FIND_ALL_POLL_DELAY_MS = 5_000;

type FindAllPoll = { isCancelled: boolean; result: ParallelFindAllResultResponse | null };

async function pollFindAllResult(input: {
  initial: ParallelFindAllResultResponse | null;
  findallId: string;
  retrieve: (findallId: string) => Promise<ParallelFindAllResultResponse>;
  shouldCancel: () => Promise<boolean>;
  onProgress: (result: ParallelFindAllResultResponse) => Promise<void>;
}): Promise<FindAllPoll> {
  return Array.from({ length: FIND_ALL_POLL_ATTEMPTS }).reduce<Promise<FindAllPoll>>(
    async (previous) => {
      const current = await previous;
      if (current.isCancelled || current.result?.status?.is_active !== true) {
        return current;
      }
      if (await input.shouldCancel()) {
        return { isCancelled: true, result: current.result };
      }
      await sleep(FIND_ALL_POLL_DELAY_MS);
      const next = await input.retrieve(input.findallId);
      await input.onProgress(next);

      return { isCancelled: false, result: next };
    },
    Promise.resolve({ isCancelled: false, result: input.initial }),
  );
}

async function collectEntityDiscovery(input: {
  client: ParallelMeetingPrepClient;
  query: string;
  entityType: ReturnType<typeof classifyParallelWebSearchQuery>["entityType"];
  runId: string;
  job: AiWorkflowJobView;
  workerId: string;
  meetingId: string;
  runRefs: Record<string, unknown>;
}): Promise<
  | { isCancelled: true }
  | { isCancelled: false; entityResults: unknown[]; sources: ResearchSource[]; runRefs: Record<string, unknown> }
> {
  const findAllRun = await input.client.createFindAllRun(
    buildParallelFindAllRequest({
      query: input.query,
      entityType: input.entityType,
      limit: PARALLEL_FIND_ALL_RESULT_LIMIT,
    }),
  );
  const findallId = asString(findAllRun.findall_id);
  const runRefs = findallId === "" ? input.runRefs : { ...input.runRefs, findallId };
  await updateProgress({
    runId: input.runId,
    job: input.job,
    workerId: input.workerId,
    label: "Finding matches",
    detail: "Discovering and checking relevant public entities.",
    runRefs,
  });
  const initial = findallId === "" ? null : await input.client.retrieveFindAllRunResult(findallId);
  const polled =
    findallId === ""
      ? { isCancelled: false, result: initial }
      : await pollFindAllResult({
          initial,
          findallId,
          retrieve: (id) => input.client.retrieveFindAllRunResult(id),
          shouldCancel: () => shouldStopForCancellation({ meetingId: input.meetingId, runId: input.runId }),
          onProgress: async (result) => {
            await updateProgress({
              runId: input.runId,
              job: input.job,
              workerId: input.workerId,
              label: "Checking matches",
              detail: `Reviewed ${result.status?.metrics?.matched_candidates_count ?? 0} matching candidates so far.`,
              runRefs,
            });
          },
        });
  if (polled.isCancelled) {
    return { isCancelled: true };
  }
  const sanitizedFindAll = polled.result
    ? sanitizeParallelFindAllResponse({
        query: input.query,
        response: polled.result,
        findallId,
        entityType: input.entityType,
        limit: PARALLEL_FIND_ALL_RESULT_LIMIT,
      })
    : null;
  const entityResults = Array.isArray(sanitizedFindAll?.results) ? sanitizedFindAll.results : [];
  const fallback =
    sanitizedFindAll !== null && shouldFallbackFromFindAllToSearch(sanitizedFindAll)
      ? await fallbackEntitySources({ client: input.client, query: input.query, entityType: input.entityType, runRefs })
      : null;

  return {
    isCancelled: false,
    entityResults,
    sources: [...normalizeSourceResults(sanitizedFindAll), ...(fallback?.sources ?? [])],
    runRefs: fallback?.runRefs ?? runRefs,
  };
}

async function fallbackEntitySources(input: {
  client: ParallelMeetingPrepClient;
  query: string;
  entityType: ReturnType<typeof classifyParallelWebSearchQuery>["entityType"];
  runRefs: Record<string, unknown>;
}): Promise<{ sources: ResearchSource[]; runRefs: Record<string, unknown> }> {
  const fallback = await input.client.searchCompanyLatestSignals(
    buildParallelEntityFallbackSearchRequest({
      query: input.query,
      entityType: input.entityType,
    }),
  );
  const runRefs = {
    ...input.runRefs,
    searchId: fallback.search_id ?? input.runRefs.searchId,
    sessionId: fallback.session_id ?? input.runRefs.sessionId,
  };
  const fallbackResult = sanitizeParallelWebSearchResponse({
    query: input.query,
    response: fallback,
    limit: PARALLEL_WEB_SEARCH_LIMIT,
  });

  return { sources: normalizeSourceResults(fallbackResult), runRefs };
}

async function failMeetingResearchForMissingParallel(runId: string): Promise<MeetingResearchJobResult> {
  await repositories().updateMeetingResearchRun({
    id: runId,
    status: "failed",
    progressLabel: MEETING_RESEARCH_MESSAGES.researchUnavailableLabel,
    progressDetail: MEETING_RESEARCH_MESSAGES.researchServiceNotConfigured,
    error: {
      code: MEETING_RESEARCH_MESSAGES.parallelNotConfiguredCode,
      message: MEETING_RESEARCH_MESSAGES.researchServiceNotConfigured,
    },
    completedAt: new Date(),
  });

  return { status: "failed", runId };
}

async function failMeetingResearchForBlockedRequest(runId: string): Promise<MeetingResearchJobResult> {
  await repositories().updateMeetingResearchRun({
    id: runId,
    status: "failed",
    progressLabel: MEETING_RESEARCH_MESSAGES.researchBlockedLabel,
    progressDetail: MEETING_RESEARCH_MESSAGES.researchBlockedMessage,
    error: {
      code: MEETING_RESEARCH_MESSAGES.researchBlockedCode,
      message: MEETING_RESEARCH_MESSAGES.researchBlockedMessage,
    },
    completedAt: new Date(),
  });

  return { status: "failed", runId };
}

async function collectStandardModeSources(input: {
  client: ParallelMeetingPrepClient;
  query: string;
  classification: ActiveWebSearchClassification;
  runId: string;
  job: AiWorkflowJobView;
  workerId: string;
  meetingId: string;
  runRefs: Record<string, unknown>;
  sources: ResearchSource[];
}): Promise<
  { isCancelled: true } | { isCancelled: false; sources: ResearchSource[]; runRefs: Record<string, unknown> }
> {
  const runRefs = { ...input.runRefs };
  await updateProgress({
    runId: input.runId,
    job: input.job,
    workerId: input.workerId,
    label: "Searching sources",
    detail: "Gathering current public sources for the research paper.",
    runRefs,
  });
  const search = await input.client.searchCompanyLatestSignals(
    buildParallelWebSearchRequest({
      query: input.query,
      researchMode: input.classification.mode,
    }),
  );
  runRefs.searchId = search.search_id ?? null;
  runRefs.sessionId = search.session_id ?? null;
  const searchResult = sanitizeParallelWebSearchResponse({
    query: input.query,
    response: search,
    limit: PARALLEL_WEB_SEARCH_LIMIT,
  });
  const normalizedSearchSources = normalizeSourceResults(searchResult);
  const sourcesWithSearch = [...input.sources, ...normalizedSearchSources];
  const urls = normalizedSearchSources.map((source) => source.url);
  const shouldExtractSources =
    urls.length !== 0 &&
    (input.classification.mode === "verified_answer" || input.classification.mode === "deep_research");
  if (!shouldExtractSources) {
    return { isCancelled: false, sources: sourcesWithSearch, runRefs };
  }
  if (await shouldStopForCancellation({ meetingId: input.meetingId, runId: input.runId })) {
    return { isCancelled: true };
  }
  await updateProgress({
    runId: input.runId,
    job: input.job,
    workerId: input.workerId,
    label: "Reading sources",
    detail: "Extracting useful details from the most relevant pages.",
    runRefs,
  });
  const sessionIdText = asString(runRefs.sessionId);
  const extract = await input.client.extractUrls(
    buildParallelExtractRequest({
      query: input.query,
      urls,
      sessionId: sessionIdText !== "" ? sessionIdText : null,
    }),
  );
  runRefs.extractId = extract.extract_id ?? null;
  const sourcesWithExtract = [...sourcesWithSearch, ...normalizeExtractSources(extract)];

  return { isCancelled: false, sources: sourcesWithExtract, runRefs };
}

async function completeMeetingResearchRun(input: {
  runId: string;
  job: AiWorkflowJobView;
  workerId: string;
  logger: LoggerLike;
  query: string;
  sources: ResearchSource[];
  entityResults: unknown[];
  activeRunRefs: Record<string, unknown>;
}): Promise<MeetingResearchJobResult> {
  await updateProgress({
    runId: input.runId,
    job: input.job,
    workerId: input.workerId,
    label: "Writing paper",
    detail: "Structuring the findings into a downloadable research note.",
    runRefs: input.activeRunRefs,
  });

  const generatedAt = new Date().toISOString();
  const researchPaper = buildResearchPaper({
    runId: input.runId,
    query: input.query,
    sources: input.sources,
    entityResults: input.entityResults,
    generatedAt,
  });
  const sourceCount = uniqueSources(input.sources).length;
  const entityCount = input.entityResults.length;
  const updated = await repositories().updateMeetingResearchRun({
    id: input.runId,
    status: "completed",
    progressLabel: "Complete",
    progressDetail: "Research paper is ready.",
    runRefs: input.activeRunRefs,
    result: {
      researchPaper,
      sourceCount,
      entityCount,
    },
    error: null,
    completedAt: new Date(),
  });

  input.logger.info(
    {
      meetingId: input.job.meetingId,
      runId: input.runId,
      sourceCount,
      entityCount,
    },
    MEETING_RESEARCH_MESSAGES.runCompletedLog,
  );

  return { status: updated?.status ?? "completed", runId: input.runId };
}

async function executeActiveMeetingResearchJob(input: {
  job: AiWorkflowJobView;
  workerId: string;
  logger: LoggerLike;
  runId: string;
  client: ParallelMeetingPrepClient;
  query: string;
  classification: ActiveWebSearchClassification;
}): Promise<MeetingResearchJobResult> {
  const runRefs: Record<string, unknown> = { classification: input.classification };
  const emptyEntityResults: unknown[] = [];
  const emptySources: ResearchSource[] = [];

  await updateProgress({
    runId: input.runId,
    job: input.job,
    workerId: input.workerId,
    label: "Planning research",
    detail: "Choosing the best research route for this meeting request.",
    runRefs,
  });

  const discovered =
    input.classification.mode === "entity_discovery"
      ? await collectEntityDiscovery({
          client: input.client,
          query: input.query,
          entityType: input.classification.entityType,
          runId: input.runId,
          job: input.job,
          workerId: input.workerId,
          meetingId: input.job.meetingId,
          runRefs,
        })
      : { isCancelled: false, entityResults: emptyEntityResults, sources: emptySources, runRefs };
  if (discovered.isCancelled) {
    return { status: "cancelled", runId: input.runId };
  }

  const entityResults = discovered.entityResults;
  const standardCollection =
    input.classification.mode !== "entity_discovery"
      ? await collectStandardModeSources({
          client: input.client,
          query: input.query,
          classification: input.classification,
          runId: input.runId,
          job: input.job,
          workerId: input.workerId,
          meetingId: input.job.meetingId,
          runRefs: discovered.runRefs,
          sources: [...discovered.sources],
        })
      : null;
  if (standardCollection?.isCancelled === true) {
    return { status: "cancelled", runId: input.runId };
  }
  const sources = standardCollection?.sources ?? [...discovered.sources];
  const activeRunRefs = standardCollection?.runRefs ?? discovered.runRefs;

  if (await shouldStopForCancellation({ meetingId: input.job.meetingId, runId: input.runId })) {
    return { status: "cancelled", runId: input.runId };
  }

  return completeMeetingResearchRun({
    runId: input.runId,
    job: input.job,
    workerId: input.workerId,
    logger: input.logger,
    query: input.query,
    sources,
    entityResults,
    activeRunRefs,
  });
}

export async function runMeetingResearchJob(input: {
  job: AiWorkflowJobView;
  workerId: string;
  logger: LoggerLike;
}): Promise<MeetingResearchJobResult> {
  const runId = asString(input.job.payload.researchRunId);
  if (runId === "") {
    throw new Error(MEETING_RESEARCH_MESSAGES.jobMissingResearchRunId);
  }

  const run = await loadRunOrThrow({ meetingId: input.job.meetingId, runId });
  if (run.status === "cancelled") {
    return { status: "cancelled", runId };
  }
  if (run.status === "completed") {
    return { status: "completed", runId };
  }

  const client = parallelClientFromEnv();
  if (client === null) {
    return failMeetingResearchForMissingParallel(runId);
  }

  const query = run.query;
  const classification = classifyParallelWebSearchQuery(query);
  if (classification.mode === "blocked") {
    return failMeetingResearchForBlockedRequest(runId);
  }

  return executeActiveMeetingResearchJob({
    job: input.job,
    workerId: input.workerId,
    logger: input.logger,
    runId,
    client,
    query,
    classification,
  });
}
