import type { MeetingTaskCandidate } from "@readymeet/shared";

const MAX_TRANSCRIPT_DISTANCE = 3;
const MAX_SEMANTIC_TIME_DISTANCE_MS = 45_000;
const MIN_SHARED_EVIDENCE_TOKENS = 2;
const MIN_EVIDENCE_TOKEN_LENGTH = 3;
const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "are",
  "because",
  "been",
  "before",
  "being",
  "but",
  "can",
  "could",
  "does",
  "for",
  "from",
  "have",
  "here",
  "into",
  "its",
  "just",
  "like",
  "make",
  "more",
  "need",
  "not",
  "our",
  "out",
  "please",
  "should",
  "that",
  "the",
  "their",
  "then",
  "there",
  "they",
  "this",
  "those",
  "through",
  "too",
  "use",
  "want",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
  "you",
  "your",
]);

export type TaskAssetLinkingSegment = {
  id: string;
  startedAt: Date;
  content: string;
};

export type TaskAssetLinkingAsset = {
  id: string;
  transcriptSegmentIds: string[];
  transcriptExcerpt: string | null;
  capturedAt: Date;
};

type TaskAssetLinkingCandidate = Pick<MeetingTaskCandidate, "title" | "description" | "sourceQuotes">;

function evidenceTokens(value: string) {
  return new Set(
    value
      .toLocaleLowerCase("en-US")
      .replace(/[^a-z0-9@._-]+/g, " ")
      .split(/\s+/)
      .map((token) => token.replace(/^[._-]+|[._-]+$/g, ""))
      .filter((token) => token.length >= MIN_EVIDENCE_TOKEN_LENGTH && !STOP_WORDS.has(token)),
  );
}

function hasGroundedTextOverlap({
  candidate,
  excerpt,
}: {
  candidate: TaskAssetLinkingCandidate;
  excerpt: string | null;
}) {
  if (excerpt === null || excerpt.length === 0) {
    return false;
  }
  const taskTokens = evidenceTokens(
    [candidate.title, candidate.description ?? "", ...candidate.sourceQuotes.map((quote) => quote.quote)].join(" "),
  );
  const excerptTokens = evidenceTokens(excerpt);
  const sharedCount = [...excerptTokens].filter((token) => taskTokens.has(token)).length;

  return sharedCount >= MIN_SHARED_EVIDENCE_TOKENS;
}

function candidateEvidenceTimes({
  candidate,
  segmentById,
}: {
  candidate: TaskAssetLinkingCandidate;
  segmentById: Map<string, TaskAssetLinkingSegment>;
}): number[] {
  return candidate.sourceQuotes.flatMap((quote) => {
    const segmentTime =
      quote.segmentId !== null && quote.segmentId !== undefined && quote.segmentId.length !== 0
        ? segmentById.get(quote.segmentId)?.startedAt.getTime()
        : undefined;
    if (segmentTime !== undefined && Number.isFinite(segmentTime)) {
      return [segmentTime];
    }
    const quoteTime =
      quote.timestamp !== null && quote.timestamp.length !== 0 ? Date.parse(quote.timestamp) : Number.NaN;

    return Number.isFinite(quoteTime) ? [quoteTime] : [];
  });
}

export function assetIdsForTaskCandidate({
  candidate,
  assets,
  segments,
}: {
  candidate: TaskAssetLinkingCandidate;
  assets: TaskAssetLinkingAsset[];
  segments: TaskAssetLinkingSegment[];
}): string[] {
  const segmentIndexById = new Map(segments.map((segment, index) => [segment.id, index]));
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
  const sourceSegmentIds = candidate.sourceQuotes
    .map((quote) => quote.segmentId)
    .filter((id): id is string => Boolean(id));
  const sourceIndexes = sourceSegmentIds
    .map((id) => segmentIndexById.get(id))
    .filter((index): index is number => index !== undefined);
  const evidenceTimes = candidateEvidenceTimes({ candidate, segmentById });

  return assets
    .filter((asset) => {
      const hasTextOverlap = hasGroundedTextOverlap({ candidate, excerpt: asset.transcriptExcerpt });
      if (asset.transcriptSegmentIds.some((id) => sourceSegmentIds.includes(id))) {
        return hasTextOverlap;
      }

      const assetIndexes = asset.transcriptSegmentIds
        .map((id) => segmentIndexById.get(id))
        .filter((index): index is number => index !== undefined);
      if (
        sourceIndexes.some((sourceIndex) =>
          assetIndexes.some((assetIndex) => Math.abs(sourceIndex - assetIndex) <= MAX_TRANSCRIPT_DISTANCE),
        )
      ) {
        return hasTextOverlap;
      }

      const capturedAt = asset.capturedAt.getTime();
      const isCloseInTime = evidenceTimes.some((time) => Math.abs(time - capturedAt) <= MAX_SEMANTIC_TIME_DISTANCE_MS);

      return isCloseInTime && hasTextOverlap;
    })
    .map((asset) => asset.id);
}
