import type { MeetingAmbientContextItem } from "@readymeet/shared";

import {
  ambientContextItemHasReadableResult,
  ambientContextPillPresentation,
  ambientContextPillTimestamp,
  type AmbientContextViewItem,
} from "./ambient-context-view";
import { voiceWebSearchHasReadableResult, type VoiceWebSearchPanelPayload } from "./voice-web-search";

export type WebSearchPanelState = VoiceWebSearchPanelPayload & {
  updatedAt: number;
};

export type RelevantDetailsHistoryItem =
  | {
      key: string;
      kind: "ambient";
      occurredAt: number;
      title: string;
      item: AmbientContextViewItem;
    }
  | {
      key: string;
      kind: "web-search";
      occurredAt: number;
      title: string;
      state: WebSearchPanelState;
    };

function ambientRelevantDetailsKey(itemId: string): string {
  return `ambient:${itemId}`;
}

export function webSearchRelevantDetailsKey(state: WebSearchPanelState): string {
  return `web-search:${webSearchPayloadKey(state)}`;
}

export function upsertWebSearchHistory(input: {
  history: WebSearchPanelState[];
  nextState: WebSearchPanelState;
}): WebSearchPanelState[] {
  const nextKey = webSearchPayloadKey(input.nextState);

  return [input.nextState, ...input.history.filter((state) => webSearchPayloadKey(state) !== nextKey)].sort(
    (left, right) => right.updatedAt - left.updatedAt,
  );
}

export function relevantDetailsHistoryItems(input: {
  ambientItems: MeetingAmbientContextItem[];
  webSearchItems: WebSearchPanelState[];
}): RelevantDetailsHistoryItem[] {
  return [
    ...input.ambientItems.map(
      (item): RelevantDetailsHistoryItem => ({
        key: ambientRelevantDetailsKey(item.id),
        kind: "ambient",
        occurredAt: ambientContextPillTimestamp(item),
        title: item.displayName,
        item,
      }),
    ),
    ...input.webSearchItems.map(
      (state): RelevantDetailsHistoryItem => ({
        key: webSearchRelevantDetailsKey(state),
        kind: "web-search",
        occurredAt: state.updatedAt,
        title: capitalizeLeadingLetter(state.query),
        state,
      }),
    ),
  ].sort((left, right) => right.occurredAt - left.occurredAt);
}

const MAX_WEB_RESEARCH_QUERY_KEY_LENGTH = 260;

export function webResearchQueryKey(query: string): string {
  return query
    .toLowerCase()
    .replace(/\bplease\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_WEB_RESEARCH_QUERY_KEY_LENGTH);
}

function webSearchDurablePayloadId(payload: VoiceWebSearchPanelPayload): string | null {
  const searchId = payload.searchId;
  if (searchId !== "") {
    return searchId;
  }
  const researchRunId = payload.researchRunId;
  if (researchRunId !== "") {
    return researchRunId;
  }
  const findallId = payload.findallId;
  if (findallId !== "") {
    return findallId;
  }

  return null;
}

export function webSearchPayloadKey(payload: VoiceWebSearchPanelPayload): string {
  return webSearchDurablePayloadId(payload) ?? `query:${webResearchQueryKey(payload.query)}`;
}

export function capitalizeLeadingLetter(text: string): string {
  return text.replace(
    /^(\s*[^A-Za-z0-9]*)([a-z])/,
    (_match, prefix: string, letter: string) => `${prefix}${letter.toUpperCase()}`,
  );
}

export type RelevantDetailsWebResult = { key: string; label: string; updatedAt: number };
export type RelevantDetailsPresentation = {
  key: string;
  selectionKey: string;
  presentation: { phase: "loading" | "result"; label: string; subjectId: string };
  item: MeetingAmbientContextItem | null;
  isWebSearch: boolean;
  resultVersion: string | null;
};

export function ambientResultVersion(item: MeetingAmbientContextItem): string | null {
  // Legacy results without a completion timestamp have one stable baseline.
  // Mentions and image updates must not look like newly completed research.
  return ambientContextItemHasReadableResult(item) ? (item.researchCompletedAt ?? "initial") : null;
}

/** One subject-choice rule for the pill and the open panel. */
export function relevantDetailsPresentation(input: {
  items: MeetingAmbientContextItem[];
  web: RelevantDetailsWebResult | null;
}): RelevantDetailsPresentation | null {
  const presentation = ambientContextPillPresentation(input.items);
  const ambient = input.items.find((item) => item.id === presentation?.subjectId);
  const ambientTimestamp = ambient === undefined ? 0 : ambientContextPillTimestamp(ambient);
  if (input.web !== null && input.web.updatedAt >= ambientTimestamp) {
    return {
      key: `web-search:${input.web.label}:${input.web.key}`,
      selectionKey: input.web.key,
      presentation: { phase: "result", label: input.web.label, subjectId: input.web.key },
      item: null,
      isWebSearch: true,
      resultVersion: input.web.key,
    };
  }

  return ambient !== undefined && presentation !== null
    ? {
        key: `ambient:${ambient.id}:${ambient.displayName}`,
        selectionKey: ambientRelevantDetailsKey(ambient.id),
        presentation,
        item: ambient,
        isWebSearch: false,
        resultVersion: ambientResultVersion(ambient),
      }
    : null;
}

export function latestReadableWebResult(items: (WebSearchPanelState | null)[]): RelevantDetailsWebResult | null {
  const web = items.reduce<WebSearchPanelState | null>(
    (latest, item) =>
      item !== null && voiceWebSearchHasReadableResult(item) && (latest === null || item.updatedAt > latest.updatedAt)
        ? item
        : latest,
    null,
  );

  return web !== null
    ? { key: webSearchRelevantDetailsKey(web), label: capitalizeLeadingLetter(web.query), updatedAt: web.updatedAt }
    : null;
}

export function latestRelevantDetailsKey(input: {
  items: MeetingAmbientContextItem[];
  webSearchItems: WebSearchPanelState[];
  expiredItemIds: Set<string>;
}): string | null {
  return (
    relevantDetailsPresentation({
      items: input.items.filter(
        (item) => !input.expiredItemIds.has(item.id) || ambientContextItemHasReadableResult(item),
      ),
      web: latestReadableWebResult(input.webSearchItems),
    })?.selectionKey ?? null
  );
}

/** Metadata updates must not interrupt someone reading a history entry. */
export function relevantDetailsResultVersion(item: RelevantDetailsHistoryItem | undefined): string | null {
  return item !== undefined
    ? `${item.key}:${item.kind === "ambient" ? (ambientResultVersion(item.item) ?? "loading") : item.key}`
    : null;
}
