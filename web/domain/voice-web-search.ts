import { z } from "zod";

const LINT_NUM_N260 = 260;
const LINT_NUM_N160 = 160;

export const WEB_SEARCH_LOADER_MIN_VISIBLE_MS = 2_000;
const VOICE_WEB_SEARCH_QUERY_NORMALIZE_MAX_LENGTH = LINT_NUM_N260;
const VOICE_WEB_SEARCH_URL_MAX_LENGTH = 2_000;
const VOICE_WEB_SEARCH_STATUS_MAX_LENGTH = 40;
const VOICE_WEB_SEARCH_MODE_MAX_LENGTH = 40;
const VOICE_WEB_SEARCH_RESEARCH_MODE_MAX_LENGTH = 60;
const VOICE_WEB_SEARCH_ENTITY_TYPE_MAX_LENGTH = 40;
const VOICE_WEB_SEARCH_TITLE_MAX_LENGTH = 180;
const VOICE_WEB_SEARCH_DOMAIN_MAX_LENGTH = 120;
const VOICE_WEB_SEARCH_EXCERPT_MAX_LENGTH = 300;
const VOICE_WEB_SEARCH_SUMMARY_MAX_LENGTH = 520;
const VOICE_WEB_SEARCH_FACT_TEXT_MAX_LENGTH = LINT_NUM_N260;
const VOICE_WEB_SEARCH_CAVEAT_MAX_LENGTH = 220;
const VOICE_WEB_SEARCH_CITATION_ID_MAX_LENGTH = 80;
const VOICE_WEB_SEARCH_DISPLAY_LABEL_MAX_LENGTH = 48;
const VOICE_WEB_SEARCH_DISPLAY_TEXT_MAX_LENGTH = 520;
const VOICE_WEB_SEARCH_DISPLAY_LEAD_MAX_LENGTH = 180;
const VOICE_WEB_SEARCH_DISPLAY_HEADING_MAX_LENGTH = 80;
const VOICE_WEB_SEARCH_PROGRESS_MESSAGE_MAX_LENGTH = LINT_NUM_N260;
const VOICE_WEB_SEARCH_PROGRESS_PHASE_MAX_LENGTH = 80;
const VOICE_WEB_SEARCH_PROGRESS_ID_MAX_LENGTH = 120;
const VOICE_WEB_SEARCH_STATS_TEXT_MAX_LENGTH = LINT_NUM_N160;
const VOICE_WEB_SEARCH_SIGNAL_TEXT_MAX_LENGTH = LINT_NUM_N260;
const VOICE_WEB_SEARCH_PROGRESS_DETAIL_MAX_LENGTH = 320;
const VOICE_WEB_SEARCH_PROGRESS_STATUS_LABEL_MAX_LENGTH = 180;
const VOICE_WEB_SEARCH_RESULT_EXCERPT_MAX_LENGTH = 700;
const VOICE_WEB_SEARCH_REASONS_MAX_ITEMS = 3;
const VOICE_WEB_SEARCH_REASON_MAX_LENGTH = 500;
const VOICE_WEB_SEARCH_QUERY_FIELD_MAX_LENGTH = 500;
const VOICE_WEB_SEARCH_ID_FIELD_MAX_LENGTH = LINT_NUM_N160;
const VOICE_WEB_SEARCH_GOOGLE_QUERY_MAX_ITEMS = 6;
const VOICE_WEB_SEARCH_GOOGLE_QUERY_MAX_LENGTH = LINT_NUM_N160;
const VOICE_WEB_SEARCH_SUGGESTIONS_HTML_MAX_LENGTH = 12_000;
const VOICE_WEB_SEARCH_CITATION_LIST_MAX_ITEMS = 4;
const VOICE_WEB_SEARCH_FACT_LIST_MAX_ITEMS = 5;
const VOICE_WEB_SEARCH_RESULT_LIST_MAX_ITEMS = 8;
const VOICE_WEB_SEARCH_DISPLAY_CITATION_MAX_ITEMS = 8;
const VOICE_WEB_SEARCH_BOLD_MAX_ITEMS = 4;
const VOICE_WEB_SEARCH_BOLD_ITEM_MAX_LENGTH = 80;
const VOICE_WEB_SEARCH_CITATION_ID_LIST_MAX_ITEMS = 8;
const VOICE_WEB_SEARCH_SECTION_MAX_ITEMS = 4;
const VOICE_WEB_SEARCH_SECTION_CONTENT_MAX_ITEMS = 6;
const VOICE_WEB_SEARCH_SECTION_CITATION_MAX_ITEMS = 4;
const VOICE_WEB_SEARCH_PARTIAL_CITATION_MAX_ITEMS = 6;
const VOICE_WEB_SEARCH_CLAIM_CITATION_MAX_ITEMS = 3;
const VOICE_WEB_SEARCH_PROGRESS_STEP_MAX_ITEMS = 24;
const VOICE_WEB_SEARCH_PROGRESS_HISTORY_MAX_ITEMS = 12;
const VOICE_WEB_SEARCH_ACTIVE_SOURCE_MAX_ITEMS = 10;
const VOICE_WEB_SEARCH_SIGNAL_MAX_ITEMS = 5;
const VOICE_WEB_SEARCH_SIGNAL_CITATION_MAX_ITEMS = 4;
const VOICE_WEB_SEARCH_PERCENT_MAX = 100;
const VOICE_WEB_SEARCH_UNREADABLE_MESSAGE = "Could not read web search results.";
const VOICE_WEB_SEARCH_DEFAULT_SOURCE_LABEL = "Source";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function coalesceNonEmptyStrings(input: { candidates: (string | null | undefined)[]; fallback?: string }): string {
  const match = input.candidates.find((candidate) => candidate !== null && candidate !== undefined && candidate !== "");

  return match ?? input.fallback ?? "";
}

function nullableNonEmptyString(value: string): string | null {
  return value !== "" ? value : null;
}

export const WEB_SEARCH_LOADER_FADE_MS = 240;

export type VoiceWebSearchSourceResult = {
  kind: "source";
  title: string;
  url: string;
  publishDate: string | null;
  domain: string | null;
  excerpt: string;
};

type VoiceWebSearchCitation = {
  title: string;
  url: string;
  domain: string | null;
  excerpt: string;
};

export type VoiceWebSearchEntityResult = {
  kind: "entity";
  entityType: "person" | "company" | "product" | "other";
  name: string;
  title: string;
  url: string;
  domain: string | null;
  description: string;
  excerpt: string;
  matchStatus: string | null;
  reasons: string[];
  citations: VoiceWebSearchCitation[];
};

export type VoiceWebSearchResult = VoiceWebSearchSourceResult | VoiceWebSearchEntityResult;

type VoiceWebSearchAnswer = {
  summary: string;
  confidence: "high" | "medium" | "low" | "unverified";
  facts: {
    text: string;
    citations: VoiceWebSearchCitation[];
  }[];
  citations: VoiceWebSearchCitation[];
  caveat: string | null;
};

type VoiceWebAnswerDisplayText = {
  text: string;
  bold: string[];
  citationIds: string[];
};

type VoiceWebAnswerDisplay = {
  lead: string;
  confidence: "high" | "medium" | "low" | "unverified";
  citationCoverage: "complete" | "partial" | "missing";
  sections: {
    heading: string | null;
    bullets: VoiceWebAnswerDisplayText[];
    paragraphs: VoiceWebAnswerDisplayText[];
  }[];
  citations: {
    id: string;
    label: string;
    title: string;
    url: string;
    domain: string | null;
  }[];
};

type VoiceWebSearchProgressStep = {
  id: string | null;
  phase: string | null;
  source: string | null;
  message: string | null;
  at: string | null;
};

type VoiceWebSearchActiveSource = {
  title: string | null;
  url: string;
  domain: string | null;
};

type VoiceWebSearchSignal = {
  text: string;
  citationIds: string[];
};

type VoiceWebSearchProgress = {
  phase: string | null;
  statusLabel: string | null;
  message: string | null;
  detail: string | null;
  elapsedMs: number | null;
  percent: number | null;
  steps: VoiceWebSearchProgressStep[];
  stats: Record<string, number | string | null>;
  activeSources: VoiceWebSearchActiveSource[];
  signals: VoiceWebSearchSignal[];
  partialAnswer: VoiceWebSearchAnswer | null;
  history: {
    phase: string | null;
    message: string | null;
    at: string | null;
  }[];
};

export type VoiceWebSearchPanelPayload = {
  contentKind?: "meeting-answer";
  status: "searching" | "partial" | "completed" | "error";
  mode: "search" | "findall" | "blocked" | null;
  researchMode:
    | "turbo_search"
    | "instant_grounded"
    | "fast_grounded"
    | "verified_answer"
    | "entity_discovery"
    | "deep_research"
    | "blocked"
    | null;
  query: string;
  researchRunId: string | null;
  searchId: string | null;
  sessionId: string | null;
  findallId: string | null;
  entityType: "person" | "company" | "product" | "other" | null;
  answer: VoiceWebSearchAnswer | null;
  answerDisplay: VoiceWebAnswerDisplay | null;
  results: VoiceWebSearchResult[];
  progress: VoiceWebSearchProgress | null;
  message: string | null;
  answerPreview: string | null;
  tinyCitations: VoiceWebSearchCitation[];
  googleSearchQueries: string[];
  googleSearchSuggestionsHtml: string | null;
  /** @external voice web search panel wire field */
  deepResearchAvailable: boolean;
  /** @external voice web search panel wire field */
  shouldAskToDeepen: boolean;
  /** @external voice web search panel wire field */
  deepResearchAutoStarted: boolean;
  deepResearchRunId: string | null;
  meetingId: string | null;
  requestingUserId: string | null;
};

export function isVoiceWebSearchLookingForAnswer(state: VoiceWebSearchPanelPayload | null): boolean {
  return (
    state?.status === "searching" ||
    (state?.status === "partial" &&
      state.answerDisplay === null &&
      state.answer === null &&
      (state.answerPreview === null || state.answerPreview.trim() === ""))
  );
}

export function voiceWebSearchHasReadableResult(state: VoiceWebSearchPanelPayload | null): boolean {
  if (state === null) {
    return false;
  }

  const summary = state.answer?.summary.trim() ?? "";
  const preview = state.answerPreview?.trim() ?? "";

  return (
    state.status === "completed" &&
    (state.answerDisplay !== null || summary !== "" || preview !== "" || state.results.length !== 0)
  );
}

function voiceWebSearchLifecycleIds(payload: VoiceWebSearchPanelPayload) {
  return [payload.searchId, payload.researchRunId, payload.findallId].filter((value): value is string =>
    Boolean(value),
  );
}

function normalizedVoiceWebSearchQuery(query: string) {
  return query
    .toLowerCase()
    .replace(/\bplease\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LINT_NUM_N260);
}

function voiceWebSearchPayloadMatchesCurrentNamed(input: {
  current: VoiceWebSearchPanelPayload | null;
  incoming: VoiceWebSearchPanelPayload;
}): boolean {
  if (input.current === null) {
    return false;
  }
  if (input.current.contentKind !== input.incoming.contentKind) {
    return false;
  }

  const currentIds = voiceWebSearchLifecycleIds(input.current);
  const incomingIds = voiceWebSearchLifecycleIds(input.incoming);
  if (currentIds.length !== 0 && incomingIds.length !== 0) {
    const currentIdSet = new Set(currentIds);

    return incomingIds.some((id) => currentIdSet.has(id));
  }

  const currentQuery = normalizedVoiceWebSearchQuery(input.current.query);
  const incomingQuery = normalizedVoiceWebSearchQuery(input.incoming.query);

  return currentQuery !== "" && currentQuery === incomingQuery && (currentIds.length === 0 || incomingIds.length === 0);
}

export function voiceWebSearchPayloadMatchesCurrent(
  ...args: [current: VoiceWebSearchPanelPayload | null, incoming: VoiceWebSearchPanelPayload]
): boolean {
  const [current, incoming] = args;

  return voiceWebSearchPayloadMatchesCurrentNamed({ current, incoming });
}

function unknownToDisplayString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  return "";
}

function cleanText(input: { value: unknown; maxLength: number }) {
  return unknownToDisplayString(input.value).replace(/\s+/g, " ").trim().slice(0, input.maxLength);
}

function safeHttpUrl(value: unknown) {
  const raw = cleanText({ value, maxLength: VOICE_WEB_SEARCH_URL_MAX_LENGTH });
  if (raw === "") {
    return null;
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    return url.toString();
  } catch (error) {
    if (!(error instanceof Error)) {
      return null;
    }

    return null;
  }
}

function domainFromUrl(value: string) {
  try {
    return new URL(value).hostname.replace(/^www\./i, "");
  } catch (error) {
    if (!(error instanceof Error)) {
      return null;
    }

    return null;
  }
}

function normalizeStatus(value: unknown): VoiceWebSearchPanelPayload["status"] {
  const status = cleanText({ value, maxLength: VOICE_WEB_SEARCH_STATUS_MAX_LENGTH }).toLowerCase();
  if (status === "searching" || status === "partial" || status === "completed" || status === "error") {
    return status;
  }

  return "completed";
}

function normalizeMode(value: unknown): VoiceWebSearchPanelPayload["mode"] {
  const mode = cleanText({ value, maxLength: VOICE_WEB_SEARCH_MODE_MAX_LENGTH }).toLowerCase();
  if (mode === "search" || mode === "findall" || mode === "blocked") {
    return mode;
  }

  return null;
}

function normalizeResearchMode(value: unknown): VoiceWebSearchPanelPayload["researchMode"] {
  const mode = cleanText({ value, maxLength: VOICE_WEB_SEARCH_RESEARCH_MODE_MAX_LENGTH }).toLowerCase();
  if (
    mode === "turbo_search" ||
    mode === "fast_grounded" ||
    mode === "instant_grounded" ||
    mode === "verified_answer" ||
    mode === "entity_discovery" ||
    mode === "deep_research" ||
    mode === "blocked"
  ) {
    return mode;
  }

  return null;
}

function normalizeEntityType(value: unknown): VoiceWebSearchEntityResult["entityType"] {
  const entityType = cleanText({ value, maxLength: VOICE_WEB_SEARCH_ENTITY_TYPE_MAX_LENGTH }).toLowerCase();
  if (entityType === "person" || entityType === "company" || entityType === "product") {
    return entityType;
  }

  return "other";
}

function normalizeCitation(value: unknown): VoiceWebSearchCitation | null {
  if (!isRecord(value)) {
    return null;
  }
  const record = value;
  const url = safeHttpUrl(record.url);
  if (url === null) {
    return null;
  }

  return {
    title: coalesceNonEmptyStrings({
      candidates: [
        cleanText({ value: record.title, maxLength: VOICE_WEB_SEARCH_TITLE_MAX_LENGTH }),
        domainFromUrl(url),
        url,
      ],
      fallback: url,
    }),
    url,
    domain: coalesceNonEmptyStrings({
      candidates: [
        cleanText({ value: record.domain, maxLength: VOICE_WEB_SEARCH_DOMAIN_MAX_LENGTH }),
        domainFromUrl(url),
      ],
      fallback: domainFromUrl(url) ?? "",
    }),
    excerpt: cleanText({ value: record.excerpt, maxLength: VOICE_WEB_SEARCH_EXCERPT_MAX_LENGTH }),
  };
}

function normalizeStringList(input: { value: unknown; maxItems: number; maxLength: number }) {
  if (!Array.isArray(input.value)) {
    return [];
  }

  return input.value
    .map((item) => cleanText({ value: item, maxLength: input.maxLength }))
    .filter(Boolean)
    .slice(0, input.maxItems);
}

function normalizeAnswer(value: unknown): VoiceWebSearchAnswer | null {
  if (!isRecord(value)) {
    return null;
  }
  const record = value;
  const summary = cleanText({ value: record.summary ?? record.answer, maxLength: VOICE_WEB_SEARCH_SUMMARY_MAX_LENGTH });
  if (summary === "") {
    return null;
  }
  const confidence = cleanText({
    value: record.confidence,
    maxLength: VOICE_WEB_SEARCH_STATUS_MAX_LENGTH,
  }).toLowerCase();
  const citations = Array.isArray(record.citations)
    ? record.citations
        .flatMap((citation) => {
          const normalized = normalizeCitation(citation);

          return normalized ? [normalized] : [];
        })
        .slice(0, VOICE_WEB_SEARCH_CITATION_LIST_MAX_ITEMS)
    : [];
  const facts = Array.isArray(record.facts)
    ? record.facts
        .flatMap((fact) => {
          if (!isRecord(fact)) {
            return [];
          }
          const factRecord = fact;
          const text = cleanText({ value: factRecord.text, maxLength: VOICE_WEB_SEARCH_FACT_TEXT_MAX_LENGTH });
          if (text === "") {
            return [];
          }
          const factCitations = Array.isArray(factRecord.citations)
            ? factRecord.citations
                .flatMap((citation) => {
                  const normalized = normalizeCitation(citation);

                  return normalized ? [normalized] : [];
                })
                .slice(0, VOICE_WEB_SEARCH_CLAIM_CITATION_MAX_ITEMS)
            : [];

          return [{ text, citations: factCitations }];
        })
        .slice(0, VOICE_WEB_SEARCH_FACT_LIST_MAX_ITEMS)
    : [];

  return {
    summary,
    confidence:
      confidence === "high" || confidence === "medium" || confidence === "low" || confidence === "unverified"
        ? confidence
        : "low",
    facts,
    citations,
    caveat: nullableNonEmptyString(cleanText({ value: record.caveat, maxLength: VOICE_WEB_SEARCH_CAVEAT_MAX_LENGTH })),
  };
}

function normalizeConfidence(value: unknown): VoiceWebSearchAnswer["confidence"] {
  const confidence = cleanText({ value, maxLength: VOICE_WEB_SEARCH_STATUS_MAX_LENGTH }).toLowerCase();
  if (confidence === "high" || confidence === "medium" || confidence === "low" || confidence === "unverified") {
    return confidence;
  }

  return "unverified";
}

function normalizeCitationCoverage(value: unknown): VoiceWebAnswerDisplay["citationCoverage"] {
  const coverage = cleanText({ value, maxLength: VOICE_WEB_SEARCH_STATUS_MAX_LENGTH }).toLowerCase();
  if (coverage === "complete" || coverage === "partial" || coverage === "missing") {
    return coverage;
  }

  return "missing";
}

function normalizeDisplayCitation(value: unknown): VoiceWebAnswerDisplay["citations"][number] | null {
  if (!isRecord(value)) {
    return null;
  }
  const record = value;
  const url = safeHttpUrl(record.url);
  const id = cleanText({ value: record.id, maxLength: VOICE_WEB_SEARCH_CITATION_ID_MAX_LENGTH });
  if (url === null || id === "") {
    return null;
  }

  return {
    id,
    label: coalesceNonEmptyStrings({
      candidates: [
        cleanText({ value: record.label, maxLength: VOICE_WEB_SEARCH_DISPLAY_LABEL_MAX_LENGTH }),
        cleanText({ value: record.domain, maxLength: VOICE_WEB_SEARCH_BOLD_ITEM_MAX_LENGTH }),
        domainFromUrl(url),
        VOICE_WEB_SEARCH_DEFAULT_SOURCE_LABEL,
      ],
      fallback: VOICE_WEB_SEARCH_DEFAULT_SOURCE_LABEL,
    }),
    title: coalesceNonEmptyStrings({
      candidates: [
        cleanText({ value: record.title, maxLength: VOICE_WEB_SEARCH_TITLE_MAX_LENGTH }),
        domainFromUrl(url),
        url,
      ],
      fallback: url,
    }),
    url,
    domain: coalesceNonEmptyStrings({
      candidates: [
        cleanText({ value: record.domain, maxLength: VOICE_WEB_SEARCH_DOMAIN_MAX_LENGTH }),
        domainFromUrl(url),
      ],
      fallback: domainFromUrl(url) ?? "",
    }),
  };
}

function normalizeDisplayText(value: unknown): VoiceWebAnswerDisplayText | null {
  if (!isRecord(value)) {
    return null;
  }
  const record = value;
  const text = cleanText({ value: record.text, maxLength: VOICE_WEB_SEARCH_DISPLAY_TEXT_MAX_LENGTH });
  if (text === "") {
    return null;
  }
  const bold = Array.isArray(record.bold)
    ? record.bold
        .map((item) => cleanText({ value: item, maxLength: VOICE_WEB_SEARCH_BOLD_ITEM_MAX_LENGTH }))
        .filter((item) => Boolean(item) && text.includes(item) && text.indexOf(item) === text.lastIndexOf(item))
        .slice(0, VOICE_WEB_SEARCH_BOLD_MAX_ITEMS)
    : [];
  const citationIds = Array.isArray(record.citationIds)
    ? record.citationIds
        .map((item) => cleanText({ value: item, maxLength: VOICE_WEB_SEARCH_BOLD_ITEM_MAX_LENGTH }))
        .filter(Boolean)
        .slice(0, VOICE_WEB_SEARCH_CITATION_ID_LIST_MAX_ITEMS)
    : Array.isArray(record.citation_ids)
      ? record.citation_ids
          .map((item) => cleanText({ value: item, maxLength: VOICE_WEB_SEARCH_BOLD_ITEM_MAX_LENGTH }))
          .filter(Boolean)
          .slice(0, VOICE_WEB_SEARCH_CITATION_ID_LIST_MAX_ITEMS)
      : [];

  return {
    text,
    bold,
    citationIds,
  };
}

function normalizeAnswerDisplay(value: unknown): VoiceWebAnswerDisplay | null {
  if (!isRecord(value)) {
    return null;
  }
  const record = value;
  const lead = cleanText({ value: record.lead, maxLength: VOICE_WEB_SEARCH_DISPLAY_LEAD_MAX_LENGTH });
  if (lead === "") {
    return null;
  }
  const citations = Array.isArray(record.citations)
    ? record.citations
        .flatMap((citation) => {
          const normalized = normalizeDisplayCitation(citation);

          return normalized ? [normalized] : [];
        })
        .slice(0, VOICE_WEB_SEARCH_DISPLAY_CITATION_MAX_ITEMS)
    : [];
  const citationIds = new Set(citations.map((citation) => citation.id));
  const sections = Array.isArray(record.sections)
    ? record.sections
        .flatMap((section) => {
          if (!isRecord(section)) {
            return [];
          }
          const sectionRecord = section;
          const bullets = Array.isArray(sectionRecord.bullets)
            ? sectionRecord.bullets
                .flatMap((item) => {
                  const normalized = normalizeDisplayText(item);

                  return normalized
                    ? [
                        {
                          ...normalized,
                          citationIds: normalized.citationIds
                            .filter((id) => citationIds.has(id))
                            .slice(0, VOICE_WEB_SEARCH_SECTION_CITATION_MAX_ITEMS),
                        },
                      ]
                    : [];
                })
                .slice(0, VOICE_WEB_SEARCH_SECTION_CONTENT_MAX_ITEMS)
            : [];
          const paragraphs = Array.isArray(sectionRecord.paragraphs)
            ? sectionRecord.paragraphs
                .flatMap((item) => {
                  const normalized = normalizeDisplayText(item);

                  return normalized
                    ? [
                        {
                          ...normalized,
                          citationIds: normalized.citationIds
                            .filter((id) => citationIds.has(id))
                            .slice(0, VOICE_WEB_SEARCH_SECTION_CITATION_MAX_ITEMS),
                        },
                      ]
                    : [];
                })
                .slice(0, VOICE_WEB_SEARCH_SECTION_CONTENT_MAX_ITEMS)
            : [];
          const heading = nullableNonEmptyString(
            cleanText({ value: sectionRecord.heading, maxLength: VOICE_WEB_SEARCH_DISPLAY_HEADING_MAX_LENGTH }),
          );
          if (heading === null && bullets.length === 0 && paragraphs.length === 0) {
            return [];
          }

          return [
            {
              heading,
              bullets,
              paragraphs,
            },
          ];
        })
        .slice(0, VOICE_WEB_SEARCH_SECTION_MAX_ITEMS)
    : [];

  return {
    lead,
    confidence: normalizeConfidence(record.confidence),
    citationCoverage: normalizeCitationCoverage(record.citationCoverage ?? record.citation_coverage),
    sections,
    citations,
  };
}

function normalizeVoiceResearchCitationList(value: unknown): VoiceWebSearchCitation[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .flatMap((citation) => {
      if (!isRecord(citation)) {
        return [];
      }
      const citationRecord = citation;
      const url = safeHttpUrl(citationRecord.url);
      if (url === null) {
        return [];
      }

      return [
        {
          title: coalesceNonEmptyStrings({
            candidates: [
              cleanText({ value: citationRecord.title, maxLength: VOICE_WEB_SEARCH_TITLE_MAX_LENGTH }),
              domainFromUrl(url),
              url,
            ],
            fallback: url,
          }),
          url,
          domain: coalesceNonEmptyStrings({
            candidates: [
              cleanText({ value: citationRecord.publisher, maxLength: VOICE_WEB_SEARCH_DOMAIN_MAX_LENGTH }),
              domainFromUrl(url),
            ],
            fallback: domainFromUrl(url) ?? "",
          }),
          excerpt: cleanText({
            value: citationRecord.quote_or_excerpt,
            maxLength: VOICE_WEB_SEARCH_EXCERPT_MAX_LENGTH,
          }),
        },
      ];
    })
    .slice(0, VOICE_WEB_SEARCH_PARTIAL_CITATION_MAX_ITEMS);
}

function voiceResearchCitationById(input: {
  rawCitations: unknown;
  citations: VoiceWebSearchCitation[];
}): Map<string, VoiceWebSearchCitation> {
  const citationById = new Map<string, VoiceWebSearchCitation>();
  if (!Array.isArray(input.rawCitations)) {
    return citationById;
  }
  input.rawCitations.forEach((citation, index) => {
    if (!isRecord(citation)) {
      return;
    }
    const citationRecord = citation;
    const cleanedId = cleanText({ value: citationRecord.id, maxLength: VOICE_WEB_SEARCH_CITATION_ID_MAX_LENGTH });
    const id = cleanedId !== "" ? cleanedId : `c${index + 1}`;
    const normalized = input.citations[index];
    if (normalized) {
      citationById.set(id, normalized);
    }
  });

  return citationById;
}

function normalizeVoiceResearchClaims(input: {
  claims: unknown;
  citationById: Map<string, VoiceWebSearchCitation>;
}): VoiceWebSearchAnswer["facts"] {
  if (!Array.isArray(input.claims)) {
    return [];
  }

  return input.claims
    .flatMap((claim) => {
      if (!isRecord(claim)) {
        return [];
      }
      const claimRecord = claim;
      const text = cleanText({ value: claimRecord.text, maxLength: VOICE_WEB_SEARCH_FACT_TEXT_MAX_LENGTH });
      const citationIds = Array.isArray(claimRecord.citation_ids)
        ? claimRecord.citation_ids
            .map((id) => cleanText({ value: id, maxLength: VOICE_WEB_SEARCH_CITATION_ID_MAX_LENGTH }))
            .filter(Boolean)
        : [];
      if (text === "") {
        return [];
      }

      return [
        {
          text,
          citations: citationIds
            .flatMap((id) => {
              const citation = input.citationById.get(id);

              return citation ? [citation] : [];
            })
            .slice(0, VOICE_WEB_SEARCH_CLAIM_CITATION_MAX_ITEMS),
        },
      ];
    })
    .slice(0, VOICE_WEB_SEARCH_FACT_LIST_MAX_ITEMS);
}

function normalizeVoiceResearchPartialAnswer(value: unknown): VoiceWebSearchAnswer | null {
  if (!isRecord(value)) {
    return null;
  }
  const record = value;
  if ("summary" in record || "facts" in record) {
    return normalizeAnswer(value);
  }
  const citations = normalizeVoiceResearchCitationList(record.citations);
  const citationById = voiceResearchCitationById({ rawCitations: record.citations, citations });
  const facts = normalizeVoiceResearchClaims({ claims: record.claims, citationById });
  const summary = cleanText({
    value: record.answer_brief ?? record.spoken_answer,
    maxLength: VOICE_WEB_SEARCH_SUMMARY_MAX_LENGTH,
  });
  if (summary === "") {
    return null;
  }
  const confidence = cleanText({
    value: record.confidence,
    maxLength: VOICE_WEB_SEARCH_STATUS_MAX_LENGTH,
  }).toLowerCase();
  const caveats = Array.isArray(record.caveats)
    ? record.caveats
        .map((item) => cleanText({ value: item, maxLength: VOICE_WEB_SEARCH_CAVEAT_MAX_LENGTH }))
        .filter(Boolean)
    : [];

  return {
    summary,
    confidence:
      confidence === "high" || confidence === "medium" || confidence === "low" || confidence === "unverified"
        ? confidence
        : "low",
    facts,
    citations,
    caveat: caveats[0] ?? null,
  };
}

function normalizeProgressStep(value: unknown): VoiceWebSearchProgressStep | null {
  if (!isRecord(value)) {
    return null;
  }
  const record = value;
  const message = cleanText({ value: record.message, maxLength: VOICE_WEB_SEARCH_PROGRESS_MESSAGE_MAX_LENGTH });
  const phase = cleanText({ value: record.phase, maxLength: VOICE_WEB_SEARCH_PROGRESS_PHASE_MAX_LENGTH });
  if (message === "" && phase === "") {
    return null;
  }

  return {
    id: nullableNonEmptyString(cleanText({ value: record.id, maxLength: VOICE_WEB_SEARCH_PROGRESS_ID_MAX_LENGTH })),
    phase: nullableNonEmptyString(phase),
    source: nullableNonEmptyString(
      cleanText({ value: record.source, maxLength: VOICE_WEB_SEARCH_PROGRESS_PHASE_MAX_LENGTH }),
    ),
    message: nullableNonEmptyString(message),
    at: nullableNonEmptyString(cleanText({ value: record.at, maxLength: VOICE_WEB_SEARCH_PROGRESS_PHASE_MAX_LENGTH })),
  };
}

function normalizeStats(value: unknown): Record<string, number | string | null> {
  if (!isRecord(value)) {
    return {};
  }
  const stats: Record<string, number | string | null> = {};
  Object.entries(value).forEach(([key, rawValue]) => {
    if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
      stats[key] = rawValue;
    } else if (typeof rawValue === "string") {
      const text = cleanText({ value: rawValue, maxLength: VOICE_WEB_SEARCH_STATS_TEXT_MAX_LENGTH });
      if (text !== "") {
        stats[key] = text;
      }
    } else if (rawValue === null) {
      stats[key] = null;
    }
  });

  return stats;
}

function normalizeActiveSource(value: unknown): VoiceWebSearchActiveSource | null {
  if (!isRecord(value)) {
    return null;
  }
  const record = value;
  const url = safeHttpUrl(record.url);
  if (url === null) {
    return null;
  }

  return {
    title: nullableNonEmptyString(cleanText({ value: record.title, maxLength: VOICE_WEB_SEARCH_TITLE_MAX_LENGTH })),
    url,
    domain: coalesceNonEmptyStrings({
      candidates: [
        cleanText({ value: record.domain, maxLength: VOICE_WEB_SEARCH_DOMAIN_MAX_LENGTH }),
        domainFromUrl(url),
      ],
      fallback: domainFromUrl(url) ?? "",
    }),
  };
}

function normalizeSignal(value: unknown): VoiceWebSearchSignal | null {
  if (!isRecord(value)) {
    return null;
  }
  const record = value;
  const text = cleanText({ value: record.text, maxLength: VOICE_WEB_SEARCH_SIGNAL_TEXT_MAX_LENGTH });
  const citationIds = Array.isArray(record.citationIds)
    ? record.citationIds
        .map((id) => cleanText({ value: id, maxLength: VOICE_WEB_SEARCH_CITATION_ID_MAX_LENGTH }))
        .filter(Boolean)
    : Array.isArray(record.citation_ids)
      ? record.citation_ids
          .map((id) => cleanText({ value: id, maxLength: VOICE_WEB_SEARCH_CITATION_ID_MAX_LENGTH }))
          .filter(Boolean)
      : [];
  if (text === "" || citationIds.length === 0) {
    return null;
  }

  return {
    text,
    citationIds: citationIds.slice(0, VOICE_WEB_SEARCH_SIGNAL_CITATION_MAX_ITEMS),
  };
}

function progressPayloadIsEmpty(input: {
  message: string;
  statusLabel: string;
  phase: string;
  historyLength: number;
  activeSourcesLength: number;
  signalsLength: number;
}): boolean {
  return (
    input.message === "" &&
    input.statusLabel === "" &&
    input.phase === "" &&
    input.historyLength === 0 &&
    input.activeSourcesLength === 0 &&
    input.signalsLength === 0
  );
}

function normalizeVoiceWebSearchResults(value: unknown): VoiceWebSearchPanelPayload["results"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .flatMap((result) => {
      const normalized = normalizeResult(result);

      return normalized ? [normalized] : [];
    })
    .slice(0, VOICE_WEB_SEARCH_RESULT_LIST_MAX_ITEMS);
}

function normalizeProgress(value: unknown): VoiceWebSearchProgress | null {
  if (!isRecord(value)) {
    return null;
  }
  const record = value;
  const steps = Array.isArray(record.steps)
    ? record.steps
        .flatMap((item) => {
          const normalized = normalizeProgressStep(item);

          return normalized ? [normalized] : [];
        })
        .slice(-VOICE_WEB_SEARCH_PROGRESS_STEP_MAX_ITEMS)
    : [];
  const historySource = Array.isArray(record.history) ? record.history : steps;
  const history = historySource
    .flatMap((item) => {
      const normalized = normalizeProgressStep(item);

      return normalized
        ? [
            {
              phase: normalized.phase,
              message: normalized.message,
              at: normalized.at,
            },
          ]
        : [];
    })
    .slice(-VOICE_WEB_SEARCH_PROGRESS_HISTORY_MAX_ITEMS);
  const message = cleanText({ value: record.message, maxLength: VOICE_WEB_SEARCH_CAVEAT_MAX_LENGTH });
  const statusLabel = cleanText({
    value: record.statusLabel,
    maxLength: VOICE_WEB_SEARCH_PROGRESS_STATUS_LABEL_MAX_LENGTH,
  });
  const detail = cleanText({ value: record.detail, maxLength: VOICE_WEB_SEARCH_PROGRESS_DETAIL_MAX_LENGTH });
  const phase = cleanText({ value: record.phase, maxLength: VOICE_WEB_SEARCH_PROGRESS_PHASE_MAX_LENGTH });
  const elapsedMs =
    typeof record.elapsedMs === "number" && Number.isFinite(record.elapsedMs)
      ? Math.max(0, Math.trunc(record.elapsedMs))
      : null;
  const percent =
    typeof record.percent === "number" && Number.isFinite(record.percent)
      ? Math.max(0, Math.min(VOICE_WEB_SEARCH_PERCENT_MAX, Math.round(record.percent)))
      : null;
  const activeSources = Array.isArray(record.activeSources)
    ? record.activeSources
        .flatMap((item) => {
          const normalized = normalizeActiveSource(item);

          return normalized ? [normalized] : [];
        })
        .slice(0, VOICE_WEB_SEARCH_ACTIVE_SOURCE_MAX_ITEMS)
    : [];
  const signals = Array.isArray(record.signals)
    ? record.signals
        .flatMap((item) => {
          const normalized = normalizeSignal(item);

          return normalized ? [normalized] : [];
        })
        .slice(0, VOICE_WEB_SEARCH_SIGNAL_MAX_ITEMS)
    : [];
  const stats = normalizeStats(record.stats);
  const partialAnswer = normalizeVoiceResearchPartialAnswer(record.partialAnswer ?? record.partial_answer);
  if (
    progressPayloadIsEmpty({
      message,
      statusLabel,
      phase,
      historyLength: history.length,
      activeSourcesLength: activeSources.length,
      signalsLength: signals.length,
    })
  ) {
    return null;
  }

  return {
    phase: nullableNonEmptyString(phase),
    statusLabel: nullableNonEmptyString(statusLabel),
    message: nullableNonEmptyString(message),
    detail: nullableNonEmptyString(detail),
    elapsedMs,
    percent,
    steps,
    stats,
    activeSources,
    signals,
    partialAnswer,
    history,
  };
}

function normalizeSourceResult(record: Record<string, unknown>): VoiceWebSearchSourceResult | null {
  const title = cleanText({ value: record.title, maxLength: VOICE_WEB_SEARCH_TITLE_MAX_LENGTH });
  const url = safeHttpUrl(record.url);
  if (title === "" || url === null) {
    return null;
  }

  return {
    kind: "source",
    title,
    url,
    publishDate: nullableNonEmptyString(
      cleanText({ value: record.publishDate ?? record.publish_date, maxLength: VOICE_WEB_SEARCH_BOLD_ITEM_MAX_LENGTH }),
    ),
    domain: coalesceNonEmptyStrings({
      candidates: [
        cleanText({ value: record.domain, maxLength: VOICE_WEB_SEARCH_DOMAIN_MAX_LENGTH }),
        domainFromUrl(url),
      ],
      fallback: domainFromUrl(url) ?? "",
    }),
    excerpt: cleanText({ value: record.excerpt, maxLength: VOICE_WEB_SEARCH_RESULT_EXCERPT_MAX_LENGTH }),
  };
}

function normalizeEntityResult(record: Record<string, unknown>): VoiceWebSearchEntityResult | null {
  const name = cleanText({ value: record.name ?? record.title, maxLength: VOICE_WEB_SEARCH_TITLE_MAX_LENGTH });
  const url = safeHttpUrl(record.url);
  if (name === "" || url === null) {
    return null;
  }
  const citations = Array.isArray(record.citations)
    ? record.citations
        .flatMap((citation) => {
          const normalized = normalizeCitation(citation);

          return normalized ? [normalized] : [];
        })
        .slice(0, VOICE_WEB_SEARCH_CITATION_LIST_MAX_ITEMS)
    : [];
  const description = cleanText({
    value: record.description ?? record.excerpt,
    maxLength: VOICE_WEB_SEARCH_RESULT_EXCERPT_MAX_LENGTH,
  });

  return {
    kind: "entity",
    entityType: normalizeEntityType(record.entityType ?? record.entity_type),
    name,
    title: name,
    url,
    domain: coalesceNonEmptyStrings({
      candidates: [
        cleanText({ value: record.domain, maxLength: VOICE_WEB_SEARCH_DOMAIN_MAX_LENGTH }),
        domainFromUrl(url),
      ],
      fallback: domainFromUrl(url) ?? "",
    }),
    description,
    excerpt: cleanText({ value: record.excerpt ?? description, maxLength: VOICE_WEB_SEARCH_RESULT_EXCERPT_MAX_LENGTH }),
    matchStatus: nullableNonEmptyString(
      cleanText({
        value: record.matchStatus ?? record.match_status,
        maxLength: VOICE_WEB_SEARCH_PROGRESS_PHASE_MAX_LENGTH,
      }),
    ),
    reasons: normalizeStringList({
      value: record.reasons,
      maxItems: VOICE_WEB_SEARCH_REASONS_MAX_ITEMS,
      maxLength: VOICE_WEB_SEARCH_REASON_MAX_LENGTH,
    }),
    citations,
  };
}

function normalizeResult(value: unknown): VoiceWebSearchResult | null {
  if (!isRecord(value)) {
    return null;
  }
  const record = value;
  const recordName = typeof record.name === "string" ? record.name : "";
  if (
    cleanText({ value: record.kind, maxLength: VOICE_WEB_SEARCH_STATUS_MAX_LENGTH }).toLowerCase() === "entity" ||
    recordName !== ""
  ) {
    return normalizeEntityResult(record);
  }

  return normalizeSourceResult(record);
}

function unreadableVoiceWebSearchPayload(): VoiceWebSearchPanelPayload {
  return {
    status: "error",
    mode: null,
    researchMode: null,
    query: "",
    researchRunId: null,
    searchId: null,
    sessionId: null,
    findallId: null,
    entityType: null,
    answer: null,
    answerDisplay: null,
    results: [],
    progress: null,
    message: VOICE_WEB_SEARCH_UNREADABLE_MESSAGE,
    answerPreview: null,
    tinyCitations: [],
    googleSearchQueries: [],
    googleSearchSuggestionsHtml: null,
    deepResearchAvailable: false,
    shouldAskToDeepen: false,
    deepResearchAutoStarted: false,
    deepResearchRunId: null,
    meetingId: null,
    requestingUserId: null,
  };
}

function normalizeTinyCitations(value: unknown): VoiceWebSearchCitation[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .flatMap((citation) => {
      const normalized = normalizeCitation(citation);

      return normalized ? [normalized] : [];
    })
    .slice(0, VOICE_WEB_SEARCH_CITATION_LIST_MAX_ITEMS);
}

function buildVoiceWebSearchPanelPayloadFromRecord(parsed: Record<string, unknown>): VoiceWebSearchPanelPayload {
  const results = normalizeVoiceWebSearchResults(parsed.results);
  const answer = normalizeAnswer(parsed.answer);
  const tinyCitations = normalizeTinyCitations(parsed.tinyCitations);

  return {
    ...(parsed.contentKind === "meeting-answer" ? { contentKind: "meeting-answer" as const } : {}),
    status: normalizeStatus(parsed.status),
    mode: normalizeMode(parsed.mode),
    researchMode: normalizeResearchMode(parsed.researchMode ?? parsed.research_mode),
    query: cleanText({
      value: cleanText({ value: parsed.query, maxLength: VOICE_WEB_SEARCH_QUERY_NORMALIZE_MAX_LENGTH }),
      maxLength: VOICE_WEB_SEARCH_QUERY_FIELD_MAX_LENGTH,
    }),
    researchRunId: nullableNonEmptyString(
      cleanText({
        value: parsed.researchRunId ?? parsed.research_run_id,
        maxLength: VOICE_WEB_SEARCH_ID_FIELD_MAX_LENGTH,
      }),
    ),
    searchId: nullableNonEmptyString(
      cleanText({ value: parsed.searchId ?? parsed.search_id, maxLength: VOICE_WEB_SEARCH_ID_FIELD_MAX_LENGTH }),
    ),
    sessionId: nullableNonEmptyString(
      cleanText({ value: parsed.sessionId ?? parsed.session_id, maxLength: VOICE_WEB_SEARCH_ID_FIELD_MAX_LENGTH }),
    ),
    findallId: nullableNonEmptyString(
      cleanText({ value: parsed.findallId ?? parsed.findall_id, maxLength: VOICE_WEB_SEARCH_ID_FIELD_MAX_LENGTH }),
    ),
    entityType:
      parsed.entityType !== undefined || parsed.entity_type !== undefined
        ? normalizeEntityType(parsed.entityType ?? parsed.entity_type)
        : null,
    answer,
    answerDisplay: normalizeAnswerDisplay(parsed.answerDisplay ?? parsed.answer_display),
    results,
    progress: normalizeProgress(parsed.progress),
    message: nullableNonEmptyString(
      cleanText({ value: parsed.message, maxLength: VOICE_WEB_SEARCH_QUERY_FIELD_MAX_LENGTH }),
    ),
    answerPreview: nullableNonEmptyString(
      cleanText({ value: parsed.answerPreview, maxLength: VOICE_WEB_SEARCH_SUMMARY_MAX_LENGTH }),
    ),
    tinyCitations,
    googleSearchQueries: normalizeStringList({
      value: parsed.googleSearchQueries,
      maxItems: VOICE_WEB_SEARCH_GOOGLE_QUERY_MAX_ITEMS,
      maxLength: VOICE_WEB_SEARCH_GOOGLE_QUERY_MAX_LENGTH,
    }),
    googleSearchSuggestionsHtml:
      typeof parsed.googleSearchSuggestionsHtml === "string"
        ? parsed.googleSearchSuggestionsHtml.slice(0, VOICE_WEB_SEARCH_SUGGESTIONS_HTML_MAX_LENGTH)
        : null,
    deepResearchAvailable: parsed.deepResearchAvailable === true,
    shouldAskToDeepen: parsed.shouldAskToDeepen === true,
    deepResearchAutoStarted: parsed.deepResearchAutoStarted === true,
    deepResearchRunId: nullableNonEmptyString(
      cleanText({ value: parsed.deepResearchRunId, maxLength: VOICE_WEB_SEARCH_ID_FIELD_MAX_LENGTH }),
    ),
    meetingId: nullableNonEmptyString(
      cleanText({ value: parsed.meetingId, maxLength: VOICE_WEB_SEARCH_ID_FIELD_MAX_LENGTH }),
    ),
    requestingUserId: nullableNonEmptyString(
      cleanText({ value: parsed.requestingUserId, maxLength: VOICE_WEB_SEARCH_ID_FIELD_MAX_LENGTH }),
    ),
  };
}

const voiceWebSearchPanelPayloadRecordSchema = z.object({}).passthrough();

export function parseVoiceWebSearchPanelPayload(payload: string): VoiceWebSearchPanelPayload {
  try {
    const parsed = voiceWebSearchPanelPayloadRecordSchema.safeParse(JSON.parse(payload));
    if (!parsed.success) {
      return unreadableVoiceWebSearchPayload();
    }

    return buildVoiceWebSearchPanelPayloadFromRecord(parsed.data);
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    return unreadableVoiceWebSearchPayload();
  }
}

export function isStaleVoiceWebSearchProgress(
  ...args: [current: VoiceWebSearchPanelPayload | null, incoming: VoiceWebSearchPanelPayload]
): boolean {
  const [current, incoming] = args;

  return (
    current?.status === "completed" &&
    incoming.status === "partial" &&
    voiceWebSearchPayloadMatchesCurrentNamed({ current, incoming })
  );
}
