import { parse as parseDomain } from "tldts";
import { z } from "zod";

const SINGLE_TARGET_MAX_LENGTH = 100;
const SINGLE_TARGET_MAX_WORDS = 5;
const VOICE_SEARCH_DELAY_MIN_MS = -1_000;
const VOICE_SEARCH_CANDIDATE_MISSING_MESSAGE = "Voice search candidate is missing";
const VOICE_SEARCH_EVIDENCE_RUN_MISSING_MESSAGE = "Voice search evidence run is missing";
const VOICE_SEARCH_SOURCE_URL_MAX_LENGTH = 500;
const VOICE_SEARCH_MAX_SOURCES_PER_MENTION = 3;
const VOICE_SEARCH_MAX_GROUNDED_EVIDENCE = 20;
const VOICE_SEARCH_ID_FIELD_MAX_LENGTH = 256;
const VOICE_SEARCH_TRANSCRIPT_TARGET_MAX_LENGTH = 100;
const VOICE_SEARCH_QUERY_MAX_LENGTH = 500;
const VOICE_SEARCH_ALLOWED_CONFIDENCE = new Set(["high", "medium"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Correlate two independent transcriptions without changing the stored transcript.
 * A time match alone is never sufficient: the same speaker must have made a
 * direct search request, with a single target, immediately before the tool run.
 */
export type ResearchTranscriptSegment = {
  id: string;
  speakerUserId: string | null;
  speakerRole: string;
  content: string;
  startedAt: Date;
  endedAt: Date | null;
};

export type MeetingVoiceResearch = {
  id: string;
  invocationId?: string;
  utteranceId?: string;
  meetingId: string;
  userId: string;
  query: string;
  status: string;
  expiresAt?: Date | null;
  createdAt: Date;
  result: unknown;
};

export type VoiceSearchMention = {
  runId: string;
  invocationId?: string;
  segmentId: string;
  transcriptTarget: string;
  query: string;
};

function normalized(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Intentionally conservative. Multi-target requests and ordinary discussion
// must not suppress independent ambient research or cause name corrections.
function singleTarget(value: string) {
  const target = cleanRequestTarget(value);

  return target.length > 0 &&
    target.length <= SINGLE_TARGET_MAX_LENGTH &&
    !/^(?:is|was|are|were)\s/i.test(target) &&
    target.split(/\s+/).length <= SINGLE_TARGET_MAX_WORDS &&
    !/\b(and|or|versus|vs|then|also|ja|tai|sekä|sitten)\b|[,;&]/i.test(target)
    ? target
    : null;
}

function cleanRequestTarget(value: string) {
  return value
    .trim()
    .replace(/^[\s.…]+|[\s.?!…]+$/g, "")
    .replace(/^(?:(?:the )?company|yrityksestä|yritystä|yritys)\s+/i, "");
}

function requestTarget(value: string): string | null {
  const request = value.trim().replace(/^(?:(?:okay|ok|hey ready|hi ready|ready|hei ready|hei|okei)[,!.]?\s+)+/i, "");
  const match = request.match(
    /^(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:do (?:a |an )?(?:web |internet )?search (?:on|for)|(?:web )?search(?: (?:for|on))?|google|look up|research)\b\s*(.*)$/i,
  );
  const finnish = request.match(
    /^(?:(?:voitko|voisitko)\s+)?(?:etsi(?:ä)?|hae|hakea|(?:tehdä|tee)\s+(?:webhaun|verkkohaun|haun))(?=\s|[.…]|$)(?:\s+(?:verkosta|netistä|tietoa))*(?:\s+yrityksestä)?\s*(.*)$/i,
  );
  const target = match?.[1] ?? finnish?.[1];

  return target === undefined ? null : cleanRequestTarget(target);
}

export const VOICE_SEARCH_MATCH_WINDOW_MS = 8_000;

export function voiceSearchRequestCandidates(
  segments: ResearchTranscriptSegment[],
): { segment: ResearchTranscriptSegment; target: string }[] {
  const human = segments
    .filter((s) => s.speakerRole === "human")
    .slice()
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());

  return human.flatMap((segment, index) => {
    const previous = human[index - 1];
    const inline = requestTarget(segment.content);
    const isSplitRequest =
      inline === null &&
      previous?.speakerUserId === segment.speakerUserId &&
      requestTarget(previous.content) === "" &&
      segment.startedAt.getTime() - (previous.endedAt ?? previous.startedAt).getTime() <= VOICE_SEARCH_MATCH_WINDOW_MS;
    const target = singleTarget(inline ?? (isSplitRequest ? segment.content : ""));
    if (target === null || target === "" || segment.speakerUserId === null || segment.speakerUserId === "") {
      return [];
    }

    return [{ segment, target }];
  });
}

export function matchVoiceSearchMentions(input: {
  meetingId: string;
  segments: ResearchTranscriptSegment[];
  runs: MeetingVoiceResearch[];
  /** @external voice search matching contract */
  /** Active ownership is for bounded deferral only, never permanent suppression. */
  includeActive?: boolean;
}): VoiceSearchMention[] {
  const requestKeys = new Map<VoiceSearchMention, string>();
  const matches = voiceSearchRequestCandidates(input.segments).flatMap(({ segment, target }) => {
    const candidates = input.runs.filter((run) => {
      const delay = run.createdAt.getTime() - (segment.endedAt ?? segment.startedAt).getTime();

      return (
        (run.status === "completed" ||
          (input.includeActive === true &&
            ["queued", "routing", "searching", "reading", "discovering", "validating", "synthesizing"].includes(
              run.status,
            ) &&
            (run.expiresAt === null || run.expiresAt === undefined || run.expiresAt.getTime() > Date.now()))) &&
        run.meetingId === input.meetingId &&
        run.userId === segment.speakerUserId &&
        singleTarget(run.query) !== null &&
        delay >= VOICE_SEARCH_DELAY_MIN_MS &&
        delay <= VOICE_SEARCH_MATCH_WINDOW_MS
      );
    });
    const requestKey = (run: MeetingVoiceResearch) =>
      JSON.stringify([run.id, run.utteranceId ?? run.invocationId ?? run.id]);
    // Repeated tool calls for one utterance can share a run. They are one
    // request; different utterances or runs remain genuinely ambiguous.
    const groups = new Set(candidates.map(requestKey));
    if (groups.size !== 1) {
      return [];
    }
    const run = candidates.slice().sort((a, b) => {
      const byTime = a.createdAt.getTime() - b.createdAt.getTime();
      if (byTime !== 0) {
        return byTime;
      }

      return (a.invocationId ?? "").localeCompare(b.invocationId ?? "");
    })[0];
    if (run === undefined) {
      throw new Error(VOICE_SEARCH_CANDIDATE_MISSING_MESSAGE);
    }
    const match = {
      runId: run.id,
      ...(run.invocationId !== undefined && run.invocationId !== "" ? { invocationId: run.invocationId } : {}),
      segmentId: segment.id,
      transcriptTarget: target,
      query: run.query,
    };
    requestKeys.set(match, requestKey(run));

    return [match];
  });

  // Each spoken request owns one target. Multiple requests may reuse a result.
  return matches.filter(
    (match) => matches.filter((other) => requestKeys.get(other) === requestKeys.get(match)).length === 1,
  );
}

export function voiceSearchOwnsMention(input: { mention: VoiceSearchMention; name: string }): boolean {
  if (normalized(input.mention.transcriptTarget) === normalized(input.name)) {
    return true;
  }
  const domain = explicitCompanyDomain(input.mention.transcriptTarget);
  const label = domain !== null && domain !== "" ? domain.split(".")[0] : undefined;

  // Detectors may omit the suffix in a domain spoken as a company name.
  return (
    domain !== null &&
    domain !== "" &&
    label !== undefined &&
    label !== "" &&
    normalized(label) === normalized(input.name)
  );
}

/** Only the request and short same-speaker confirmations belong to a voice search.
 * A later substantive statement or another speaker still warrants independent research.
 */
export function voiceSearchOwnedSegmentIds(input: {
  segments: ResearchTranscriptSegment[];
  mentions: VoiceSearchMention[];
  displayName: string;
}): Set<string> {
  const owned = new Set<string>();
  input.mentions.forEach((mention) => {
    if (!voiceSearchOwnsMention({ mention, name: input.displayName })) {
      return;
    }
    const request = input.segments.find((segment) => segment.id === mention.segmentId);
    if (!request) {
      return;
    }
    owned.add(request.id);
    input.segments.forEach((segment) => {
      const delay = segment.startedAt.getTime() - (request.endedAt ?? request.startedAt).getTime();
      if (
        segment.speakerRole !== "human" ||
        segment.speakerUserId !== request.speakerUserId ||
        delay < 0 ||
        delay > VOICE_SEARCH_MATCH_WINDOW_MS
      ) {
        return;
      }
      const repeated = cleanRequestTarget(
        segment.content.replace(/^(?:yes|yeah|yep|right|joo|kyllä|niin)[,!.]?\s+/i, ""),
      );
      if (voiceSearchOwnsMention({ mention: { ...mention, transcriptTarget: repeated }, name: input.displayName })) {
        owned.add(segment.id);
      }
    });
  });

  return owned;
}

export function explicitCompanyDomain(value: string): string | null {
  const target = value.trim().replace(/[.?!]+$/, "");
  // Dotted product names (Node.js, J.Crew) are not registered web suffixes.
  // Use the public suffix list, not a hand-maintained domain allowlist.
  if (!/^https?:\/\//i.test(target) && parseDomain(target).isIcann !== true) {
    return null;
  }
  if (!/^(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\/?$/i.test(target)) {
    return null;
  }
  try {
    return new URL(target.includes("://") ? target : `https://${target}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }

    return null;
  }
}

export function sourceMatchesCompanyDomain(input: { url: string; domain: string }): boolean {
  try {
    const source = new URL(input.url);
    const hostname = source.hostname.toLowerCase().replace(/^www\./, "");
    const expected = input.domain.toLowerCase().replace(/^www\./, "");

    return (
      source.protocol === "https:" &&
      source.username === "" &&
      source.password === "" &&
      (hostname === expected || hostname.endsWith(`.${expected}`))
    );
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }

    return false;
  }
}

export type VoiceSearchIdentityEvidence = VoiceSearchMention & { sources: string[] };

export function groundedVoiceSearchIdentityEvidence(
  input: Parameters<typeof matchVoiceSearchMentions>[0],
): VoiceSearchIdentityEvidence[] {
  return matchVoiceSearchMentions(input)
    .flatMap((mention) => {
      const run = input.runs.find(
        (candidate) => candidate.id === mention.runId && candidate.invocationId === mention.invocationId,
      );
      if (run === undefined) {
        throw new Error(VOICE_SEARCH_EVIDENCE_RUN_MISSING_MESSAGE);
      }
      if (run.status !== "completed" || !isRecord(run.result)) {
        return [];
      }
      const answer = run.result["answer"];
      if (!isRecord(answer)) {
        return [];
      }
      const confidence = answer["confidence"];
      if (!VOICE_SEARCH_ALLOWED_CONFIDENCE.has(String(confidence))) {
        return [];
      }
      // A name similarity or search-result ranking is not proof of identity.
      const domain = explicitCompanyDomain(run.query);
      const citations = answer["citations"];
      if (domain === null || domain === "" || !Array.isArray(citations)) {
        return [];
      }
      const sources = citations
        .flatMap((citation: unknown) => {
          if (!isRecord(citation)) {
            return [];
          }
          const url = citation["url"];

          return typeof url === "string" && sourceMatchesCompanyDomain({ url, domain })
            ? [url.slice(0, VOICE_SEARCH_SOURCE_URL_MAX_LENGTH)]
            : [];
        })
        .slice(0, VOICE_SEARCH_MAX_SOURCES_PER_MENTION);

      return sources.length !== 0 ? [{ ...mention, sources }] : [];
    })
    .slice(0, VOICE_SEARCH_MAX_GROUNDED_EVIDENCE);
}

/** Optional internal request metadata; additive for mixed-version deployments. */
export const voiceSearchIdentityEvidenceSchema = z.object({
  runId: z.string().min(1).max(VOICE_SEARCH_ID_FIELD_MAX_LENGTH),
  invocationId: z.string().min(1).max(VOICE_SEARCH_ID_FIELD_MAX_LENGTH).optional(),
  segmentId: z.string().min(1).max(VOICE_SEARCH_ID_FIELD_MAX_LENGTH),
  transcriptTarget: z.string().max(VOICE_SEARCH_TRANSCRIPT_TARGET_MAX_LENGTH),
  query: z.string().max(VOICE_SEARCH_QUERY_MAX_LENGTH),
  sources: z.array(z.string().url().max(VOICE_SEARCH_SOURCE_URL_MAX_LENGTH)).max(VOICE_SEARCH_MAX_SOURCES_PER_MENTION),
});
