import type { NormalizedCalendarEvent } from "@readymeet/shared";
import { openAIPromptCacheOptions } from "@readymeet/shared";
import { z } from "zod";

import { normalizeMeetingPrepDateText } from "../domain/meeting-prep-date-format";
import { apiEnv } from "../ports/api-env";
import { createLlmResponse } from "../ports/llm-responses";

type MeetingBriefMatchStrength = "strong" | "medium";
type MeetingBriefContext = "business" | "personal";

type MeetingBriefEmailCandidate = {
  threadId: string;
  subject: string | null;
  summary: string | null;
  snippet: string | null;
  lastMessageAt: string;
  participants: {
    email: string;
    normalizedEmail: string;
    displayName: string | null;
    domain: string | null;
  }[];
};

type MeetingBriefPastMeetingCandidate = {
  meetingId: string;
  title: string;
  endedAt: string;
  summary: string | null;
  participants: {
    email: string;
    displayName: string;
  }[];
};

type MeetingBriefParticipant = {
  key: string;
  name: string | null;
  email: string | null;
  emailDomain: string | null;
};

export type MeetingBriefIdentityHint = {
  participantKey: string;
  email: string;
  displayName: string;
  confidence: "high";
  reason: string;
};

type MeetingBriefPrivateContext = {
  relatedEmailThreads: {
    threadId: string;
    subject: string | null;
    summary: string | null;
    snippet: string | null;
    lastMessageAt: string;
    participants: { email: string; displayName: string | null; domain: string | null }[];
    matchStrength: MeetingBriefMatchStrength;
    matchReason: string;
  }[];
  relatedPastMeetings: {
    meetingId: string;
    title: string;
    endedAt: string;
    summary: string | null;
    participants: { email: string; displayName: string }[];
    matchStrength: MeetingBriefMatchStrength;
    matchReason: string;
  }[];
  identityHints: MeetingBriefIdentityHint[];
};

export type MeetingPrivateBrief = {
  status: "pending" | "running" | "completed" | "failed";
  bullets: string[];
};

export interface MeetingPrivateBriefRunner {
  generate(input: { model: string; systemPrompt: string; userMessage: string }): Promise<string>;
}

type OpenAIResponseCallback = (
  ...args: [response: unknown, input: { model: string; systemPrompt: string; userMessage: string }]
) => void | Promise<void>;

const MIN_TOPIC_WORD_LENGTH = 3;
const MAX_EMAIL_THREAD_SUMMARY_CHARS = 320;
const MAX_EMAIL_THREAD_SNIPPET_CHARS = 220;
const MAX_PAST_MEETING_SUMMARY_CHARS = 520;
const MAX_RELATED_EMAIL_THREADS = 8;
const MAX_RELATED_PAST_MEETINGS = 6;
const OPENAI_MAX_OUTPUT_TOKENS = 700;
const MAX_BRIEF_BULLETS = 5;
const MAX_BRIEF_LABEL_CHARS = 42;
const MAX_BRIEF_POINT_CHARS = 260;
const JSON_STRINGIFY_INDENT = 2;
const ELLIPSIS_SUFFIX_LENGTH = 1;

const MESSAGE_MEETING_BRIEF_OPENAI_FAILED_PREFIX = "OpenAI meeting brief failed (";
const MESSAGE_MEETING_BRIEF_OPENAI_FAILED_SUFFIX = "): ";
const MEETING_BRIEF_NO_TEXT_MESSAGE = "OpenAI meeting brief returned no text";
const MEETING_BRIEF_INVALID_JSON_MESSAGE = "Meeting brief output was not valid JSON";
const MEETING_BRIEF_DEFAULT_LABEL = "Brief";

function formatMeetingBriefOpenAiFailedMessage(input: { status: number; payloadText: string }) {
  return `${MESSAGE_MEETING_BRIEF_OPENAI_FAILED_PREFIX}${input.status}${MESSAGE_MEETING_BRIEF_OPENAI_FAILED_SUFFIX}${input.payloadText}`;
}

const jsonRecordSchema = z.record(z.string(), z.unknown());

const meetingBriefBulletSchema = z.object({
  label: z.unknown().optional(),
  point: z.unknown().optional(),
});

const meetingBriefOutputSchema = z.object({
  bullets: z.array(meetingBriefBulletSchema).optional(),
});

const GENERIC_TOPIC_WORDS = new Set([
  "about",
  "agenda",
  "call",
  "chat",
  "check",
  "connect",
  "conversation",
  "coffee",
  "discussion",
  "dinner",
  "drinks",
  "follow",
  "happy",
  "intro",
  "lunch",
  "meeting",
  "meetup",
  "party",
  "planning",
  "review",
  "sync",
  "update",
  "weekly",
]);

const MEETING_PRIVATE_BRIEF_SYSTEM_PROMPT = `You are preparing a concise private-context meeting brief for the user.

Use only the provided related_email_threads and related_past_meetings.
Do not connect prior context to the current meeting unless match_strength is strong or medium and match_reason clearly explains the relationship.
Ignore weak, stale, same-domain-only, or generic-title-only context.
If meeting_context is "personal", do not interpret work roles, employers, company domains, or professional titles as relevant unless the provided context directly says this event is work-related.

Write factual bullet points that help the user understand this meeting:
- previous decisions or commitments
- open loops or promised follow-ups
- recent email updates relevant to this meeting
- relationship/account context that changes how to interpret the meeting
- documents, receipts, attachments, or details mentioned in email summaries when clearly relevant

Do not write questions, icebreakers, rapport builders, speculation, or generic summaries.
Keep each bullet short, concrete, and directly tied to this meeting.
Format complete dates in prose as M/D/YYYY, month-only dates as M/YYYY, and never write ISO-style YYYY-MM-DD or YYYY-MM in prose.
If nothing is safely related, return an empty bullet list.

Return only JSON shaped like:
{"bullets":[{"label":"Open loop","point":"A concise factual sentence.","evidenceKind":"email","relevance":"Why this belongs in this meeting brief."}]}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizedEmail(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim().toLowerCase();

  return trimmed === "" ? null : trimmed;
}

function domainFromEmail(value: string | null | undefined): string | null {
  const email = normalizedEmail(value);
  if (email === null) {
    return null;
  }
  const atIndex = email.indexOf("@");
  if (atIndex < 0) {
    return null;
  }
  const domain = email.slice(atIndex + 1).trim();

  return domain === "" ? null : domain;
}

function wordsFrom(value: string | null | undefined) {
  return new Set(
    (value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .map((word) => word.trim())
      .filter((word) => word.length >= MIN_TOPIC_WORD_LENGTH && !GENERIC_TOPIC_WORDS.has(word)),
  );
}

function hasTopicOverlap(input: { meetingTokens: Set<string>; texts: readonly (string | null | undefined)[] }) {
  if (input.meetingTokens.size === 0) {
    return false;
  }
  const candidateTokens = new Set(input.texts.flatMap((text) => Array.from(wordsFrom(text))));

  return Array.from(input.meetingTokens).some((token) => candidateTokens.has(token));
}

function compactText(input: { value: string | null | undefined; maxLength: number }) {
  const text = (input.value ?? "").replace(/\s+/g, " ").trim();

  return text.length > input.maxLength ? `${text.slice(0, input.maxLength - ELLIPSIS_SUFFIX_LENGTH).trim()}…` : text;
}

function participantNameTokens(participants: MeetingBriefParticipant[]) {
  return new Set(
    participants.flatMap((participant) => {
      const emailLocalPart =
        normalizedEmail(participant.email)
          ?.split("@")[0]
          ?.replace(/[._-]+/g, " ") ?? "";

      return `${participant.name ?? ""} ${emailLocalPart}`
        .toLowerCase()
        .split(/\s+/)
        .map((part) => part.replace(/[^a-z0-9]/g, "").trim())
        .filter((part) => part.length >= MIN_TOPIC_WORD_LENGTH && !GENERIC_TOPIC_WORDS.has(part));
    }),
  );
}

function textIncludesAnyToken(input: { text: string; tokens: Set<string> }) {
  const textTokens = wordsFrom(input.text);

  return Array.from(input.tokens).some((token) => textTokens.has(token));
}

function optionalCompactText(input: { value: string | null | undefined; maxLength: number }) {
  const text = compactText(input);

  return text === "" ? null : text;
}

function eventTokensForMeeting(input: {
  title: string;
  companyDomain: string | null;
  participants: MeetingBriefParticipant[];
  nameTokens: Set<string>;
}) {
  const eventTokens = wordsFrom(input.title);
  [input.companyDomain, ...input.participants.map((participant) => participant.emailDomain)].forEach((domain) => {
    const companyToken = domain?.split(".")[0]?.trim().toLowerCase();
    if (companyToken !== undefined && companyToken !== "") {
      eventTokens.delete(companyToken);
    }
  });
  input.nameTokens.forEach((token) => {
    eventTokens.delete(token);
  });

  return eventTokens;
}

function identityHintsFromThread(input: {
  thread: MeetingBriefEmailCandidate;
  participants: MeetingBriefParticipant[];
  participantEmails: Set<string>;
}): MeetingBriefIdentityHint[] {
  const exactParticipants = input.thread.participants.filter((participant) =>
    input.participantEmails.has(participant.normalizedEmail),
  );

  return exactParticipants.flatMap((exact) => {
    const displayName = exact.displayName?.trim() ?? "";
    if (displayName === "") {
      return [];
    }
    const matchingParticipant = input.participants.find(
      (participant) => normalizedEmail(participant.email) === exact.normalizedEmail,
    );
    if (matchingParticipant === undefined) {
      return [];
    }

    return [
      {
        participantKey: matchingParticipant.key,
        email: exact.normalizedEmail,
        displayName,
        confidence: "high",
        reason: "Exact participant email matched a display name from email history.",
      },
    ];
  });
}

function mapEmailThreadToMatches(input: {
  thread: MeetingBriefEmailCandidate;
  participantEmails: Set<string>;
  participantDomains: Set<string>;
  eventTokens: Set<string>;
  companyDomain: string | null;
}): MeetingBriefPrivateContext["relatedEmailThreads"] {
  const exactParticipants = input.thread.participants.filter((participant) =>
    input.participantEmails.has(participant.normalizedEmail),
  );
  const threadTexts = [input.thread.subject, input.thread.summary, input.thread.snippet];
  const participantsPayload = input.thread.participants.map((participant) => ({
    email: participant.normalizedEmail,
    displayName: participant.displayName,
    domain: participant.domain,
  }));

  if (exactParticipants.length !== 0 && hasTopicOverlap({ meetingTokens: input.eventTokens, texts: threadTexts })) {
    const match: MeetingBriefPrivateContext["relatedEmailThreads"][number] = {
      threadId: input.thread.threadId,
      subject: input.thread.subject,
      summary: optionalCompactText({ value: input.thread.summary, maxLength: MAX_EMAIL_THREAD_SUMMARY_CHARS }),
      snippet: optionalCompactText({ value: input.thread.snippet, maxLength: MAX_EMAIL_THREAD_SNIPPET_CHARS }),
      lastMessageAt: input.thread.lastMessageAt,
      participants: participantsPayload,
      matchStrength: "strong",
      matchReason: `Exact participant email match with meeting topic overlap: ${exactParticipants.map((participant) => participant.normalizedEmail).join(", ")}.`,
    };

    return [match];
  }

  const isCompanyDomainMatch = input.thread.participants.some(
    (participant) =>
      participant.domain !== null &&
      participant.domain !== "" &&
      input.participantDomains.has(participant.domain) &&
      participant.domain === input.companyDomain,
  );
  if (isCompanyDomainMatch && hasTopicOverlap({ meetingTokens: input.eventTokens, texts: threadTexts })) {
    const companyDomain = input.companyDomain ?? "";
    const match: MeetingBriefPrivateContext["relatedEmailThreads"][number] = {
      threadId: input.thread.threadId,
      subject: input.thread.subject,
      summary: optionalCompactText({ value: input.thread.summary, maxLength: MAX_EMAIL_THREAD_SUMMARY_CHARS }),
      snippet: optionalCompactText({ value: input.thread.snippet, maxLength: MAX_EMAIL_THREAD_SNIPPET_CHARS }),
      lastMessageAt: input.thread.lastMessageAt,
      participants: participantsPayload,
      matchStrength: "medium",
      matchReason: `Company domain ${companyDomain} matched and the thread topic overlaps with the meeting title.`,
    };

    return [match];
  }

  return [];
}

function mapPastMeetingToMatch(input: {
  meeting: MeetingBriefPastMeetingCandidate;
  participantEmails: Set<string>;
  nameTokens: Set<string>;
  companyDomain: string | null;
  eventTokens: Set<string>;
}): MeetingBriefPrivateContext["relatedPastMeetings"] {
  const text = `${input.meeting.title}\n${input.meeting.summary ?? ""}`;
  const hasParticipantEmailMatch = input.meeting.participants.some((participant) =>
    participantEmailsHas({ participantEmails: input.participantEmails, email: participant.email }),
  );
  const isNameMatch = textIncludesAnyToken({ text, tokens: input.nameTokens });
  const isDomainMatch =
    input.companyDomain !== null && input.companyDomain !== ""
      ? input.meeting.participants.some((participant) => domainFromEmail(participant.email) === input.companyDomain)
      : false;
  const isTopicMatch = hasTopicOverlap({
    meetingTokens: input.eventTokens,
    texts: [input.meeting.title, input.meeting.summary],
  });

  if (hasParticipantEmailMatch && isTopicMatch) {
    const match: MeetingBriefPrivateContext["relatedPastMeetings"][number] = {
      meetingId: input.meeting.meetingId,
      title: input.meeting.title,
      endedAt: input.meeting.endedAt,
      summary: optionalCompactText({ value: input.meeting.summary, maxLength: MAX_PAST_MEETING_SUMMARY_CHARS }),
      participants: input.meeting.participants,
      matchStrength: "strong",
      matchReason: "Past meeting shares a participant email and meaningful topic overlap with this meeting.",
    };

    return [match];
  }

  if ((isNameMatch || isDomainMatch) && isTopicMatch) {
    const match: MeetingBriefPrivateContext["relatedPastMeetings"][number] = {
      meetingId: input.meeting.meetingId,
      title: input.meeting.title,
      endedAt: input.meeting.endedAt,
      summary: optionalCompactText({ value: input.meeting.summary, maxLength: MAX_PAST_MEETING_SUMMARY_CHARS }),
      participants: input.meeting.participants,
      matchStrength: "medium",
      matchReason: "Past meeting shares a participant/company anchor and meaningful topic overlap with this meeting.",
    };

    return [match];
  }

  return [];
}

function participantEmailsHas(input: { participantEmails: Set<string>; email: string }) {
  const normalized = normalizedEmail(input.email);

  return normalized !== null && input.participantEmails.has(normalized);
}

function collectRelatedEmailThreads(input: {
  emailCandidates: MeetingBriefEmailCandidate[];
  participants: MeetingBriefParticipant[];
  participantEmails: Set<string>;
  participantDomains: Set<string>;
  eventTokens: Set<string>;
  companyDomain: string | null;
}) {
  return input.emailCandidates
    .flatMap((thread) => {
      return mapEmailThreadToMatches({
        thread,
        participantEmails: input.participantEmails,
        participantDomains: input.participantDomains,
        eventTokens: input.eventTokens,
        companyDomain: input.companyDomain,
      });
    })
    .slice(0, MAX_RELATED_EMAIL_THREADS);
}

function collectRelatedPastMeetings(input: {
  pastMeetingCandidates: MeetingBriefPastMeetingCandidate[];
  participantEmails: Set<string>;
  nameTokens: Set<string>;
  companyDomain: string | null;
  eventTokens: Set<string>;
}) {
  return input.pastMeetingCandidates
    .flatMap((meeting) =>
      mapPastMeetingToMatch({
        meeting,
        participantEmails: input.participantEmails,
        nameTokens: input.nameTokens,
        companyDomain: input.companyDomain,
        eventTokens: input.eventTokens,
      }),
    )
    .slice(0, MAX_RELATED_PAST_MEETINGS);
}

export function buildMeetingBriefPrivateContext(input: {
  event: NormalizedCalendarEvent;
  participants: MeetingBriefParticipant[];
  companyDomain: string | null;
  emailCandidates: MeetingBriefEmailCandidate[];
  pastMeetingCandidates: MeetingBriefPastMeetingCandidate[];
}): MeetingBriefPrivateContext {
  const participantEmails = new Set(
    input.participants
      .map((participant) => normalizedEmail(participant.email))
      .filter((email): email is string => email !== null),
  );
  const participantDomains = new Set(
    input.participants
      .map((participant) => participant.emailDomain)
      .filter((domain): domain is string => domain !== null && domain !== ""),
  );
  const nameTokens = participantNameTokens(input.participants);
  const eventTokens = eventTokensForMeeting({
    title: input.event.title,
    companyDomain: input.companyDomain,
    participants: input.participants,
    nameTokens,
  });
  const identityHintsByKey = new Map<string, MeetingBriefIdentityHint>();
  input.emailCandidates.forEach((thread) => {
    identityHintsFromThread({
      thread,
      participants: input.participants,
      participantEmails,
    }).forEach((hint) => {
      if (!identityHintsByKey.has(hint.participantKey)) {
        identityHintsByKey.set(hint.participantKey, hint);
      }
    });
  });

  const relatedEmailThreads = collectRelatedEmailThreads({
    emailCandidates: input.emailCandidates,
    participants: input.participants,
    participantEmails,
    participantDomains,
    eventTokens,
    companyDomain: input.companyDomain,
  });

  const relatedPastMeetings = collectRelatedPastMeetings({
    pastMeetingCandidates: input.pastMeetingCandidates,
    participantEmails,
    nameTokens,
    companyDomain: input.companyDomain,
    eventTokens,
  });

  return {
    relatedEmailThreads,
    relatedPastMeetings,
    identityHints: Array.from(identityHintsByKey.values()),
  };
}

function extractResponseText(payload: unknown) {
  if (!isRecord(payload)) {
    return "";
  }
  const outputText = payload.output_text;
  if (typeof outputText === "string") {
    return outputText;
  }

  const output = payload.output;
  if (!Array.isArray(output)) {
    return "";
  }

  return output
    .flatMap((item) => {
      if (!isRecord(item) || item.type !== "message") {
        return [];
      }
      const content = item.content;
      if (!Array.isArray(content)) {
        return [];
      }

      return content.flatMap((contentItem) => {
        if (!isRecord(contentItem) || contentItem.type !== "output_text") {
          return [];
        }
        const text = contentItem.text;

        return typeof text === "string" ? [text] : [];
      });
    })
    .join("\n");
}

function safeParseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed = jsonRecordSchema.safeParse(JSON.parse(text));

    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }

    return null;
  }
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const direct = safeParseJsonRecord(trimmed);
  if (direct !== null) {
    return direct;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const extracted = safeParseJsonRecord(trimmed.slice(start, end + 1));
    if (extracted !== null) {
      return extracted;
    }
  }

  throw new Error(MEETING_BRIEF_INVALID_JSON_MESSAGE);
}

function meetingBriefOpenAiFailureError(input: { status: number; payload: Record<string, unknown> }) {
  return new Error(
    formatMeetingBriefOpenAiFailedMessage({ status: input.status, payloadText: JSON.stringify(input.payload) }),
  );
}

export class OpenAIMeetingPrivateBriefRunner implements MeetingPrivateBriefRunner {
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly onResponse?: OpenAIResponseCallback;
  private readonly complete: typeof createLlmResponse;

  constructor(
    ...args: [
      apiKey: string,
      timeoutMs?: number,
      onResponse?: OpenAIResponseCallback,
      complete?: typeof createLlmResponse,
    ]
  ) {
    this.apiKey = args[0];
    this.timeoutMs = args[1] ?? apiEnv().OPENAI_MEETING_BRIEF_TIMEOUT_MS;
    this.onResponse = args[2];
    this.complete = args[3] ?? createLlmResponse;
  }

  async generate(input: { model: string; systemPrompt: string; userMessage: string }): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref();
    try {
      const result = await this.complete({
        apiKey: this.apiKey,
        signal: controller.signal,
        timeoutMs: this.timeoutMs,
        body: {
          model: input.model,
          ...openAIPromptCacheOptions(input.model),
          max_output_tokens: OPENAI_MAX_OUTPUT_TOKENS,
          input: [
            { role: "system", content: input.systemPrompt },
            { role: "user", content: input.userMessage },
          ],
        },
      });
      const payloadParsed = jsonRecordSchema.safeParse(result.payload);
      const payload = payloadParsed.success ? payloadParsed.data : {};
      if (!result.isOk) {
        throw meetingBriefOpenAiFailureError({ status: result.status, payload });
      }
      await this.onResponse?.(payload, input);
      const output = extractResponseText(payload).trim();
      if (output === "") {
        throw new Error(MEETING_BRIEF_NO_TEXT_MESSAGE);
      }

      return output;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function cleanBriefBulletLabel(value: unknown) {
  const labelText = typeof value === "string" ? value : MEETING_BRIEF_DEFAULT_LABEL;
  const compacted = compactText({ value: labelText, maxLength: MAX_BRIEF_LABEL_CHARS }).replace(/:$/, "");

  return compacted === "" ? MEETING_BRIEF_DEFAULT_LABEL : compacted;
}

function cleanBriefBulletPoint(value: unknown) {
  const pointText = typeof value === "string" ? value : "";

  return normalizeMeetingPrepDateText(compactText({ value: pointText, maxLength: MAX_BRIEF_POINT_CHARS }));
}

export function parseMeetingPrivateBriefOutput(text: string): MeetingPrivateBrief {
  const parsed = meetingBriefOutputSchema.parse(parseJsonObject(text));
  const bullets = (parsed.bullets ?? []).flatMap((item) => {
    const point = cleanBriefBulletPoint(item.point);
    if (point === "") {
      return [];
    }

    return [`${cleanBriefBulletLabel(item.label)}: ${point}`];
  });

  return {
    status: "completed",
    bullets: bullets.slice(0, MAX_BRIEF_BULLETS),
  };
}

export async function generateMeetingPrivateBrief(input: {
  event: NormalizedCalendarEvent;
  context: MeetingBriefPrivateContext;
  runner: MeetingPrivateBriefRunner;
  meetingContext?: MeetingBriefContext;
  model?: string;
}): Promise<MeetingPrivateBrief> {
  if (input.context.relatedEmailThreads.length === 0 && input.context.relatedPastMeetings.length === 0) {
    return { status: "completed", bullets: [] };
  }

  const userMessage = JSON.stringify(
    {
      current_meeting: {
        title: input.event.isPrivate ? "Private event" : input.event.title,
        meeting_context: input.meetingContext ?? "business",
        start: input.event.start,
        end: input.event.end,
        organizer: input.event.organizer,
        attendees: input.event.attendees,
      },
      related_email_threads: input.context.relatedEmailThreads.map((thread) => ({
        subject: thread.subject,
        summary: thread.summary,
        snippet: thread.snippet,
        last_message_at: thread.lastMessageAt,
        participants: thread.participants,
        match_strength: thread.matchStrength,
        match_reason: thread.matchReason,
      })),
      related_past_meetings: input.context.relatedPastMeetings.map((meeting) => ({
        title: meeting.title,
        ended_at: meeting.endedAt,
        summary: meeting.summary,
        participants: meeting.participants,
        match_strength: meeting.matchStrength,
        match_reason: meeting.matchReason,
      })),
    },
    null,
    JSON_STRINGIFY_INDENT,
  );

  const output = await input.runner.generate({
    model: input.model ?? apiEnv().OPENAI_MEETING_BRIEF_MODEL,
    systemPrompt: MEETING_PRIVATE_BRIEF_SYSTEM_PROMPT,
    userMessage,
  });

  return parseMeetingPrivateBriefOutput(output);
}
