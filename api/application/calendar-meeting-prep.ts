import type { CalendarEventPrepRow } from "@readymeet/db/ports/repository";
import {
  calendarEventPrepBriefSchema,
  type CalendarEventPrepProgress,
  calendarEventPrepProgressSchema,
  type CalendarEventPrepResponse,
  calendarEventPrepResponseSchema,
  type CalendarEventPrepSource,
  type NormalizedCalendarEvent,
} from "@readymeet/shared";
import { createHash } from "node:crypto";
import { z } from "zod";

import { formatMeetingPrepDate, normalizeMeetingPrepDateText } from "../domain/meeting-prep-date-format";
import { apiEnv } from "../ports/api-env";
import { parallelSearchTurbo } from "../ports/gate-parallel-search";

import type { MeetingBriefIdentityHint, MeetingPrivateBrief } from "./calendar-private-brief";

type CalendarPrepUserContext = {
  userId: string;
  userEmail: string;
  userDisplayName: string;
  calendarAccountEmails: string[];
};

type CalendarPrepPerson = {
  key: string;
  role: "organizer" | "attendee";
  name: string | null;
  email: string | null;
  emailDomain: string | null;
  isCurrentUser: boolean;
  isExternal: boolean;
};

type CalendarPrepMeetingContext = "business" | "personal";

export type CalendarPrepTargetPlan = {
  eventFingerprint: string;
  eventSnapshot: Record<string, unknown>;
  meetingContext: CalendarPrepMeetingContext;
  ownCompanyDomains: string[];
  externalParticipants: CalendarPrepPerson[];
  peopleTargets: CalendarPrepPerson[];
  companyTarget: {
    domain: string;
    participantNames: string[];
  } | null;
};
type PrepRunRef = {
  kind: "people" | "company";
  runId: string;
  participantKey?: string;
  name?: string | null;
  domain?: string | null;
};

type CalendarPrepRunRefs = {
  taskgroupId?: string | null;
  runs: PrepRunRef[];
  /** @external calendar prep company section visibility */
  companyVisible: boolean;
  processor?: string | null;
};

type ParallelTaskGroup = {
  taskgroup_id: string;
  status?: {
    is_active?: boolean;
    modified_at?: string | null;
    num_task_runs?: number;
    status_message?: string | null;
    task_run_status_counts?: Record<string, number>;
  };
};

type ParallelAddRunsResponse = {
  run_ids: string[];
};

type ParallelRunResult = {
  run: {
    run_id: string;
    status: string;
  };
  output?: {
    type?: string;
    content?: unknown;
    basis?: unknown;
  };
};

export type ParallelSearchResponse = {
  search_id?: string;
  session_id?: string;
  results?: {
    url?: string | null;
    title?: string | null;
    publish_date?: string | null;
    excerpts?: string[] | null;
  }[];
};

export type ParallelExtractResponse = {
  extract_id?: string;
  session_id?: string;
  results?: {
    url?: string | null;
    title?: string | null;
    excerpts?: string[] | null;
    full_content?: string | null;
  }[];
  errors?: {
    url?: string | null;
    error_type?: string | null;
    http_status_code?: number | null;
    content?: string | null;
  }[];
};

type ParallelFindAllStatus = {
  status?: string;
  is_active?: boolean;
  metrics?: {
    generated_candidates_count?: number;
    matched_candidates_count?: number;
  };
};

export type ParallelFindAllRunResponse = {
  findall_id?: string;
  status?: ParallelFindAllStatus;
  generator?: string;
};

type ParallelFindAllCitation = {
  title?: string | null;
  url?: string | null;
  excerpts?: string[] | null;
};

type ParallelFindAllBasis = {
  field?: string | null;
  citations?: ParallelFindAllCitation[] | null;
  reasoning?: string | null;
  confidence?: string | null;
};

type ParallelFindAllCandidate = {
  candidate_id?: string | null;
  name?: string | null;
  url?: string | null;
  description?: string | null;
  match_status?: string | null;
  output?: Record<string, unknown> | null;
  basis?: ParallelFindAllBasis[] | null;
};

export type ParallelFindAllResultResponse = {
  findall_id?: string;
  status?: ParallelFindAllStatus;
  run?: ParallelFindAllRunResponse;
  candidates?: ParallelFindAllCandidate[];
  last_event_id?: string | null;
};

type ParallelRunEvent = {
  eventType: string | null;
  data: Record<string, unknown>;
};

type CalendarPrepRunProgress = {
  runId: string;
  status: CalendarEventPrepResponse["status"] | null;
  progressPercent: number | null;
  message: string | null;
  messages: string[];
};

type ParallelRunInput = {
  input: Record<string, unknown>;
  processor: string;
  metadata: Record<string, string>;
  task_spec: Record<string, unknown>;
  /** @external parallel task run events flag */
  enable_events: true;
};

export type CalendarPrepStartMode = "background" | "interactive";

type CompanyLatestSearchContext = {
  searchId: string | null;
  sessionId: string | null;
  afterDate: string;
  results: {
    title: string;
    url: string;
    publishDate: string | null;
    excerpts: string[];
  }[];
};

const PARALLEL_API_BASE_URL = "https://api.parallel.ai";
const MEETING_PREP_LOGIC_VERSION = 3;
const MAX_PEOPLE_TARGETS = 6;
const COMPANY_FRESHNESS_WINDOW_DAYS = 90;
const PEOPLE_FRESHNESS_WINDOW_DAYS = 180;
const ISO_DATE_PREFIX_LENGTH = 10;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1000;
const MILLISECONDS_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
const MAX_OWN_EMAILS_FOR_PREP = 12;
const MAX_OWN_COMPANY_DOMAINS = 4;
const MAX_COMPANY_PARTICIPANT_NAMES = 6;
const PARALLEL_METADATA_VALUE_MAX_LENGTH = 120;
const PARALLEL_ERROR_BODY_MAX_CHARS = 500;
const PARALLEL_SSE_SAMPLE_MS_DEFAULT = 4500;
const PARALLEL_SSE_TIMEOUT_PADDING_MS = 2500;
const COMPANY_SEARCH_MAX_CHARS_TOTAL = 24000;
const COMPANY_SEARCH_FETCH_MAX_AGE_SECONDS = 86400;
const SEARCH_EXCERPT_MAX_CHARS = 1800;
const MAX_COMPANY_SEARCH_RESULTS = 10;
const MAX_SEARCH_EXCERPTS_PER_RESULT = 3;
const MAX_PREP_SOURCES = 8;
const PROGRESS_PERCENT_MIN = 0;
const PROGRESS_PERCENT_MAX = 100;
const PROGRESS_PERCENT_SCALE = 100;
const MAX_PREP_PEOPLE_BULLETS = 6;
const MAX_PREP_COMPANY_BULLETS = 4;
const MAX_PREP_BULLET_GROUPS = 5;
const MAX_SIGNAL_BULLETS = 2;
const MAX_COMPANY_SIGNAL_BULLETS = 3;
const MAX_PRIORITY_BULLETS = 2;
const PARALLEL_EVENTS_BETA_HEADER = "events-sse-2025-07-24";
const MESSAGE_PARALLEL_REQUEST_FAILED_PREFIX = "Parallel request failed (";
const MESSAGE_PARALLEL_REQUEST_FAILED_SUFFIX = "): ";
const MESSAGE_PARALLEL_STREAM_CANCEL_FAILED = "parallel stream cancel failed";

const jsonRecordSchema = z.record(z.string(), z.unknown());
const parallelRunEventDataSchema = jsonRecordSchema;
const parallelRunEventsRootSchema = z.union([jsonRecordSchema, z.array(jsonRecordSchema)]);

function parallelRunEventDataFromJsonText(text: string): Record<string, unknown> | null {
  try {
    const jsonPayload: unknown = JSON.parse(text);
    const parsed = parallelRunEventDataSchema.safeParse(jsonPayload);

    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function parseParallelRunEventsRoot(text: string): z.infer<typeof parallelRunEventsRootSchema> | null {
  try {
    const jsonPayload: unknown = JSON.parse(text);
    const parsed = parallelRunEventsRootSchema.safeParse(jsonPayload);

    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatParallelRequestFailedMessage(input: { status: number; bodyText: string }) {
  return `${MESSAGE_PARALLEL_REQUEST_FAILED_PREFIX}${input.status}${MESSAGE_PARALLEL_REQUEST_FAILED_SUFFIX}${input.bodyText.slice(0, PARALLEL_ERROR_BODY_MAX_CHARS)}`;
}

const FREEMAIL_DOMAINS = new Set([
  "aol.com",
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "me.com",
  "msn.com",
  "outlook.com",
  "pm.me",
  "proton.me",
  "protonmail.com",
  "yahoo.com",
]);

const emptyPeople = (status: CalendarEventPrepResponse["people"]["status"]): CalendarEventPrepResponse["people"] => ({
  status,
  bullets: [],
  sources: [],
});

const emptyBrief = (status: CalendarEventPrepResponse["brief"]["status"]): CalendarEventPrepResponse["brief"] => ({
  status,
  bullets: [],
});

const emptyCompany = (input: {
  status: CalendarEventPrepResponse["people"]["status"];
  isVisible: boolean;
}): CalendarEventPrepResponse["company"] =>
  input.isVisible
    ? {
        status: input.status,
        companyName: null,
        website: null,
        bullets: [],
        sources: [],
      }
    : null;

function domainFromEmail(email: string | null | undefined) {
  if (email === null || email === undefined) {
    return null;
  }
  const value = email.trim().toLowerCase();
  if (value === "") {
    return null;
  }
  const domain = value.split("@")[1]?.trim();

  return domain === undefined || domain === "" ? null : domain;
}

function normalizeEmail(value: string | null | undefined) {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = value.trim().toLowerCase();

  return normalized === "" ? null : normalized;
}

function normalizeEmailForSelfComparison(value: string | null | undefined) {
  const email = normalizeEmail(value);
  if (email === null) {
    return null;
  }
  const [localPart, domain] = email.split("@");
  if (localPart === undefined || localPart === "" || domain === undefined || domain === "") {
    return email;
  }
  if (domain === "gmail.com" || domain === "googlemail.com") {
    const localSegment = localPart.split("+")[0] ?? localPart;
    const scrubbedLocal = localSegment.replace(/\./g, "");
    const displayLocal = scrubbedLocal === "" ? localPart : scrubbedLocal;

    return `${displayLocal}@gmail.com`;
  }

  return email;
}

function isFreemailDomain(domain: string | null | undefined) {
  return domain !== null && domain !== undefined && domain !== "" && FREEMAIL_DOMAINS.has(domain);
}

function reliableDomainFromEmail(email: string | null | undefined) {
  const domain = domainFromEmail(email);

  return domain !== null && !isFreemailDomain(domain) ? domain : null;
}

function calendarPersonName(person: NormalizedCalendarEvent["attendees"][number] | null | undefined) {
  const trimmedName = person?.name?.trim();
  if (trimmedName !== undefined && trimmedName !== "") {
    return trimmedName;
  }
  const emailLocal = person?.email?.split("@")[0]?.trim();

  return emailLocal === undefined || emailLocal === "" ? null : emailLocal;
}

function participantKey(input: {
  role: CalendarPrepPerson["role"];
  name: string | null;
  emailDomain: string | null;
  index: number;
}) {
  return [input.role, input.name?.toLowerCase() ?? "unknown", input.emailDomain ?? "no-domain", input.index].join(":");
}

function isCurrentUserPerson(input: {
  person: NormalizedCalendarEvent["attendees"][number] | null | undefined;
  userEmail: string;
  userDisplayName: string;
  ownEmailSet?: Set<string>;
}) {
  const email = normalizeEmailForSelfComparison(input.person?.email);
  if (
    email !== null &&
    email !== "" &&
    (email === normalizeEmailForSelfComparison(input.userEmail) || input.ownEmailSet?.has(email) === true)
  ) {
    return true;
  }

  const name = input.person?.name?.trim().toLowerCase();
  if (name === undefined || name === "") {
    return false;
  }

  return name === input.userDisplayName.trim().toLowerCase();
}

function compactStringArray(input: { values: (string | null | undefined)[]; limit: number }) {
  return Array.from(
    new Set(
      input.values
        .map((value) => (value === null || value === undefined ? "" : value.trim()))
        .filter((value): value is string => value !== ""),
    ),
  ).slice(0, input.limit);
}

function stableJson(input: unknown): string {
  if (Array.isArray(input)) {
    return `[${input.map(stableJson).join(",")}]`;
  }
  if (isRecord(input)) {
    const sortedKeys = [...Object.keys(input)].sort();

    return `{${sortedKeys.map((key) => `${JSON.stringify(key)}:${stableJson(input[key])}`).join(",")}}`;
  }

  return JSON.stringify(input);
}

function hashStable(input: unknown) {
  return createHash("sha256").update(stableJson(input)).digest("hex");
}

function dateOnly(value: string) {
  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function calendarDate(value: Date) {
  return value.toISOString().slice(0, ISO_DATE_PREFIX_LENGTH);
}

function daysBeforeDate(input: { value: Date; days: number }) {
  return calendarDate(new Date(input.value.getTime() - input.days * MILLISECONDS_PER_DAY));
}

const PERSONAL_MEETING_PATTERNS = [
  /\bbirthday\b/i,
  /\bbday\b/i,
  /\banniversary\b/i,
  /\bbaby\s+shower\b/i,
  /\bwedding\b/i,
  /\bfamily\b/i,
  /\bkids?\b/i,
  /\bchildren\b/i,
  /\bdoctor\b/i,
  /\bdentist\b/i,
  /\bpediatrician\b/i,
  /\bschool\b/i,
  /\bkindergarten\b/i,
  /\bkindergarden\b/i,
  /\bdaycare\b/i,
  /\beducare\b/i,
  /\bplaydate\b/i,
  /\bgraduation\b/i,
  /\bphotoshoot\b/i,
  /\bparent\s*[/-]?\s*teacher\b/i,
  /\bback\s+to\s+school\b/i,
];

const BUSINESS_MEETING_PATTERNS = [
  /\bbusiness\b/i,
  /\bcustomer\b/i,
  /\bclient\b/i,
  /\bvendor\b/i,
  /\bpartner(ship)?\b/i,
  /\bdemo\b/i,
  /\bsales\b/i,
  /\bproposal\b/i,
  /\bcontract\b/i,
  /\bimplementation\b/i,
  /\bkickoff\b/i,
  /\broadmap\b/i,
  /\breview\b/i,
  /\bstrategy\b/i,
  /\bbudget\b/i,
  /\binvoice\b/i,
  /\binterview\b/i,
  /\bhiring\b/i,
  /\blaunch\b/i,
  /\bboard\b/i,
  /\bqbr\b/i,
];

function classifyCalendarPrepMeetingContext(event: NormalizedCalendarEvent): CalendarPrepMeetingContext {
  const text = `${event.isPrivate ? "" : event.title} ${event.location ?? ""}`.trim();
  if (text === "") {
    return "business";
  }
  if (BUSINESS_MEETING_PATTERNS.some((pattern) => pattern.test(text))) {
    return "business";
  }
  if (PERSONAL_MEETING_PATTERNS.some((pattern) => pattern.test(text))) {
    return "personal";
  }

  return "business";
}

export function calendarPrepProcessorsForMode(mode: CalendarPrepStartMode): {
  peopleProcessor: string;
  companyProcessor: string;
} {
  const defaultProcessor = apiEnv().PARALLEL_MEETING_PREP_PROCESSOR;
  if (mode === "interactive") {
    const interactivePeople = apiEnv().PARALLEL_MEETING_PREP_INTERACTIVE_PEOPLE_PROCESSOR;
    const interactiveCompany = apiEnv().PARALLEL_MEETING_PREP_INTERACTIVE_COMPANY_PROCESSOR;

    return {
      peopleProcessor: interactivePeople !== "" ? interactivePeople : defaultProcessor,
      companyProcessor: interactiveCompany !== "" ? interactiveCompany : defaultProcessor,
    };
  }

  const peopleProcessor = apiEnv().PARALLEL_MEETING_PREP_PEOPLE_PROCESSOR;
  const companyProcessor = apiEnv().PARALLEL_MEETING_PREP_COMPANY_PROCESSOR;

  return {
    peopleProcessor: peopleProcessor !== "" ? peopleProcessor : defaultProcessor,
    companyProcessor: companyProcessor !== "" ? companyProcessor : defaultProcessor,
  };
}

function buildEventFingerprintInput(input: {
  event: NormalizedCalendarEvent;
  meetingContext: CalendarPrepMeetingContext;
}) {
  const event = input.event;
  const meetingContext = input.meetingContext;
  const people = [
    event.organizer
      ? {
          role: "organizer",
          name: calendarPersonName(event.organizer),
          domain: reliableDomainFromEmail(event.organizer.email),
        }
      : null,
    ...event.attendees.map((attendee) => ({
      role: "attendee",
      name: calendarPersonName(attendee),
      domain: reliableDomainFromEmail(attendee.email),
    })),
  ].filter(Boolean);

  return {
    prepLogicVersion: MEETING_PREP_LOGIC_VERSION,
    provider: event.provider,
    providerEventId: event.providerEventId,
    title: event.title,
    start: event.start,
    end: event.end,
    location: event.location,
    meetingContext,
    people,
  };
}

function buildSanitizedEventSnapshot(input: {
  event: NormalizedCalendarEvent;
  people: CalendarPrepPerson[];
  meetingContext: CalendarPrepMeetingContext;
}) {
  const event = input.event;
  const people = input.people;
  const meetingContext = input.meetingContext;

  return {
    id: event.id,
    provider: event.provider,
    providerEventId: event.providerEventId,
    title: event.isPrivate ? "Private event" : event.title,
    start: event.start,
    end: event.end,
    timezone: event.timezone,
    location: event.location,
    isPrivate: event.isPrivate,
    meetingContext,
    participants: people.map((person) => ({
      role: person.role,
      name: person.name,
      email: person.email,
      emailDomain: person.emailDomain,
      isExternal: person.isExternal,
    })),
  };
}

function calendarPrepParticipantExternalFlags(input: {
  domain: string;
  hasDomain: boolean;
  selfComparableEmail: string | null;
  ownEmailSet: Set<string>;
  ownDomainSet: Set<string>;
}) {
  const isOwnCompanyPerson = input.hasDomain && input.ownDomainSet.has(input.domain);
  const hasExternalEmail =
    input.selfComparableEmail !== null &&
    input.selfComparableEmail !== "" &&
    !input.ownEmailSet.has(input.selfComparableEmail);
  const hasExternalCompanyDomain =
    input.hasDomain && (input.ownDomainSet.size === 0 || !input.ownDomainSet.has(input.domain));

  return {
    isExternal: hasExternalCompanyDomain || (hasExternalEmail && !isOwnCompanyPerson),
  };
}

function calendarPrepPersonEntry(input: {
  person: NormalizedCalendarEvent["attendees"][number] | null | undefined;
  role: CalendarPrepPerson["role"];
  index: number;
  userContext: CalendarPrepUserContext;
  ownEmailSet: Set<string>;
  ownDomainSet: Set<string>;
  seen: Set<string>;
}): { person: CalendarPrepPerson; seen: Set<string> } | null {
  if (input.person === null || input.person === undefined) {
    return null;
  }
  const name = calendarPersonName(input.person);
  const email = normalizeEmail(input.person.email);
  const selfComparableEmail = normalizeEmailForSelfComparison(email);
  const emailDomain = reliableDomainFromEmail(input.person.email);
  const hasName = name !== null && name !== "";
  const hasDomain = emailDomain !== null && emailDomain !== "";
  if (!hasName && !hasDomain) {
    return null;
  }
  const nameKey = name?.toLowerCase() ?? "unknown";
  const domainKey = emailDomain ?? "no-domain";
  const dedupeKey = `${nameKey}:${domainKey}`;
  if (input.seen.has(dedupeKey)) {
    return null;
  }
  const seen = new Set(input.seen);
  seen.add(dedupeKey);
  const isCurrentUser = isCurrentUserPerson({
    person: input.person,
    userEmail: input.userContext.userEmail,
    userDisplayName: input.userContext.userDisplayName,
    ownEmailSet: input.ownEmailSet,
  });
  const domain = emailDomain ?? "";
  const externalFlags = calendarPrepParticipantExternalFlags({
    domain,
    hasDomain,
    selfComparableEmail,
    ownEmailSet: input.ownEmailSet,
    ownDomainSet: input.ownDomainSet,
  });
  const isExternal = externalFlags.isExternal;

  return {
    seen,
    person: {
      key: participantKey({ role: input.role, name, emailDomain, index: input.index }),
      role: input.role,
      name,
      email,
      emailDomain,
      isCurrentUser,
      isExternal: isExternal && !isCurrentUser,
    },
  };
}

function collectCalendarPrepPeople(input: {
  event: NormalizedCalendarEvent;
  userContext: CalendarPrepUserContext;
  ownEmailSet: Set<string>;
  ownDomainSet: Set<string>;
}): CalendarPrepPerson[] {
  const entries = [
    { person: input.event.organizer, role: "organizer" as const, index: 0 },
    ...input.event.attendees.map((attendee, index) => ({
      person: attendee,
      role: "attendee" as const,
      index: index + 1,
    })),
  ];
  const collected = entries.reduce<{ people: CalendarPrepPerson[]; seen: Set<string> }>(
    (state, entry) => {
      const next = calendarPrepPersonEntry({
        ...entry,
        userContext: input.userContext,
        ownEmailSet: input.ownEmailSet,
        ownDomainSet: input.ownDomainSet,
        seen: state.seen,
      });
      if (next === null) {
        return state;
      }

      return { people: state.people.concat(next.person), seen: next.seen };
    },
    { people: [], seen: new Set<string>() },
  );

  return collected.people;
}

export function buildCalendarPrepTargetPlan(input: {
  event: NormalizedCalendarEvent;
  userContext: CalendarPrepUserContext;
}): CalendarPrepTargetPlan {
  const ownEmails = compactStringArray({
    values: [input.userContext.userEmail, ...input.userContext.calendarAccountEmails],
    limit: MAX_OWN_EMAILS_FOR_PREP,
  }).flatMap((email) => {
    const normalized = normalizeEmailForSelfComparison(email);

    return normalized === null ? [] : [normalized];
  });
  const ownEmailSet = new Set(ownEmails);
  const ownCompanyDomains = compactStringArray({
    values: [
      reliableDomainFromEmail(input.userContext.userEmail),
      ...input.userContext.calendarAccountEmails.map(reliableDomainFromEmail),
    ],
    limit: MAX_OWN_COMPANY_DOMAINS,
  });
  const ownDomainSet = new Set(ownCompanyDomains);
  const people = collectCalendarPrepPeople({
    event: input.event,
    userContext: input.userContext,
    ownEmailSet,
    ownDomainSet,
  });
  const meetingContext = classifyCalendarPrepMeetingContext(input.event);
  const externalParticipants = people.filter((person) => person.isExternal);
  const peopleTargets =
    meetingContext === "personal"
      ? []
      : externalParticipants
          .filter((person) => person.emailDomain !== null && person.emailDomain !== "")
          .slice(0, MAX_PEOPLE_TARGETS);
  const externalOrganizer = externalParticipants.find(
    (person) => person.role === "organizer" && person.emailDomain !== null && person.emailDomain !== "",
  );
  const domainCounts = externalParticipants.reduce((counts, person) => {
    if (person.emailDomain === null || person.emailDomain === "") {
      return counts;
    }
    const current = counts.get(person.emailDomain) ?? { count: 0, names: [] };

    return new Map(counts).set(person.emailDomain, {
      count: current.count + 1,
      names: person.name !== null && person.name !== "" ? current.names.concat(person.name) : current.names,
    });
  }, new Map<string, { count: number; names: string[] }>());
  const majorityDomain = [...domainCounts.entries()].sort((left, right) => right[1].count - left[1].count)[0];
  const companyDomain =
    meetingContext === "personal" ? null : (externalOrganizer?.emailDomain ?? majorityDomain?.[0] ?? null);
  const companyNames =
    companyDomain !== null && companyDomain !== "" ? (domainCounts.get(companyDomain)?.names ?? []) : [];

  return {
    eventFingerprint: hashStable(buildEventFingerprintInput({ event: input.event, meetingContext })),
    eventSnapshot: buildSanitizedEventSnapshot({ event: input.event, people, meetingContext }),
    meetingContext,
    ownCompanyDomains,
    externalParticipants,
    peopleTargets,
    companyTarget:
      companyDomain !== null && companyDomain !== ""
        ? {
            domain: companyDomain,
            participantNames: compactStringArray({ values: companyNames, limit: MAX_COMPANY_PARTICIPANT_NAMES }),
          }
        : null,
  };
}

function jsonSchema(schema: Record<string, unknown>) {
  return {
    type: "json",
    json_schema: schema,
  };
}

const peopleOutputSchema = {
  type: "object",
  description:
    "Public professional intelligence for one meeting participant. Focus on current role, scope, recent professional signals, and why the person matters for this meeting. Do not include suggested questions or conversation angles.",
  /** @external JSON Schema object constraint */
  /** @external JSON Schema object constraint */
  additionalProperties: false,
  properties: {
    participant_identity: {
      type: "object",
      description:
        "Best public identification of the participant. If identity is ambiguous, mark fields null and explain in unknown_or_low_confidence_items.",
      /** @external JSON Schema object constraint */
      /** @external JSON Schema object constraint */
      additionalProperties: false,
      properties: {
        name: {
          type: ["string", "null"],
          description: "Participant public professional name.",
        },
        current_title: {
          type: ["string", "null"],
          description: "Current title from public professional or company sources.",
        },
        current_company: {
          type: ["string", "null"],
          description: "Current company or organization from public professional or company sources.",
        },
        public_profile_url: {
          type: ["string", "null"],
          description: "Most relevant public professional profile URL if found.",
        },
      },
      required: ["name", "current_title", "current_company", "public_profile_url"],
    },
    likely_scope: {
      type: ["string", "null"],
      description:
        "One to two sentences on what this person appears responsible for professionally, based only on public title, bio, profile, company page, or public work. Do not infer private responsibilities.",
    },
    why_this_person_matters_for_meeting: {
      type: ["string", "null"],
      description:
        "One to two concise sentences explaining why this participant is relevant to this specific meeting, using the meeting title and public role/company context. Do not suggest questions.",
    },
    recent_professional_signals: {
      type: "array",
      description:
        "Zero to four recent public professional signals from the last 180 days, newest first: role change, public article/post, conference talk, product launch, hiring area, announcement, open-source/product activity, board/advisor role, or company initiative connected to them. Return an empty array if no useful recent signal is found.",
      items: {
        type: "object",
        /** @external JSON Schema object constraint */
        /** @external JSON Schema object constraint */
        additionalProperties: false,
        properties: {
          date: {
            type: ["string", "null"],
            description: "Date in YYYY-MM-DD, YYYY-MM, or YYYY if available.",
          },
          signal: {
            type: "string",
            description: "Concise factual sentence describing the public professional signal.",
          },
          meeting_relevance: {
            type: "string",
            description:
              "Why this signal matters for understanding the participant in this meeting. Do not phrase as a question.",
          },
        },
        required: ["date", "signal", "meeting_relevance"],
      },
    },
    relevant_background: {
      type: "array",
      description:
        "Only background facts that are directly useful for this meeting: prior roles, domain expertise, founder/executive history, product area, publications, technical specialty, investment/board roles, or public responsibilities. Avoid generic career summaries.",
      items: {
        type: "object",
        /** @external JSON Schema object constraint */
        /** @external JSON Schema object constraint */
        additionalProperties: false,
        properties: {
          fact: {
            type: "string",
            description: "Concise factual background item.",
          },
          why_it_matters: {
            type: "string",
            description: "Why this background is useful for the current meeting.",
          },
        },
        required: ["fact", "why_it_matters"],
      },
    },
    company_connection: {
      type: ["string", "null"],
      description:
        "Concise explanation of how this participant appears connected to the external company or meeting domain. Return null if not clear.",
    },
    unknown_or_low_confidence_items: {
      type: "array",
      description:
        "Identity ambiguity, insufficient public evidence, conflicting roles, stale profile data, or anything important that could not be verified. Use this instead of guessing.",
      items: { type: "string" },
    },
  },
  required: [
    "participant_identity",
    "likely_scope",
    "why_this_person_matters_for_meeting",
    "recent_professional_signals",
    "relevant_background",
    "company_connection",
    "unknown_or_low_confidence_items",
  ],
};

const companyOutputSchema = {
  type: "object",
  description:
    "A concise, source-grounded company intelligence brief for meeting preparation. Return only public, current, meeting-relevant information. Do not include suggested questions or conversation angles.",
  /** @external JSON Schema object constraint */
  /** @external JSON Schema object constraint */
  additionalProperties: false,
  properties: {
    company_identity: {
      type: "object",
      description:
        "Basic identity for the external company. Use the most current public source. If a field cannot be verified, return null.",
      /** @external JSON Schema object constraint */
      /** @external JSON Schema object constraint */
      additionalProperties: false,
      properties: {
        name: {
          type: ["string", "null"],
          description: "Current legal or commonly used company name.",
        },
        website: {
          type: ["string", "null"],
          description: "Official company website URL.",
        },
        one_line_business_description: {
          type: ["string", "null"],
          description:
            "One sentence describing what the company does, using current public sources. Avoid marketing fluff.",
        },
        company_stage_or_type: {
          type: ["string", "null"],
          description:
            "Public/private, startup/enterprise/public company/nonprofit/etc., plus funding stage or ticker if publicly available.",
        },
        headquarters_or_main_location: {
          type: ["string", "null"],
          description: "Headquarters or main operating location if publicly available.",
        },
      },
      required: [
        "name",
        "website",
        "one_line_business_description",
        "company_stage_or_type",
        "headquarters_or_main_location",
      ],
    },
    why_this_company_context_matters: {
      type: ["string", "null"],
      description:
        "Two to three sentences explaining the most important context someone should know before this specific meeting, based on the meeting title, participant names, and company context. Do not suggest what to ask.",
    },
    latest_signals: {
      type: "array",
      description:
        "The most important 3 to 6 public developments from the last 90 days, newest first. Include only developments that would materially help someone prepare for this meeting: product launches, funding, earnings, partnerships, customer wins, leadership changes, layoffs, regulatory/legal issues, security incidents, market expansion, pricing/package changes, or major strategic announcements. If no strong recent signals are found, return an empty array.",
      items: {
        type: "object",
        /** @external JSON Schema object constraint */
        /** @external JSON Schema object constraint */
        additionalProperties: false,
        properties: {
          date: {
            type: ["string", "null"],
            description:
              "Date of the development in YYYY-MM-DD if available, otherwise YYYY-MM or YYYY. Return null if no date is available.",
          },
          signal: {
            type: "string",
            description:
              "One concise factual sentence describing what happened. Include company/product/person names where relevant.",
          },
          why_it_matters_for_meeting: {
            type: "string",
            description:
              "One concise sentence explaining why this signal matters for this meeting. Do not phrase as a question.",
          },
          source_type: {
            type: ["string", "null"],
            description:
              "Type of source used, such as official announcement, investor filing, reputable news, product changelog, job posting, or partnership page.",
          },
        },
        required: ["date", "signal", "why_it_matters_for_meeting", "source_type"],
      },
    },
    current_company_priorities: {
      type: "array",
      description:
        "Current company priorities inferred from public evidence. Use only evidence-backed priorities, such as hiring patterns, product releases, executive statements, earnings commentary, partnerships, customer announcements, or roadmap/changelog activity. Return an empty array if priorities are not publicly clear.",
      items: {
        type: "object",
        /** @external JSON Schema object constraint */
        /** @external JSON Schema object constraint */
        additionalProperties: false,
        properties: {
          priority: {
            type: "string",
            description:
              "Concise name of the apparent company priority, such as enterprise expansion, AI product launch, cost reduction, international growth, security/compliance, developer adoption, or channel partnerships.",
          },
          evidence: {
            type: "string",
            description: "One concise factual sentence supporting this priority from public information.",
          },
          meeting_relevance: {
            type: "string",
            description: "Why this priority could affect the meeting context. Do not suggest questions.",
          },
        },
        required: ["priority", "evidence", "meeting_relevance"],
      },
    },
    business_health_or_momentum: {
      type: "array",
      description:
        "Evidence-backed indicators of company momentum or pressure. Include funding, revenue/earnings, hiring or layoffs, customer traction, market expansion, churn signals, major partnerships, or public financial performance. Return an empty array if not available.",
      items: {
        type: "object",
        /** @external JSON Schema object constraint */
        /** @external JSON Schema object constraint */
        additionalProperties: false,
        properties: {
          indicator: {
            type: "string",
            description:
              "Concise factual indicator, such as latest funding, earnings growth, layoffs, hiring push, major customer win, or partnership.",
          },
          date: {
            type: ["string", "null"],
            description: "Date in YYYY-MM-DD, YYYY-MM, or YYYY if available.",
          },
          interpretation: {
            type: "string",
            description: "Brief neutral interpretation of what this suggests about company momentum or pressure.",
          },
        },
        required: ["indicator", "date", "interpretation"],
      },
    },
    product_or_market_context: {
      type: "array",
      description:
        "Recent product, market, competitive, pricing, regulatory, or category context that would help someone understand the company current situation. Prefer the last 180 days. Return an empty array if no useful context is found.",
      items: {
        type: "object",
        /** @external JSON Schema object constraint */
        /** @external JSON Schema object constraint */
        additionalProperties: false,
        properties: {
          context: {
            type: "string",
            description: "Concise factual context.",
          },
          why_it_matters: {
            type: "string",
            description: "Why this context matters for understanding the meeting.",
          },
        },
        required: ["context", "why_it_matters"],
      },
    },
    risks_or_sensitive_context: {
      type: "array",
      description:
        "Neutral, evidence-backed risks or sensitive public context: lawsuits, regulatory scrutiny, security incidents, layoffs, executive departures, customer backlash, financial distress, or reputational issues. Include only reputable/public sources. Do not speculate. Return an empty array if none found.",
      items: {
        type: "object",
        /** @external JSON Schema object constraint */
        /** @external JSON Schema object constraint */
        additionalProperties: false,
        properties: {
          issue: {
            type: "string",
            description: "Concise factual description of the issue.",
          },
          date: {
            type: ["string", "null"],
            description: "Date in YYYY-MM-DD, YYYY-MM, or YYYY if available.",
          },
          meeting_relevance: {
            type: "string",
            description: "Why this issue may matter for meeting preparation, stated neutrally.",
          },
        },
        required: ["issue", "date", "meeting_relevance"],
      },
    },
    unknown_or_low_confidence_items: {
      type: "array",
      description:
        "Important meeting-relevant facts that could not be verified with sufficient public evidence, such as unclear current role, unclear company status, no recent news, conflicting headcount, or ambiguous company identity. This should prevent stale or guessed prep.",
      items: { type: "string" },
    },
  },
  required: [
    "company_identity",
    "why_this_company_context_matters",
    "latest_signals",
    "current_company_priorities",
    "business_health_or_momentum",
    "product_or_market_context",
    "risks_or_sensitive_context",
    "unknown_or_low_confidence_items",
  ],
};

const companyMeetingInstructions = [
  "Use public professional and company information only.",
  "Produce a concise meeting intelligence brief, not questions, icebreakers, or conversation suggestions.",
  "Prioritize information from the last 90 days. Use older information only if necessary background.",
  "For every recent development, include a concrete date or month when available.",
  "When writing dates inside prose fields, use M/D/YYYY for complete dates and M/YYYY for month-only dates. Do not write ISO-style YYYY-MM-DD or YYYY-MM in prose.",
  "Prefer official company pages, investor relations pages, SEC filings, company blogs, product/changelog pages, reputable business/tech news, funding announcements, partnership announcements, and credible job postings.",
  "Do not guess. If public evidence is weak, return null or an empty array.",
  "Keep every item directly useful for understanding this meeting: what changed, why it matters, and how it affects the company/person/context.",
  "Avoid personal, sensitive, speculative, or private information.",
  "Do not return conversation angles, suggested questions, rapport-builders, or generic profile summaries.",
];

const peopleMeetingInstructions = [
  "Use public professional and company information only.",
  "Produce concise meeting intelligence, not questions, icebreakers, or conversation suggestions.",
  "Prioritize the participant current role, current company, scope, recent professional activity, and any public work connected to the meeting topic.",
  "If the meeting title is clearly personal or social rather than professional, return no professional relevance claims.",
  "Prefer official company bio pages, LinkedIn/public professional profiles, conference pages, company blogs, reputable news, GitHub/product/docs pages when relevant, and public posts/articles.",
  "Do not guess identity. If the participant cannot be confidently matched, return insufficient public context.",
  "If exact_email_identity_hints are provided, use them only to resolve the participant full name for that exact email. Do not use private email history for public role, company, or professional claims.",
  "When writing dates inside prose fields, use M/D/YYYY for complete dates and M/YYYY for month-only dates. Do not write ISO-style YYYY-MM-DD or YYYY-MM in prose.",
  "Avoid personal, sensitive, speculative, or private information.",
  "Do not return conversation angles, suggested questions, rapport-builders, or generic profile summaries.",
];

function meetingInput(input: {
  event: NormalizedCalendarEvent;
  freshnessWindowDays: number;
  instructions: string[];
  now?: Date;
}) {
  const now = input.now ?? new Date();

  return {
    title: input.event.isPrivate ? "Private event" : input.event.title,
    start: dateOnly(input.event.start),
    end: dateOnly(input.event.end),
    location: input.event.location,
    current_date: calendarDate(now),
    freshness_window_days: input.freshnessWindowDays,
    instructions: input.instructions,
  };
}

function buildPeopleRun(input: {
  event: NormalizedCalendarEvent;
  person: CalendarPrepPerson;
  processor: string;
  companyDomain: string | null;
  identityHints?: MeetingBriefIdentityHint[];
}): ParallelRunInput {
  const exactEmailIdentityHints =
    input.identityHints
      ?.filter((hint) => hint.participantKey === input.person.key)
      .map((hint) => ({
        email: hint.email,
        display_name: hint.displayName,
        confidence: hint.confidence,
        reason: hint.reason,
      })) ?? [];

  return {
    input: {
      task_type: "meeting_participant_public_intelligence",
      meeting: meetingInput({
        event: input.event,
        freshnessWindowDays: PEOPLE_FRESHNESS_WINDOW_DAYS,
        instructions: peopleMeetingInstructions,
      }),
      participant: {
        display_name: input.person.name,
        email: input.person.email,
        email_domain: input.person.emailDomain,
        inferred_company_domain: input.companyDomain,
        role_in_calendar: input.person.role,
        exact_email_identity_hints: exactEmailIdentityHints,
      },
    },
    processor: input.processor,
    metadata: {
      kind: "people",
      key: input.person.key.slice(0, PARALLEL_METADATA_VALUE_MAX_LENGTH),
    },
    task_spec: {
      output_schema: jsonSchema(peopleOutputSchema),
    },
    enable_events: true,
  };
}

function buildCompanyRun(input: {
  event: NormalizedCalendarEvent;
  target: NonNullable<CalendarPrepTargetPlan["companyTarget"]>;
  processor: string;
  latestSearchContext?: CompanyLatestSearchContext | null;
}): ParallelRunInput {
  return {
    input: {
      task_type: "meeting_external_company_intelligence",
      meeting: meetingInput({
        event: input.event,
        freshnessWindowDays: COMPANY_FRESHNESS_WINDOW_DAYS,
        instructions: companyMeetingInstructions,
      }),
      company_hint: {
        domain: input.target.domain,
        participant_names: input.target.participantNames,
      },
      latest_public_context: input.latestSearchContext
        ? {
            source: "parallel_search",
            search_id: input.latestSearchContext.searchId,
            session_id: input.latestSearchContext.sessionId,
            after_date: input.latestSearchContext.afterDate,
            results: input.latestSearchContext.results,
          }
        : null,
    },
    processor: input.processor,
    metadata: {
      kind: "company",
      domain: input.target.domain.slice(0, PARALLEL_METADATA_VALUE_MAX_LENGTH),
    },
    task_spec: {
      output_schema: jsonSchema(companyOutputSchema),
    },
    enable_events: true,
  };
}

export function buildCalendarPrepParallelRuns(input: {
  event: NormalizedCalendarEvent;
  plan: CalendarPrepTargetPlan;
  processor?: string;
  peopleProcessor?: string;
  companyProcessor?: string;
  companySearchContext?: CompanyLatestSearchContext | null;
  identityHints?: MeetingBriefIdentityHint[];
}): {
  ref: Omit<PrepRunRef, "runId">;
  run: ParallelRunInput;
}[] {
  const peopleProcessor = input.peopleProcessor ?? input.processor ?? apiEnv().PARALLEL_MEETING_PREP_PROCESSOR;
  const companyProcessor = input.companyProcessor ?? input.processor ?? apiEnv().PARALLEL_MEETING_PREP_PROCESSOR;
  const companyDomain = input.plan.companyTarget?.domain ?? null;
  const peopleRuns = input.plan.peopleTargets.map((person) => ({
    ref: {
      kind: "people" as const,
      participantKey: person.key,
      name: person.name,
      domain: person.emailDomain,
    },
    run: buildPeopleRun({
      event: input.event,
      person,
      processor: peopleProcessor,
      companyDomain,
      identityHints: input.identityHints,
    }),
  }));
  const companyRun = input.plan.companyTarget
    ? [
        {
          ref: {
            kind: "company" as const,
            domain: input.plan.companyTarget.domain,
          },
          run: buildCompanyRun({
            event: input.event,
            target: input.plan.companyTarget,
            processor: companyProcessor,
            latestSearchContext: input.companySearchContext ?? null,
          }),
        },
      ]
    : [];

  return [...peopleRuns, ...companyRun];
}

export function buildCompanyLatestSearchRequest(input: {
  event: NormalizedCalendarEvent;
  target: NonNullable<CalendarPrepTargetPlan["companyTarget"]>;
  now?: Date;
}): { afterDate: string; body: Record<string, unknown> } {
  const now = input.now ?? new Date();
  const afterDate = daysBeforeDate({ value: now, days: COMPANY_FRESHNESS_WINDOW_DAYS });
  const companyLabel = input.target.domain;
  const meetingTitle = input.event.isPrivate ? "Private event" : input.event.title;

  return {
    afterDate,
    body: {
      objective:
        `Find the most recent public developments about ${companyLabel} that would matter before a business meeting on ${meetingTitle}. ` +
        `Focus on the last ${COMPANY_FRESHNESS_WINDOW_DAYS} days: product launches, funding, earnings, partnerships, leadership changes, customer wins, layoffs, legal or regulatory issues, security incidents, pricing changes, and major market moves. Prefer official company sources and reputable business or tech news. Do not return generic company profile pages unless they contain recent updates.`,
      search_queries: [
        `${companyLabel} latest news`,
        `${companyLabel} product partnership funding`,
        `${companyLabel} leadership layoffs security`,
      ],
      mode: "turbo",
      max_chars_total: COMPANY_SEARCH_MAX_CHARS_TOTAL,
      advanced_settings: {
        source_policy: {
          after_date: afterDate,
        },
        fetch_policy: {
          max_age_seconds: COMPANY_SEARCH_FETCH_MAX_AGE_SECONDS,
        },
      },
    },
  };
}

function sanitizeCompanyLatestSearchResponseNamed(input: {
  response: ParallelSearchResponse;
  afterDate: string;
}): CompanyLatestSearchContext {
  const results = Array.isArray(input.response.results)
    ? input.response.results
        .flatMap((result): CompanyLatestSearchContext["results"] => {
          const title = asString(result.title);
          const url = normalizeUrl(asString(result.url));
          if (title === "" || url === null) {
            return [];
          }

          const publishDateRaw = asString(result.publish_date);

          return [
            {
              title,
              url,
              publishDate: publishDateRaw === "" ? null : publishDateRaw,
              excerpts: compactStringArray({
                values: (result.excerpts ?? []).map((excerpt) =>
                  typeof excerpt === "string" ? excerpt.slice(0, SEARCH_EXCERPT_MAX_CHARS) : null,
                ),
                limit: MAX_SEARCH_EXCERPTS_PER_RESULT,
              }),
            },
          ];
        })
        .slice(0, MAX_COMPANY_SEARCH_RESULTS)
    : [];

  const searchId = asString(input.response.search_id);
  const sessionId = asString(input.response.session_id);

  return {
    searchId: searchId === "" ? null : searchId,
    sessionId: sessionId === "" ? null : sessionId,
    afterDate: input.afterDate,
    results,
  };
}

export function sanitizeCompanyLatestSearchResponse(
  ...args: [response: ParallelSearchResponse, afterDate: string]
): CompanyLatestSearchContext {
  return sanitizeCompanyLatestSearchResponseNamed({ response: args[0], afterDate: args[1] });
}

export class ParallelMeetingPrepClient {
  constructor(private readonly apiKey: string) {}

  async createTaskGroup(metadata: Record<string, string>): Promise<ParallelTaskGroup> {
    return this.request<ParallelTaskGroup>({
      path: "/v1beta/tasks/groups",
      init: {
        method: "POST",
        headers: {
          "parallel-beta": PARALLEL_EVENTS_BETA_HEADER,
        },
        body: JSON.stringify({ metadata }),
      },
    });
  }

  async addRuns(...args: [taskgroupId: string, inputs: ParallelRunInput[]]): Promise<ParallelAddRunsResponse> {
    return this.addRunsNamed({ taskgroupId: args[0], inputs: args[1] });
  }

  async retrieveTaskGroup(taskgroupId: string): Promise<ParallelTaskGroup> {
    return this.request<ParallelTaskGroup>({ path: `/v1beta/tasks/groups/${encodeURIComponent(taskgroupId)}` });
  }

  async retrieveRunResult(runId: string): Promise<ParallelRunResult> {
    const query = new URLSearchParams({ timeout: "1" });

    return this.request<ParallelRunResult>({
      path: `/v1/tasks/runs/${encodeURIComponent(runId)}/result?${query.toString()}`,
      init: {
        method: "GET",
        headers: {
          "parallel-beta": "field-basis-2025-11-25",
        },
      },
    });
  }

  async searchCompanyLatestSignals(
    ...args: [body: Record<string, unknown>, signal?: AbortSignal]
  ): Promise<ParallelSearchResponse> {
    return this.searchCompanyLatestSignalsNamed({ body: args[0], signal: args[1] });
  }

  async extractUrls(...args: [body: Record<string, unknown>, signal?: AbortSignal]): Promise<ParallelExtractResponse> {
    return this.extractUrlsNamed({ body: args[0], signal: args[1] });
  }

  async createFindAllRun(body: Record<string, unknown>): Promise<ParallelFindAllRunResponse> {
    return this.request<ParallelFindAllRunResponse>({
      path: "/v1beta/findall/runs",
      init: {
        method: "POST",
        headers: {
          "parallel-beta": "findall-2025-09-15",
        },
        body: JSON.stringify(body),
      },
    });
  }

  async retrieveFindAllRun(findallId: string): Promise<ParallelFindAllRunResponse> {
    return this.request<ParallelFindAllRunResponse>({
      path: `/v1beta/findall/runs/${encodeURIComponent(findallId)}`,
      init: {
        method: "GET",
        headers: {
          "parallel-beta": "findall-2025-09-15",
        },
      },
    });
  }

  async retrieveFindAllRunResult(findallId: string): Promise<ParallelFindAllResultResponse> {
    return this.request<ParallelFindAllResultResponse>({
      path: `/v1beta/findall/runs/${encodeURIComponent(findallId)}/result`,
      init: {
        method: "GET",
        headers: {
          "parallel-beta": "findall-2025-09-15",
        },
      },
    });
  }

  async retrieveFindAllRunEvents(findallId: string): Promise<ParallelRunEvent[]> {
    const query = new URLSearchParams({ timeout: "4" });
    const text = await this.requestText({
      path: `/v1beta/findall/runs/${encodeURIComponent(findallId)}/events?${query.toString()}`,
      init: {
        method: "GET",
        headers: {
          "parallel-beta": "findall-2025-09-15",
        },
      },
    });

    return parseParallelRunEvents(text);
  }

  async retrieveRunEvents(runId: string): Promise<ParallelRunEvent[]> {
    const query = new URLSearchParams({ timeout: "4" });
    const text = await this.requestText({
      path: `/v1beta/tasks/runs/${encodeURIComponent(runId)}/events?${query.toString()}`,
      init: { method: "GET" },
    });

    return parseParallelRunEvents(text);
  }

  private async addRunsNamed(input: {
    taskgroupId: string;
    inputs: ParallelRunInput[];
  }): Promise<ParallelAddRunsResponse> {
    return this.request<ParallelAddRunsResponse>({
      path: `/v1beta/tasks/groups/${encodeURIComponent(input.taskgroupId)}/runs`,
      init: {
        method: "POST",
        headers: {
          "parallel-beta": PARALLEL_EVENTS_BETA_HEADER,
        },
        body: JSON.stringify({ inputs: input.inputs }),
      },
    });
  }

  private async searchCompanyLatestSignalsNamed(input: {
    body: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<ParallelSearchResponse> {
    return parallelSearchTurbo<ParallelSearchResponse>({
      apiKey: this.apiKey,
      body: input.body,
      signal: input.signal,
    });
  }

  private async extractUrlsNamed(input: {
    body: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<ParallelExtractResponse> {
    return this.request<ParallelExtractResponse>({
      path: "/v1/extract",
      init: {
        method: "POST",
        signal: input.signal,
        body: JSON.stringify(input.body),
      },
    });
  }

  private async request<T extends Record<string, unknown>>(input: { path: string; init?: RequestInit }): Promise<T> {
    const init = input.init ?? {};
    const headers = new Headers({
      "content-type": "application/json",
      "x-api-key": this.apiKey,
    });
    new Headers(init.headers).forEach((value, name) => {
      headers.set(name, value);
    });
    const response = await fetch(`${PARALLEL_API_BASE_URL}${input.path}`, { ...init, headers });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(formatParallelRequestFailedMessage({ status: response.status, bodyText: text }));
    }

    const jsonPayload: unknown = await response.json();
    const parsed = z.custom<T>((value) => jsonRecordSchema.safeParse(value).success).safeParse(jsonPayload);
    if (!parsed.success) {
      throw new Error(formatParallelRequestFailedMessage({ status: response.status, bodyText: "" }));
    }

    return parsed.data;
  }

  private async readSseSample(input: {
    reader: ReadableStreamDefaultReader<Uint8Array>;
    decoder: TextDecoder;
    deadlineMs: number;
    chunks: string[];
  }): Promise<string> {
    if (Date.now() >= input.deadlineMs) {
      return [...input.chunks, input.decoder.decode()].join("");
    }
    const remainingMs = Math.max(1, input.deadlineMs - Date.now());
    const result = await Promise.race([
      input.reader.read(),
      new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), remainingMs);
      }),
    ]);
    if (result === "timeout") {
      return [...input.chunks, input.decoder.decode()].join("");
    }
    if (result.done) {
      return [...input.chunks, input.decoder.decode()].join("");
    }

    return this.readSseSample({
      reader: input.reader,
      decoder: input.decoder,
      deadlineMs: input.deadlineMs,
      chunks: [...input.chunks, input.decoder.decode(result.value, { stream: true })],
    });
  }

  private async requestText(input: { path: string; init?: RequestInit; sampleMs?: number }): Promise<string> {
    const init = input.init ?? {};
    const sampleMs = input.sampleMs ?? PARALLEL_SSE_SAMPLE_MS_DEFAULT;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), sampleMs + PARALLEL_SSE_TIMEOUT_PADDING_MS);
    try {
      const headers = new Headers({
        accept: "text/event-stream",
        "content-type": "text/event-stream",
        "parallel-beta": PARALLEL_EVENTS_BETA_HEADER,
        "x-api-key": this.apiKey,
      });
      new Headers(init.headers).forEach((value, name) => {
        headers.set(name, value);
      });
      const response = await fetch(`${PARALLEL_API_BASE_URL}${input.path}`, {
        ...init,
        signal: controller.signal,
        headers,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(formatParallelRequestFailedMessage({ status: response.status, bodyText: text }));
      }

      if (response.body === null) {
        return await response.text();
      }

      clearTimeout(timeout);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const deadlineMs = Date.now() + sampleMs;
      const bodyText = await this.readSseSample({ reader, decoder, deadlineMs, chunks: [] });
      const cancelOutcome = await (async (): Promise<unknown> => {
        try {
          await reader.cancel();

          return null;
        } catch (error) {
          return error;
        }
      })();
      if (cancelOutcome !== null) {
        const cancelFailed = cancelOutcome instanceof Error ? cancelOutcome.name : typeof cancelOutcome;
        if (cancelFailed.length === 0 && !(cancelOutcome instanceof Error)) {
          if (cancelOutcome instanceof Error) {
            throw cancelOutcome;
          }
          throw new Error(MESSAGE_PARALLEL_STREAM_CANCEL_FAILED);
        }
      }

      return bodyText;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clampPercent(value: number) {
  const normalized = value >= PROGRESS_PERCENT_MIN && value <= 1 ? value * PROGRESS_PERCENT_SCALE : value;

  return Math.min(PROGRESS_PERCENT_MAX, Math.max(PROGRESS_PERCENT_MIN, Math.round(normalized)));
}

function statusFromParallelState(value: unknown): CalendarEventPrepResponse["status"] | null {
  const state = asString(value)
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (state === "") {
    return null;
  }
  if (["completed", "complete", "succeeded", "success", "done"].includes(state)) {
    return "completed";
  }
  if (["failed", "failure", "error", "errored", "cancelled", "canceled"].includes(state)) {
    return "failed";
  }
  if (["running", "processing", "executing", "in_progress", "active"].includes(state)) {
    return "running";
  }
  if (["queued", "pending", "created", "waiting", "not_started"].includes(state)) {
    return "pending";
  }

  return null;
}

function progressPercentFromMeter(value: unknown): number | null {
  const directNumber = asNumber(value);
  if (directNumber !== null) {
    return clampPercent(directNumber);
  }

  if (!isRecord(value)) {
    return null;
  }

  const percentKey = ["percent", "percentage", "progress", "value"].find((key) => asNumber(value[key]) !== null);
  if (percentKey !== undefined) {
    const percent = asNumber(value[percentKey]);
    if (percent !== null) {
      return clampPercent(percent);
    }
  }

  const completed = asNumber(value.completed) ?? asNumber(value.current);
  const total = asNumber(value.total) ?? asNumber(value.max);
  if (completed !== null && total !== null && total > 0) {
    return clampPercent((completed / total) * PROGRESS_PERCENT_SCALE);
  }

  return null;
}

const MAX_RAW_PROGRESS_MESSAGES = 20;
const MAX_RAW_PROGRESS_MESSAGE_LENGTH = 240;
const PROGRESS_MESSAGE_ELLIPSIS_CHARS = 3;
const MAX_HOSTNAME_PATH_LABEL_CHARS = 90;
const MAX_PROGRESS_SOURCE_LIST_ITEMS = 6;

function normalizeRawProgressMessage(value: unknown): string | null {
  const raw = asString(value).replace(/\s+/g, " ");
  if (raw === "") {
    return null;
  }
  if (/^Research progress 0%$/i.test(raw) || /^Researching .+: 0%$/i.test(raw)) {
    return null;
  }

  const redacted = raw
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b(?:sk|pk|rk|l44)[A-Za-z0-9_-]{20,}\b/g, "[secret]");

  return redacted.length > MAX_RAW_PROGRESS_MESSAGE_LENGTH
    ? `${redacted.slice(0, MAX_RAW_PROGRESS_MESSAGE_LENGTH - PROGRESS_MESSAGE_ELLIPSIS_CHARS).trimEnd()}...`
    : redacted;
}

function mergeRawProgressMessages(messages: readonly string[]) {
  const normalized = messages.flatMap((message) => {
    const nextMessage = normalizeRawProgressMessage(message);

    return nextMessage === null ? [] : [nextMessage];
  });
  const deduped = normalized.reduce<{ items: string[]; seen: Set<string> }>(
    (state, message) => {
      if (state.seen.has(message)) {
        return state;
      }

      return {
        items: state.items.concat(message),
        seen: new Set(state.seen).add(message),
      };
    },
    { items: [], seen: new Set<string>() },
  );

  return deduped.items.slice(-MAX_RAW_PROGRESS_MESSAGES);
}

function progressMessageFieldsFromRecord(record: Record<string, unknown>): string[] {
  const messages: unknown[] = [
    record.message,
    record.text,
    record.label,
    record.status,
    record.phase,
    record.step,
    record.title,
  ];

  return messages.flatMap((message) => {
    const normalized = normalizeRawProgressMessage(message);

    return normalized === null ? [] : [normalized];
  });
}

function firstNonEmptyString(values: string[]): string | null {
  const match = values.find((value) => value !== "");

  return match ?? null;
}

function progressSourceLabel(value: unknown): string | null {
  if (isRecord(value)) {
    const title = firstNonEmptyString([asString(value.title), asString(value.name)]);
    const urlLabel = progressSourceLabel(value.url ?? value.href);
    if (title !== null && urlLabel !== null) {
      return `${title} (${urlLabel})`;
    }

    return firstNonEmptyString([title ?? "", urlLabel ?? ""]);
  }

  const raw = asString(value);
  if (raw === "") {
    return null;
  }

  try {
    const url = new URL(raw);
    const hostname = url.hostname.replace(/^www\./, "");
    const path = url.pathname !== "" && url.pathname !== "/" ? url.pathname.replace(/\/$/, "") : "";

    return `${hostname}${path}`.slice(0, MAX_HOSTNAME_PATH_LABEL_CHARS);
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }

    const fallback = raw
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .trim()
      .slice(0, MAX_HOSTNAME_PATH_LABEL_CHARS);

    return fallback === "" ? null : fallback;
  }
}

function progressSourceSamples(sourceStats: Record<string, unknown>) {
  const preferredKeys = [
    "sources_read_sample",
    "sources_selected_sample",
    "sources_considered_sample",
    "source_urls",
    "urls",
  ];
  const preferredSamples = preferredKeys.flatMap((key): unknown[] => {
    const value = sourceStats[key];

    return Array.isArray(value) ? value : [];
  });
  const extraSamples = Object.entries(sourceStats).flatMap(([key, value]): unknown[] => {
    if (!Array.isArray(value) || !/(source|url)/i.test(key) || preferredKeys.includes(key)) {
      return [];
    }

    return value;
  });
  const samples = preferredSamples.concat(extraSamples);

  return Array.from(
    new Set(
      samples.flatMap((source) => {
        const label = progressSourceLabel(source);

        return label === null ? [] : [label];
      }),
    ),
  ).slice(0, MAX_PROGRESS_SOURCE_LIST_ITEMS);
}

function progressStatsFromRecord(record: Record<string, unknown>) {
  const taskRun = isRecord(record.task_run) ? record.task_run : record;

  return isRecord(taskRun.progress_stats)
    ? taskRun.progress_stats
    : isRecord(record.progress_stats)
      ? record.progress_stats
      : asString(taskRun.type) === "task_run.progress_stats" || asString(record.type) === "task_run.progress_stats"
        ? taskRun
        : null;
}

function progressStatsWithoutSourceMessages(input: {
  progressStats: Record<string, unknown> | null;
  record: Record<string, unknown>;
}): string[] {
  const progressPercent = input.progressStats
    ? progressPercentFromMeter(input.progressStats.progress_meter ?? input.record.progress_meter)
    : null;

  return progressPercent === null ? [] : [`Research progress ${Math.round(progressPercent)}%`];
}

function progressStatsSourceCountMessages(sourceStats: Record<string, unknown>): string[] {
  const sourcesConsidered = asNumber(sourceStats.num_sources_considered);
  const sourcesRead = asNumber(sourceStats.num_sources_read);
  if (sourcesConsidered !== null && sourcesRead !== null && sourcesRead > 0) {
    return [`Considered ${Math.round(sourcesConsidered)} sources and read ${Math.round(sourcesRead)}`];
  }
  if (sourcesConsidered !== null && sourcesConsidered > 0) {
    return [`Considered ${Math.round(sourcesConsidered)} sources`];
  }
  if (sourcesRead !== null && sourcesRead > 0) {
    return [`Read ${Math.round(sourcesRead)} sources`];
  }

  return [];
}

function rawProgressStatsMessagesFromRecord(input: {
  record: Record<string, unknown>;
  eventType: string | null;
}): string[] {
  const recordType = asString(input.record.type);
  if (input.eventType !== "task_run.progress_stats" && recordType !== "task_run.progress_stats") {
    return [];
  }

  const progressStats = progressStatsFromRecord(input.record);
  const sourceStats =
    progressStats !== null && isRecord(progressStats.source_stats) ? progressStats.source_stats : null;
  if (sourceStats === null) {
    return progressStatsWithoutSourceMessages({ progressStats, record: input.record });
  }

  const progressPercent = progressPercentFromMeter(progressStats?.progress_meter ?? input.record.progress_meter);
  const progressMessage =
    progressPercent !== null && progressPercent > 0 ? [`Research progress ${Math.round(progressPercent)}%`] : [];
  const sourceSample = progressSourceSamples(sourceStats);

  return mergeRawProgressMessages(
    progressMessage
      .concat(progressStatsSourceCountMessages(sourceStats))
      .concat(sourceSample.map((source) => `Reading ${source}`)),
  );
}

function rawStateMessagesFromRecord(input: { record: Record<string, unknown>; eventType: string | null }): string[] {
  const record = input.record;
  const eventType = input.eventType;
  const recordType = asString(record.type);
  if (eventType !== "task_run.state" && recordType !== "task_run.state") {
    return [];
  }

  const run = isRecord(record.run)
    ? record.run
    : isRecord(record.task_run) && isRecord(record.task_run.run)
      ? record.task_run.run
      : null;
  const status = statusFromParallelState(run?.status ?? record.status);
  const error = isRecord(record.error)
    ? firstNonEmptyString([asString(record.error.message), asString(record.error.code)])
    : firstNonEmptyString([asString(record.error)]);

  if (error !== null) {
    return [`Research issue: ${error}`];
  }
  if (status === "pending") {
    return ["Waiting to begin"];
  }
  if (status === "running") {
    return ["Looking through public sources"];
  }
  if (status === "completed") {
    return ["Finished reviewing sources"];
  }
  if (status === "failed") {
    return [`Research failed`];
  }

  return [];
}

function rawProgressMessagesFromRecord(input: { record: Record<string, unknown>; eventType: string | null }): string[] {
  const record = input.record;
  const eventType = input.eventType;
  const taskRun = isRecord(record.task_run) ? record.task_run : record;
  const progressMsg = isRecord(taskRun.progress_msg)
    ? taskRun.progress_msg
    : isRecord(record.progress_msg)
      ? record.progress_msg
      : null;
  const recordType = asString(record.type);
  const isProgressMessageEvent =
    eventType?.startsWith("task_run.progress_msg") === true || recordType.startsWith("task_run.progress_msg");
  const taskRunMessage = typeof taskRun.progress_msg === "string" ? [taskRun.progress_msg] : [];
  const recordMessage = typeof record.progress_msg === "string" ? [record.progress_msg] : [];
  const progressMsgMessages = progressMsg !== null ? progressMessageFieldsFromRecord(progressMsg) : [];
  const recordFieldMessages = isProgressMessageEvent ? progressMessageFieldsFromRecord(record) : [];

  return mergeRawProgressMessages(
    taskRunMessage
      .concat(recordMessage)
      .concat(progressMsgMessages)
      .concat(recordFieldMessages)
      .concat(rawProgressStatsMessagesFromRecord({ record, eventType }))
      .concat(rawStateMessagesFromRecord({ record, eventType })),
  );
}

function rawProgressMessagesFromEvent(event: ParallelRunEvent) {
  return rawProgressMessagesFromRecord({ record: event.data, eventType: event.eventType });
}

function progressMeterFromEventData(data: Record<string, unknown>) {
  const taskRun = isRecord(data.task_run) ? data.task_run : data;
  const progressStats = isRecord(taskRun.progress_stats)
    ? taskRun.progress_stats
    : isRecord(data.progress_stats)
      ? data.progress_stats
      : null;

  return progressStats?.progress_meter ?? taskRun.progress_meter ?? data.progress_meter ?? null;
}

function progressStateFromEventData(data: Record<string, unknown>) {
  const taskRun = isRecord(data.task_run) ? data.task_run : data;
  const run = isRecord(taskRun.run) ? taskRun.run : isRecord(data.run) ? data.run : null;

  return (
    statusFromParallelState(taskRun.state) ??
    statusFromParallelState(taskRun.status) ??
    statusFromParallelState(run?.state) ??
    statusFromParallelState(run?.status) ??
    statusFromParallelState(data.state) ??
    statusFromParallelState(data.status)
  );
}

export function parseParallelRunEvents(text: string): ParallelRunEvent[] {
  const sseEvents = text.split(/\r?\n\r?\n/).flatMap((block): ParallelRunEvent[] => {
    const eventLines = block.split(/\r?\n/);
    const emptyEvent: { eventType: string | null; dataLines: string[] } = { eventType: null, dataLines: [] };
    const parsedEvent = eventLines.reduce((collected, line) => {
      if (line.length === 0 || line.startsWith(":")) {
        return collected;
      }
      const separatorIndex = line.indexOf(":");
      const key = separatorIndex >= 0 ? line.slice(0, separatorIndex).trim() : line.trim();
      const value = separatorIndex >= 0 ? line.slice(separatorIndex + 1).trimStart() : "";
      if (key === "event") {
        return { eventType: value === "" ? null : value, dataLines: collected.dataLines };
      }
      if (key === "data") {
        return { eventType: collected.eventType, dataLines: collected.dataLines.concat(value) };
      }

      return collected;
    }, emptyEvent);

    const dataText = parsedEvent.dataLines.join("\n").trim();
    if (dataText === "" || dataText === "[DONE]") {
      return [];
    }

    const data = parallelRunEventDataFromJsonText(dataText);
    if (data === null) {
      return [];
    }

    return [
      {
        eventType: parsedEvent.eventType,
        data,
      },
    ];
  });
  if (sseEvents.length !== 0) {
    return sseEvents;
  }

  const parsedRoot = parseParallelRunEventsRoot(text);
  if (parsedRoot === null) {
    return text.split(/\r?\n/).flatMap((line): ParallelRunEvent[] => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) {
        return [];
      }
      const data = parallelRunEventDataFromJsonText(trimmed);
      if (data === null) {
        return [];
      }
      const eventTypeRaw = asString(data.type);

      return [
        {
          eventType: eventTypeRaw === "" ? null : eventTypeRaw,
          data,
        },
      ];
    });
  }

  const values = Array.isArray(parsedRoot) ? parsedRoot : [parsedRoot];

  return values.flatMap((value): ParallelRunEvent[] => {
    if (!isRecord(value)) {
      return [];
    }
    const eventTypeRaw = asString(value.type);

    return [
      {
        eventType: eventTypeRaw === "" ? null : eventTypeRaw,
        data: value,
      },
    ];
  });
}

function normalizeParallelRunProgressNamed(input: {
  runId: string;
  events: ParallelRunEvent[];
}): CalendarPrepRunProgress {
  return input.events.reduce<CalendarPrepRunProgress>(
    (progress, event) => {
      const status = progressStateFromEventData(event.data);
      const progressPercent = progressPercentFromMeter(progressMeterFromEventData(event.data));
      const messages = mergeRawProgressMessages(progress.messages.concat(rawProgressMessagesFromEvent(event)));
      const message = messages[messages.length - 1] ?? progress.message;

      return {
        runId: input.runId,
        status: status ?? progress.status,
        progressPercent: progressPercent ?? progress.progressPercent,
        message,
        messages,
      };
    },
    {
      runId: input.runId,
      status: null,
      progressPercent: null,
      message: null,
      messages: [],
    },
  );
}

export function normalizeParallelRunProgress(
  ...args: [runId: string, events: ParallelRunEvent[]]
): CalendarPrepRunProgress {
  return normalizeParallelRunProgressNamed({ runId: args[0], events: args[1] });
}

function normalizeUrl(value: string) {
  try {
    return new URL(value).toString();
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }

    return null;
  }
}

function extractSourcesFromBasis(basis: unknown) {
  if (!Array.isArray(basis)) {
    return [];
  }

  return basis.flatMap((item): CalendarEventPrepSource[] => {
    if (!isRecord(item) || !Array.isArray(item.citations)) {
      return [];
    }

    return item.citations.flatMap((citation): CalendarEventPrepSource[] => {
      if (!isRecord(citation)) {
        return [];
      }
      const title = firstNonEmptyString([asString(citation.title), asString(citation.name), asString(citation.url)]);
      const url = normalizeUrl(asString(citation.url));

      return title !== null && url !== null ? [{ title, url }] : [];
    });
  });
}

function uniqueSources(sources: CalendarEventPrepSource[]) {
  const deduped = sources.reduce<{ items: CalendarEventPrepSource[]; seen: Set<string> }>(
    (state, source) => {
      if (state.seen.has(source.url)) {
        return state;
      }

      return {
        items: state.items.concat(source),
        seen: new Set(state.seen).add(source.url),
      };
    },
    { items: [], seen: new Set<string>() },
  );

  return deduped.items.slice(0, MAX_PREP_SOURCES);
}

function runRefsFromUnknown(value: Record<string, unknown>): CalendarPrepRunRefs {
  const runs = Array.isArray(value.runs)
    ? value.runs.flatMap((item): PrepRunRef[] => {
        if (!isRecord(item)) {
          return [];
        }
        const kind = item.kind === "company" ? "company" : item.kind === "people" ? "people" : null;
        const runId = asString(item.runId);
        if (kind === null || runId === "") {
          return [];
        }

        const participantKey = asString(item.participantKey);
        const name = asString(item.name);
        const domain = asString(item.domain);

        return [
          {
            kind,
            runId,
            participantKey: participantKey === "" ? undefined : participantKey,
            name: name === "" ? null : name,
            domain: domain === "" ? null : domain,
          },
        ];
      })
    : [];

  const taskgroupId = asString(value.taskgroupId);
  const processor = asString(value.processor);

  return {
    taskgroupId: taskgroupId === "" ? null : taskgroupId,
    companyVisible: value.companyVisible === true,
    processor: processor === "" ? null : processor,
    runs,
  };
}

function storedProgressFromResult(result: Record<string, unknown>): CalendarEventPrepProgress | null {
  const parsed = calendarEventPrepProgressSchema.safeParse(result.progress);

  return parsed.success ? parsed.data : null;
}

function countStatuses(input: { counts: Record<string, number> | undefined; keys: string[] }) {
  if (input.counts === undefined) {
    return 0;
  }
  const keySet = new Set(input.keys);

  return Object.entries(input.counts).reduce(
    (total, [key, count]) => (keySet.has(key.toLowerCase().replace(/[\s-]+/g, "_")) ? total + count : total),
    0,
  );
}

function aggregateGroupCounts(input: { group?: ParallelTaskGroup | null; runRefs: CalendarPrepRunRefs }) {
  const counts = input.group?.status?.task_run_status_counts;
  const sumCounts = counts ? Object.values(counts).reduce((total, count) => total + count, 0) : 0;
  const totalRuns = Math.max(input.runRefs.runs.length, input.group?.status?.num_task_runs ?? 0, sumCounts);
  const completedRuns = countStatuses({
    counts,
    keys: ["completed", "complete", "succeeded", "success", "done"],
  });
  const failedRuns = countStatuses({
    counts,
    keys: ["failed", "failure", "error", "errored", "cancelled", "canceled"],
  });
  const runningRuns = countStatuses({
    counts,
    keys: ["running", "processing", "executing", "in_progress", "active"],
  });
  const explicitQueuedRuns = countStatuses({
    counts,
    keys: ["queued", "pending", "created", "waiting", "not_started"],
  });
  const unknownRuns = Math.max(0, totalRuns - completedRuns - failedRuns - runningRuns - explicitQueuedRuns);
  const queuedRuns = explicitQueuedRuns + unknownRuns;

  return {
    totalRuns,
    queuedRuns,
    runningRuns,
    completedRuns,
    failedRuns,
  };
}

function fallbackRunStatus(input: {
  group?: ParallelTaskGroup | null;
  counts: ReturnType<typeof aggregateGroupCounts>;
}): CalendarEventPrepResponse["status"] {
  if (input.counts.totalRuns === 0) {
    return "completed";
  }
  if (input.counts.completedRuns >= input.counts.totalRuns) {
    return "completed";
  }
  if (input.counts.failedRuns >= input.counts.totalRuns) {
    return "failed";
  }
  if (input.group?.status?.is_active === false) {
    return input.counts.failedRuns > 0 ? "failed" : "completed";
  }
  if (input.counts.runningRuns > 0 || input.counts.completedRuns > 0 || input.group?.status?.is_active === true) {
    return "running";
  }

  return "pending";
}

function sectionStatus(input: {
  refs: PrepRunRef[];
  runProgressById: Map<string, CalendarPrepRunProgress>;
  fallbackStatus: CalendarEventPrepResponse["status"];
}): CalendarEventPrepResponse["status"] {
  if (input.refs.length === 0) {
    return "completed";
  }

  const statuses = input.refs
    .map((ref) => input.runProgressById.get(ref.runId)?.status)
    .filter((status): status is CalendarEventPrepResponse["status"] => status !== null && status !== undefined);
  if (statuses.length === input.refs.length && statuses.every((status) => status === "completed")) {
    return "completed";
  }
  if (statuses.length === input.refs.length && statuses.every((status) => status === "failed")) {
    return "failed";
  }
  if (statuses.includes("running") || statuses.includes("completed")) {
    return "running";
  }
  if (statuses.includes("failed")) {
    return input.fallbackStatus === "running" ? "running" : "failed";
  }

  return input.fallbackStatus;
}

function sectionProgressPercent(input: {
  refs: PrepRunRef[];
  status: CalendarEventPrepResponse["status"];
  runProgressById: Map<string, CalendarPrepRunProgress>;
}) {
  if (input.refs.length === 0 || input.status === "completed") {
    return PROGRESS_PERCENT_MAX;
  }
  if (input.status === "failed") {
    return null;
  }

  const percents = input.refs.flatMap((ref) => {
    const progress = input.runProgressById.get(ref.runId);
    if (progress?.status === "completed") {
      return [PROGRESS_PERCENT_MAX];
    }

    return progress?.progressPercent === null || progress?.progressPercent === undefined
      ? []
      : [progress.progressPercent];
  });
  if (percents.length === 0) {
    return null;
  }

  return clampPercent(percents.reduce((total, percent) => total + percent, 0) / percents.length);
}

function domainProgressMessage(ref: PrepRunRef) {
  const domain = ref.domain?.trim() ?? "";

  return domain === "" ? null : `Checking ${domain}`;
}

function targetProgressMessages(ref: PrepRunRef) {
  const peopleMessage =
    ref.kind === "people" && typeof ref.name === "string" && ref.name.trim() !== ""
      ? [`Researching ${ref.name.trim()}`]
      : [];
  const domainMessage = domainProgressMessage(ref);

  return domainMessage === null ? peopleMessage : peopleMessage.concat(domainMessage);
}

function sectionMessage(input: {
  refs: PrepRunRef[];
  status: CalendarEventPrepResponse["status"];
  runProgressById: Map<string, CalendarPrepRunProgress>;
  fallbackMessage: string | null;
  previousMessages?: string[];
}) {
  const messages = sectionMessages({
    refs: input.refs,
    runProgressById: input.runProgressById,
    previousMessages: input.previousMessages,
  });
  const latestMessage = messages[messages.length - 1];
  if (latestMessage !== undefined && latestMessage !== "") {
    return latestMessage;
  }

  return input.status === "completed" || input.status === "failed" ? null : input.fallbackMessage;
}

function researchTargetLabel(ref: PrepRunRef): string {
  const peopleTarget = ref.name?.trim() ?? "";
  const companyTarget = ref.domain?.trim() ?? "";
  if (ref.kind === "people") {
    return peopleTarget === "" ? "participant" : peopleTarget;
  }

  return companyTarget === "" ? "company" : companyTarget;
}

function progressMessagesForRunRef(input: { ref: PrepRunRef; progress: CalendarPrepRunProgress }): string[] {
  const targetMessages = targetProgressMessages(input.ref);
  if (input.progress.messages.length !== 0) {
    return targetMessages.concat(input.progress.messages);
  }
  const target = researchTargetLabel(input.ref);
  if (input.progress.progressPercent !== null && input.progress.progressPercent > 0) {
    return targetMessages.length !== 0
      ? targetMessages
      : [`Researching ${target}: ${Math.round(input.progress.progressPercent)}%`];
  }
  if (input.progress.status === "running") {
    return targetMessages.length !== 0 ? targetMessages : [`Researching ${target}`];
  }
  if (input.progress.status === "pending") {
    return [`Waiting to research ${target}`];
  }
  if (input.progress.status === "failed") {
    return [`Research failed for ${target}`];
  }

  return [];
}

function sectionMessages(input: {
  refs: PrepRunRef[];
  runProgressById: Map<string, CalendarPrepRunProgress>;
  previousMessages?: string[];
}) {
  const messages = input.refs.flatMap((ref) => {
    const progress = input.runProgressById.get(ref.runId);
    if (progress === undefined) {
      return [];
    }

    return progressMessagesForRunRef({ ref, progress });
  });

  return mergeRawProgressMessages((input.previousMessages ?? []).concat(messages));
}

function fallbackMessageFromCounts(counts: ReturnType<typeof aggregateGroupCounts>) {
  if (counts.runningRuns > 0 || counts.completedRuns > 0) {
    return "Searching public sources";
  }
  if (counts.queuedRuns > 0) {
    return "Planning research";
  }

  return null;
}

function activeSectionMessage(input: {
  refs: PrepRunRef[];
  status: CalendarEventPrepResponse["status"];
  runProgressById: Map<string, CalendarPrepRunProgress>;
  previousMessage: string | null | undefined;
  previousMessages: string[] | undefined;
  fallbackMessage: string | null;
}): string | null {
  if (input.status === "completed" || input.status === "failed") {
    return null;
  }

  return (
    sectionMessage({
      refs: input.refs,
      status: input.status,
      runProgressById: input.runProgressById,
      fallbackMessage: null,
      previousMessages: input.previousMessages,
    }) ??
    input.previousMessage ??
    input.fallbackMessage
  );
}

function companyCalendarPrepProgressFields(input: {
  runRefs: CalendarPrepRunRefs;
  companyRefs: PrepRunRef[];
  runProgressById: Map<string, CalendarPrepRunProgress>;
  fallbackStatus: CalendarEventPrepResponse["status"];
  previousProgress?: CalendarEventPrepProgress | null;
  fallbackMessage: string | null;
}) {
  if (!input.runRefs.companyVisible) {
    const hiddenCompanyProgress: {
      companyStatus: "completed";
      companyMessages: string[];
      companyMessage: string | null;
      companyProgressPercent: number;
    } = {
      companyStatus: "completed",
      companyMessages: [],
      companyMessage: null,
      companyProgressPercent: PROGRESS_PERCENT_MAX,
    };

    return hiddenCompanyProgress;
  }
  const companyStatus = sectionStatus({
    refs: input.companyRefs,
    runProgressById: input.runProgressById,
    fallbackStatus: input.fallbackStatus,
  });

  return {
    companyStatus,
    companyMessages: sectionMessages({
      refs: input.companyRefs,
      runProgressById: input.runProgressById,
      previousMessages: input.previousProgress?.companyMessages,
    }),
    companyMessage: activeSectionMessage({
      refs: input.companyRefs,
      status: companyStatus,
      runProgressById: input.runProgressById,
      previousMessage: input.previousProgress?.companyMessage,
      previousMessages: input.previousProgress?.companyMessages,
      fallbackMessage: input.fallbackMessage,
    }),
    companyProgressPercent:
      sectionProgressPercent({
        refs: input.companyRefs,
        status: companyStatus,
        runProgressById: input.runProgressById,
      }) ??
      input.previousProgress?.companyProgressPercent ??
      null,
  };
}

export function buildCalendarPrepProgress(input: {
  runRefs: CalendarPrepRunRefs;
  group?: ParallelTaskGroup | null;
  runProgresses?: CalendarPrepRunProgress[];
  previousProgress?: CalendarEventPrepProgress | null;
  startedAt?: string | null;
  now?: Date;
}): CalendarEventPrepProgress {
  const counts = aggregateGroupCounts({
    group: input.group,
    runRefs: input.runRefs,
  });
  const fallbackStatus = fallbackRunStatus({
    group: input.group,
    counts,
  });
  const runProgressById = new Map((input.runProgresses ?? []).map((progress) => [progress.runId, progress]));
  const peopleRefs = input.runRefs.runs.filter((ref) => ref.kind === "people");
  const companyRefs = input.runRefs.runs.filter((ref) => ref.kind === "company");
  const peopleStatus = sectionStatus({
    refs: peopleRefs,
    runProgressById,
    fallbackStatus,
  });
  const fallbackMessage = fallbackMessageFromCounts(counts);
  const companyFields = companyCalendarPrepProgressFields({
    runRefs: input.runRefs,
    companyRefs,
    runProgressById,
    fallbackStatus,
    previousProgress: input.previousProgress,
    fallbackMessage,
  });

  return calendarEventPrepProgressSchema.parse({
    ...counts,
    peopleStatus,
    companyStatus: companyFields.companyStatus,
    peopleProgressPercent:
      sectionProgressPercent({
        refs: peopleRefs,
        status: peopleStatus,
        runProgressById,
      }) ??
      input.previousProgress?.peopleProgressPercent ??
      null,
    companyProgressPercent: companyFields.companyProgressPercent,
    peopleMessage: activeSectionMessage({
      refs: peopleRefs,
      status: peopleStatus,
      runProgressById,
      previousMessage: input.previousProgress?.peopleMessage,
      previousMessages: input.previousProgress?.peopleMessages,
      fallbackMessage,
    }),
    companyMessage: companyFields.companyMessage,
    peopleMessages: sectionMessages({
      refs: peopleRefs,
      runProgressById,
      previousMessages: input.previousProgress?.peopleMessages,
    }),
    companyMessages: companyFields.companyMessages,
    startedAt: input.startedAt ?? input.previousProgress?.startedAt,
    updatedAt: (input.now ?? new Date()).toISOString(),
  });
}

export function buildPendingPrepProgress(input: {
  totalRuns: number;
  peopleRunCount: number;
  /** @external calendar prep company section visibility */
  companyVisible: boolean;
  startedAt?: string | null;
  now?: Date;
}): CalendarEventPrepProgress {
  const totalRuns = Math.max(0, input.totalRuns);
  const peopleStatus = input.peopleRunCount > 0 ? "pending" : "completed";
  const companyStatus = input.companyVisible ? "pending" : "completed";

  return calendarEventPrepProgressSchema.parse({
    totalRuns,
    queuedRuns: totalRuns,
    runningRuns: 0,
    completedRuns: 0,
    failedRuns: 0,
    peopleStatus,
    companyStatus,
    peopleProgressPercent: peopleStatus === "completed" ? PROGRESS_PERCENT_MAX : null,
    companyProgressPercent: companyStatus === "completed" ? PROGRESS_PERCENT_MAX : null,
    peopleMessage: peopleStatus === "pending" ? "Planning research" : null,
    companyMessage: companyStatus === "pending" ? "Planning research" : null,
    peopleMessages: [],
    companyMessages: [],
    startedAt: input.startedAt ?? undefined,
    updatedAt: (input.now ?? new Date()).toISOString(),
  });
}

export function buildCompletedPrepProgress(input: {
  runRefs: CalendarPrepRunRefs;
  startedAt?: string | null;
  now?: Date;
}): CalendarEventPrepProgress {
  const totalRuns = input.runRefs.runs.length;

  return calendarEventPrepProgressSchema.parse({
    totalRuns,
    queuedRuns: 0,
    runningRuns: 0,
    completedRuns: totalRuns,
    failedRuns: 0,
    peopleStatus: "completed",
    companyStatus: "completed",
    peopleProgressPercent: PROGRESS_PERCENT_MAX,
    companyProgressPercent: PROGRESS_PERCENT_MAX,
    peopleMessage: null,
    companyMessage: null,
    peopleMessages: [],
    companyMessages: [],
    startedAt: input.startedAt ?? undefined,
    updatedAt: (input.now ?? new Date()).toISOString(),
  });
}

export function buildInitialPrepResult(input: {
  status: CalendarEventPrepResponse["status"];
  /** @external calendar prep company section visibility */
  companyVisible: boolean;
  progress?: CalendarEventPrepProgress | null;
  brief?: MeetingPrivateBrief | null;
}): Omit<CalendarEventPrepResponse, "prepId"> {
  return {
    status: input.status,
    brief: input.brief ?? emptyBrief(input.status),
    people: emptyPeople(input.status),
    company: emptyCompany({ status: input.status, isVisible: input.companyVisible }),
    sources: [],
    error: null,
    progress: input.progress ?? null,
  };
}

function outputContent(result: ParallelRunResult) {
  return isRecord(result.output?.content) ? result.output.content : {};
}

function asRecordArray(input: { value: unknown; limit: number }) {
  return Array.isArray(input.value) ? input.value.filter(isRecord).slice(0, input.limit) : [];
}

function asNullableString(value: unknown) {
  const text = asString(value);

  return text === "" ? null : text;
}

function sentenceParts(parts: (string | null | undefined)[]) {
  return parts
    .map((part) => (part === null || part === undefined ? "" : part.trim()))
    .filter((part): part is string => part !== "")
    .join(" ");
}

function datedFact(input: { date: unknown; text: string }) {
  const dateText = formatMeetingPrepDate(input.date);

  return normalizeMeetingPrepDateText(dateText === "" ? input.text : `${dateText}: ${input.text}`);
}

function capitalizeBulletStart(value: string) {
  return value.replace(
    /^(\s*)([a-z])/,
    (_match, leading: string, letter: string) => `${leading}${letter.toUpperCase()}`,
  );
}

function participantBulletsFromContent(input: { content: Record<string, unknown>; ref: PrepRunRef }) {
  const identity = isRecord(input.content.participant_identity) ? input.content.participant_identity : {};
  const name = firstNonEmptyString([asString(identity.name), input.ref.name ?? "", "Participant"]);
  const title = asString(identity.current_title);
  const company = asString(identity.current_company);
  const context = [title, company].filter((part) => part !== "").join(" at ");
  const heading = context === "" ? (name ?? "Participant") : `${name ?? "Participant"}, ${context}`;
  const why = asString(input.content.why_this_person_matters_for_meeting);
  const scope = asString(input.content.likely_scope);
  const headingBullets = [
    ...(why !== "" ? [`${heading}: ${why}`] : scope !== "" ? [`${heading}: ${scope}`] : []),
    ...(why !== "" && scope !== "" ? [scope] : []),
  ];
  const signalBullets = asRecordArray({
    value: input.content.recent_professional_signals,
    limit: MAX_SIGNAL_BULLETS,
  }).flatMap((signal) => {
    const text = sentenceParts([asNullableString(signal.signal), asNullableString(signal.meeting_relevance)]);

    return text === "" ? [] : [datedFact({ date: signal.date, text })];
  });
  const backgroundBullets = asRecordArray({
    value: input.content.relevant_background,
    limit: MAX_SIGNAL_BULLETS,
  }).flatMap((background) => {
    const text = sentenceParts([asNullableString(background.fact), asNullableString(background.why_it_matters)]);

    return text === "" ? [] : [text];
  });
  const connection = asString(input.content.company_connection);
  const bullets = [
    ...headingBullets,
    ...signalBullets,
    ...backgroundBullets,
    ...(headingBullets.length === 0 && signalBullets.length === 0 && backgroundBullets.length === 0 && connection !== ""
      ? [`${heading}: ${connection}`]
      : []),
  ];

  return compactStringArray({
    values: bullets.map((bullet) =>
      capitalizeBulletStart(normalizeMeetingPrepDateText(bullet.replace(/\s+/g, " ").trim())),
    ),
    limit: MAX_PREP_BULLET_GROUPS,
  });
}

function companyBulletsFromContent(content: Record<string, unknown>) {
  const bullets = [
    asString(content.why_this_company_context_matters),
    ...asRecordArray({ value: content.latest_signals, limit: MAX_COMPANY_SIGNAL_BULLETS }).flatMap((signal) => {
      const text = sentenceParts([
        asNullableString(signal.signal),
        asNullableString(signal.why_it_matters_for_meeting),
      ]);

      return text === "" ? [] : [datedFact({ date: signal.date, text })];
    }),
    ...asRecordArray({ value: content.current_company_priorities, limit: MAX_PRIORITY_BULLETS }).flatMap((priority) => {
      const label = asString(priority.priority);
      const text = sentenceParts([asNullableString(priority.evidence), asNullableString(priority.meeting_relevance)]);

      return label !== "" && text !== "" ? [`${label}: ${text}`] : [];
    }),
    ...asRecordArray({ value: content.business_health_or_momentum, limit: MAX_PRIORITY_BULLETS }).flatMap(
      (momentum) => {
        const text = sentenceParts([asNullableString(momentum.indicator), asNullableString(momentum.interpretation)]);

        return text === "" ? [] : [datedFact({ date: momentum.date, text })];
      },
    ),
    ...asRecordArray({ value: content.product_or_market_context, limit: MAX_PRIORITY_BULLETS }).flatMap((context) => {
      const text = sentenceParts([asNullableString(context.context), asNullableString(context.why_it_matters)]);

      return text === "" ? [] : [text];
    }),
    ...asRecordArray({ value: content.risks_or_sensitive_context, limit: MAX_PRIORITY_BULLETS }).flatMap((risk) => {
      const text = sentenceParts([asNullableString(risk.issue), asNullableString(risk.meeting_relevance)]);

      return text === "" ? [] : [datedFact({ date: risk.date, text })];
    }),
  ];

  return compactStringArray({
    values: bullets.map((bullet) => capitalizeBulletStart(normalizeMeetingPrepDateText(bullet))),
    limit: MAX_PREP_COMPANY_BULLETS,
  });
}

function normalizePrepBriefDates(brief: CalendarEventPrepResponse["brief"]) {
  return {
    ...brief,
    bullets: brief.bullets.map(normalizeMeetingPrepDateText),
  };
}

function normalizePrepResponseDates(response: CalendarEventPrepResponse) {
  return calendarEventPrepResponseSchema.parse({
    ...response,
    brief: normalizePrepBriefDates(response.brief),
    people: {
      ...response.people,
      bullets: response.people.bullets.map(normalizeMeetingPrepDateText),
    },
    company: response.company
      ? {
          ...response.company,
          bullets: response.company.bullets.map(normalizeMeetingPrepDateText),
        }
      : null,
  });
}

export function normalizeParallelPrepResults(input: {
  prepId: string;
  runRefs: CalendarPrepRunRefs;
  results: ParallelRunResult[];
  progress?: CalendarEventPrepProgress | null;
  brief?: MeetingPrivateBrief | null;
}): CalendarEventPrepResponse {
  const resultByRunId = new Map(input.results.map((result) => [result.run.run_id, result]));
  const collected = input.runRefs.runs.reduce<{
    peopleBullets: string[];
    peopleSources: CalendarEventPrepSource[];
    company: CalendarEventPrepResponse["company"];
  }>(
    (state, ref) => {
      const runResult = resultByRunId.get(ref.runId);
      if (runResult === undefined || runResult.run.status !== "completed") {
        return state;
      }
      const content = outputContent(runResult);
      const contentSources = extractSourcesFromBasis(runResult.output?.basis);

      if (ref.kind === "people") {
        return {
          ...state,
          peopleBullets: state.peopleBullets.concat(participantBulletsFromContent({ content, ref })),
          peopleSources: state.peopleSources.concat(contentSources),
        };
      }

      const identity = isRecord(content.company_identity) ? content.company_identity : {};
      const sources = uniqueSources(contentSources);
      const bullets = companyBulletsFromContent(content);

      return {
        ...state,
        company: {
          status: "completed",
          companyName: asNullableString(identity.name),
          website: normalizeUrl(asString(identity.website)),
          bullets,
          sources,
        },
      };
    },
    {
      peopleBullets: [],
      peopleSources: [],
      company: emptyCompany({ status: "completed", isVisible: input.runRefs.companyVisible }),
    },
  );
  const { peopleBullets, peopleSources, company } = collected;

  const people = {
    status: "completed" as const,
    bullets: peopleBullets.slice(0, MAX_PREP_PEOPLE_BULLETS),
    sources: uniqueSources(peopleSources),
  };
  const sources = uniqueSources([...people.sources, ...(company?.sources ?? [])]);

  return normalizePrepResponseDates(
    calendarEventPrepResponseSchema.parse({
      prepId: input.prepId,
      status: "completed",
      brief: input.brief ?? emptyBrief("completed"),
      people,
      company,
      sources,
      error: null,
      progress: input.progress ?? buildCompletedPrepProgress({ runRefs: input.runRefs }),
    }),
  );
}

function storedBriefFromResult(input: {
  result: Record<string, unknown>;
  rowStatus: CalendarEventPrepResponse["status"];
}) {
  const parsed = calendarEventPrepBriefSchema.safeParse(input.result.brief);
  if (!parsed.success) {
    return null;
  }
  if (input.rowStatus === "completed" && (parsed.data.status === "pending" || parsed.data.status === "running")) {
    return emptyBrief("completed");
  }

  return parsed.data;
}

function prepRowStatus(row: CalendarEventPrepRow): CalendarEventPrepResponse["status"] {
  if (row.status === "pending" || row.status === "running" || row.status === "completed" || row.status === "failed") {
    return row.status;
  }

  return "running";
}

function prepRowError(row: CalendarEventPrepRow): CalendarEventPrepResponse["error"] {
  const errorCode = isRecord(row.error) ? asString(row.error.code) : "";
  const errorMessage = isRecord(row.error) ? asString(row.error.message) : "";
  if (!isRecord(row.error)) {
    return null;
  }

  return {
    code: errorCode === "" ? undefined : errorCode,
    message: errorMessage === "" ? "Meeting prep failed." : errorMessage,
  };
}

function completedPrepResponseFromRow(input: {
  row: CalendarEventPrepRow;
  result: Record<string, unknown>;
  storedBrief: CalendarEventPrepResponse["brief"] | null;
}): CalendarEventPrepResponse {
  return normalizePrepResponseDates(
    calendarEventPrepResponseSchema.parse({
      prepId: input.row.id,
      ...input.result,
      status: "completed",
      brief: input.storedBrief ?? emptyBrief("completed"),
      error: null,
    }),
  );
}

function inProgressPrepResponseFromRow(input: {
  row: CalendarEventPrepRow;
  runRefs: CalendarPrepRunRefs;
  progress: CalendarEventPrepProgress | null;
  storedBrief: CalendarEventPrepResponse["brief"] | null;
  error: CalendarEventPrepResponse["error"];
}): CalendarEventPrepResponse {
  const status = input.row.status === "failed" ? "failed" : input.row.status === "pending" ? "pending" : "running";

  return normalizePrepResponseDates(
    calendarEventPrepResponseSchema.parse({
      prepId: input.row.id,
      ...buildInitialPrepResult({
        status,
        companyVisible: input.runRefs.companyVisible,
        progress: input.progress,
        brief: input.storedBrief,
      }),
      error: input.error,
    }),
  );
}

export function responseFromPrepRow(row: CalendarEventPrepRow): CalendarEventPrepResponse {
  const result = isRecord(row.result) ? row.result : {};
  const runRefs = runRefsFromUnknown(isRecord(row.runRefs) ? row.runRefs : {});
  const progress = storedProgressFromResult(result);
  const rowStatus = prepRowStatus(row);
  const storedBrief = storedBriefFromResult({ result, rowStatus });
  const error = prepRowError(row);

  if (row.status === "completed") {
    return completedPrepResponseFromRow({ row, result, storedBrief });
  }

  return inProgressPrepResponseFromRow({ row, runRefs, progress, storedBrief, error });
}

export function failedPrepResult(input: {
  prepId: string;
  /** @external calendar prep company section visibility */
  companyVisible: boolean;
  code: string;
  message: string;
  progress?: CalendarEventPrepProgress | null;
  brief?: MeetingPrivateBrief | null;
}): CalendarEventPrepResponse {
  return normalizePrepResponseDates(
    calendarEventPrepResponseSchema.parse({
      prepId: input.prepId,
      ...buildInitialPrepResult({
        status: "failed",
        companyVisible: input.companyVisible,
        progress: input.progress ?? null,
        brief: input.brief ?? null,
      }),
      error: {
        code: input.code,
        message: input.message,
      },
    }),
  );
}

export function parallelClientFromEnv(): ParallelMeetingPrepClient | null {
  const apiKey = apiEnv().PARALLEL_API_KEY;

  return apiKey !== "" ? new ParallelMeetingPrepClient(apiKey) : null;
}

export function runRefsFromStored(value: Record<string, unknown>): CalendarPrepRunRefs {
  return runRefsFromUnknown(value);
}
