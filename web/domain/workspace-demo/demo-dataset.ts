import {
  type Meeting,
  memoryCategories,
  type MemoryPerson,
  type MemoryProjection,
  normalizeMemoryCategory,
  type RelationshipMemory,
  type UnifiedAssignedTask,
  UNPLACED_ASSIGNED_TASK_SECTION_ID,
  type User,
  type WorkspaceMember,
} from "@readymeet/shared";

import { DANNY_OCEAN, RUSTY_RYAN } from "./danny-ocean";
import {
  DEMO_MEETINGS,
  DEMO_MOMENTS,
  DEMO_PEOPLE,
  DEMO_PREVIEWS,
  DEMO_TRANSCRIPTS,
  DEMO_UPCOMING,
} from "./demo-fixtures";
import { demoId, demoSiblingId } from "./demo-ids";
import { DEMO_PORTRAIT_NAMES } from "./demo-portraits";
import type { CandidateInterview, DemoMoment, TranscriptTurn } from "./demo-types";
import { SOPHIE_CHEN } from "./sophie-chen";
import { UPCOMING_BRIEFS, type UpcomingBriefSource } from "./upcoming-briefs";

const LINT_NUM_N7 = 7;
const LINT_NUM_N3 = 3;
const LINT_NUM_N2026 = 2026;
const LINT_NUM_N12 = 12;
const LINT_NUM_N9 = 9;
const LINT_NUM_N3_600_000 = 3_600_000;
const LINT_NUM_N6 = 6;
const LINT_NUM_N2 = 2;
const LINT_NUM_N35 = 35;
const LINT_NUM_N60_000 = 60_000;
const LINT_NUM_N5 = 5;
const LINT_NUM_N20_000 = 20_000;

const VIEWER = "Sam Zetterberg";
const DAY_MS = 86_400_000;
const WEEK_MS = LINT_NUM_N7 * DAY_MS;
// The newest recorded exchange in the fixtures. Past data shifts by whole weeks
// so weekdays are preserved and nothing recorded lands in the viewer's future.
const LAST_RECORDED_AT = Date.parse("2026-09-04T18:00:00-07:00");
// The fixtures' first upcoming weekday, re-anchored to the next weekday.
const UPCOMING_ANCHOR_DAY = "2026-09-07";

const TEAM_EMAIL_DOMAIN = "ready.app";
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
const emailFor = (input: { name: string; domain: string }) =>
  `${slug(input.name.split(" ")[0] ?? input.name)}@${input.domain}`;

const portraitSlug = (name: string) =>
  name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
/** The prototype's generated portrait for this fictional person, if any. */
function portraitUrl(name: string) {
  if (name === VIEWER) {
    return "/landing/sam.png";
  }
  if (name === DANNY_OCEAN) {
    return "/landing/danny-ocean.webp";
  }
  if (name === RUSTY_RYAN) {
    return "/landing/rusty-ryan.webp";
  }

  return DEMO_PORTRAIT_NAMES.has(name) ? `/landing/people/${portraitSlug(name)}.webp` : null;
}

type SourceMoment = DemoMoment;

type DemoPersonDetail = {
  person: MemoryPerson;
  projection: MemoryProjection | null;
  memories: RelationshipMemory[];
  meetings: { id: string; title: string; occurredAt: string }[];
  /** @external demo person detail wire field */
  processing: boolean;
};

type DemoMeetingSource = {
  meeting: Meeting;
  source: CandidateInterview;
};

type DemoUpcomingMeeting = {
  id: string;
  title: string;
  start: string;
  end: string;
  participants: string[];
  prep: {
    brief: string[];
    people: string[];
    company: { name: string; bullets: string[] } | null;
    /** A meetingId opens that past meeting in the demo; other sources are illustrative. */
    sources: { kind: UpcomingBriefSource["kind"]; title: string; meetingId: string | null }[];
  };
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DATE_IN_TEXT =
  /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec) (\d{1,2})\b/g;

/** Moves "September 11" style mentions with the timeline. Whole-week shifts
 * keep any weekday named beside them correct. */
export function shiftDatesInText(input: { text: string; shiftMs: number }): string {
  if (input.shiftMs === 0) {
    return input.text;
  }

  return input.text.replace(DATE_IN_TEXT, (match, month: string, day: string) => {
    const monthIndex = MONTHS.findIndex((name) => name.startsWith(month.slice(0, LINT_NUM_N3)));
    if (monthIndex < 0) {
      return match;
    }
    const date = new Date(Date.UTC(LINT_NUM_N2026, monthIndex, Number(day), LINT_NUM_N12) + input.shiftMs);
    const name = MONTHS[date.getUTCMonth()];
    if (name === undefined) {
      return match;
    }

    return `${MONTHS.includes(month) ? name : name.slice(0, LINT_NUM_N3)} ${date.getUTCDate()}`;
  });
}

const personIds = new Map<string, string>();
export function demoPersonId(name: string): string {
  const existing = personIds.get(name);
  if (existing !== undefined) {
    return existing;
  }
  const id = demoId(`person:${name}`);
  personIds.set(name, id);

  return id;
}

function splitSentences(text: string) {
  return (
    text
      .match(/[^.!?]+[.!?]+["'’”)]*/g)
      ?.map((sentence) => sentence.trim())
      .filter(Boolean) ?? [text]
  );
}

function evidenceLines(moment: SourceMoment) {
  const snippet = moment.evidence.at(0)?.snippet ?? "";

  return snippet
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(":");

      return separator > 0
        ? { speaker: line.slice(0, separator).trim(), text: line.slice(separator + 1).trim() }
        : { speaker: moment.interactionWith?.[0] ?? VIEWER, text: line.trim() };
    });
}

function nextWeekday(from: number) {
  const date = new Date(from);
  date.setHours(0, 0, 0, 0);
  if (from > date.getTime() + LINT_NUM_N9 * LINT_NUM_N3_600_000) {
    date.setDate(date.getDate() + 1);
  }
  while (date.getDay() === 0 || date.getDay() === LINT_NUM_N6) {
    date.setDate(date.getDate() + 1);
  }

  return date;
}

function createGetPersonDetail(input: {
  personById: Map<string, MemoryPerson>;
  memoriesByPerson: Map<string, RelationshipMemory[]>;
  previews: typeof DEMO_PREVIEWS;
  memoryIdBySourceId: Map<string, string>;
  meetingsByPerson: Map<string, { id: string; title: string; occurredAt: string }[]>;
  text: (value: string) => string;
}) {
  return (personId: string): DemoPersonDetail | null => {
    const person = input.personById.get(personId);
    if (!person) {
      return null;
    }
    const personMemories = input.memoriesByPerson.get(personId) ?? [];
    const preview = input.previews[person.name];
    const sourceIds = (preview?.sourceMemoryIds ?? [])
      .map((sourceId) => input.memoryIdBySourceId.get(sourceId))
      .filter((id): id is string => Boolean(id));
    const summaryIds =
      sourceIds.length !== 0 ? sourceIds : personMemories.slice(0, LINT_NUM_N3).map((memory) => memory.id);
    const recentIds = personMemories
      .filter((memory) => summaryIds.includes(memory.id))
      .slice(0, person.name === SOPHIE_CHEN ? LINT_NUM_N3 : LINT_NUM_N2)
      .map((memory) => memory.id);
    const standing =
      preview !== undefined && preview.standing.length !== 0
        ? preview.standing.slice(0, LINT_NUM_N5).map((line) => ({
            text: input.text(line),
            memoryIds: recentIds.length !== 0 ? recentIds : summaryIds.slice(0, 1),
          }))
        : summaryIds.slice(0, LINT_NUM_N5).map((id) => ({
            text: personMemories.find((memory) => memory.id === id)?.title ?? person.name,
            memoryIds: [id],
          }));

    return {
      person,
      projection:
        preview !== undefined && summaryIds.length !== 0
          ? {
              summary: splitSentences(input.text(preview.summary)).map((sentence) => ({
                text: sentence,
                memoryIds: summaryIds,
              })),
              standing: standing.filter((item) => item.memoryIds.length !== 0),
            }
          : null,
      memories: personMemories,
      meetings: input.meetingsByPerson.get(personId) ?? [],
      /** @external demo person detail wire field */
      processing: false,
    };
  };
}

function createGetMemoryEvidence(input: {
  memoryById: Map<string, RelationshipMemory>;
  memorySourceById: Map<string, SourceMoment>;
  text: (value: string) => string;
}) {
  return (memoryId: string) => {
    const memory = input.memoryById.get(memoryId);
    const source = input.memorySourceById.get(memoryId);
    if (!memory || !source) {
      return null;
    }
    const lines = evidenceLines(source);

    return (
      lines.length !== 0 ? lines : [{ speaker: source.interactionWith?.[0] ?? VIEWER, text: source.description }]
    ).map((line, index) => ({
      segmentId: demoId(`segment:${source.id}:${index}`),
      quote: input.text(line.text),
      speakerName: line.speaker,
      startedAt: new Date(Date.parse(memory.occurredAt) + index * LINT_NUM_N20_000).toISOString(),
      meetingId: memory.meetingId,
    }));
  };
}

function createGetMeetingTranscript(input: {
  meetingSources: Map<string, DemoMeetingSource>;
  text: (value: string) => string;
}) {
  return (meetingId: string): TranscriptTurn[] => {
    const entry = input.meetingSources.get(meetingId);
    if (!entry) {
      return [];
    }
    const turns = DEMO_TRANSCRIPTS[entry.source.id] ?? [];

    return turns.map((turn) => ({ ...turn, text: input.text(turn.text) }));
  };
}

function buildDemoMemoriesBundle(input: {
  sourceMoments: SourceMoment[];
  peopleByName: Set<string>;
  shiftMs: number;
  text: (value: string) => string;
}) {
  const memorySourceById = new Map<string, SourceMoment>();
  const memoryIdBySourceId = new Map<string, string>();
  const memoryTimes = new Map<string, number>();
  const memoryRecords = input.sourceMoments.flatMap((moment) => {
    const momentPersonIds = [...new Set([...(moment.interactionWith ?? []), ...(moment.entities.people ?? [])])]
      .filter((name) => name !== VIEWER && input.peopleByName.has(name))
      .map(demoPersonId);
    if (momentPersonIds.length === 0) {
      return [];
    }
    const id = demoId(`memory:${moment.id}`);
    const category = normalizeMemoryCategory(moment.category ?? "Recruiting");
    const memoryCategory = memoryCategories.find((item) => item === category) ?? "General";
    const evidenceQuote = evidenceLines(moment)[0]?.text;
    const quote = input.text(evidenceQuote !== undefined && evidenceQuote !== "" ? evidenceQuote : moment.description);
    const time = Date.parse(moment.ts) + input.shiftMs;
    const occurredAt = new Date(time).toISOString();
    const meetingId = demoId(`meeting:${moment.meetingId ?? moment.id}`);
    const memory: RelationshipMemory = {
      id,
      sourceId: demoSiblingId(meetingId, 1),
      meetingId,
      occurredAt,
      evidenceOccurredAt: occurredAt,
      title: input.text(moment.title),
      description: input.text(moment.description),
      category: memoryCategory,
      personIds: momentPersonIds,
      candidateSubjectId: null,
      candidateSubjectKey: null,
      /** @external demo memory wire field */
      sensitive: false,
      confidence: "high",
      importance: moment.state === "pinned" ? LINT_NUM_N3 : LINT_NUM_N2,
      evidence: [{ segmentId: demoSiblingId(id, LINT_NUM_N2), quote }],
    };
    memoryTimes.set(id, time);
    memorySourceById.set(id, moment);
    memoryIdBySourceId.set(moment.id, id);

    return [memory];
  });
  const memories: RelationshipMemory[] = [...memoryRecords].sort((a, b) => {
    const byTime = (memoryTimes.get(b.id) ?? 0) - (memoryTimes.get(a.id) ?? 0);
    if (byTime !== 0) {
      return byTime;
    }
    const byImportance = (b.importance ?? 1) - (a.importance ?? 1);
    if (byImportance !== 0) {
      return byImportance;
    }

    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
  const memoriesByPerson = memories.reduce(
    (grouped, memory) =>
      memory.personIds.reduce((next, personId) => {
        const list = next.get(personId) ?? [];

        return new Map([...next, [personId, [...list, memory]]]);
      }, grouped),
    new Map<string, RelationshipMemory[]>(),
  );

  return { memories, memorySourceById, memoryIdBySourceId, memoryById, memoriesByPerson };
}

function buildDemoMeetingsBundle(input: {
  includePerson: (name: string) => boolean;
  text: (value: string) => string;
  at: (iso: string) => string;
  workspaceId: string;
  viewerId: string;
}) {
  const meetingSources = new Map<string, DemoMeetingSource>();
  const meetingsByPerson = new Map<string, { id: string; title: string; occurredAt: string }[]>();
  const meetings: Meeting[] = DEMO_MEETINGS.filter((fixture) =>
    fixture.participants.every((person) => input.includePerson(person.name)),
  )
    .map((fixture, index) => {
      const source: CandidateInterview = {
        ...fixture,
        title: input.text(fixture.title),
        preview: input.text(fixture.preview),
        notes: fixture.notes.map((note) => ({
          heading: input.text(note.heading),
          bullets: note.bullets.map(input.text),
        })),
        tasks: fixture.tasks.map((task) => ({
          ...task,
          title: input.text(task.title),
          description: input.text(task.description),
        })),
      };
      const id = demoId(`meeting:${fixture.id}`);
      const startedAt = input.at(source.startedAt);
      const endedAt = input.at(
        source.endedAt ?? new Date(Date.parse(source.startedAt) + LINT_NUM_N35 * LINT_NUM_N60_000).toISOString(),
      );
      const names = [...new Set(source.participants.map((participant) => participant.name))];
      const meeting: Meeting = {
        id,
        workspaceId: input.workspaceId,
        title: source.title,
        roomName: `ready-demo-${index + 1}`,
        createdByUserId: input.viewerId,
        kind: "standard",
        status: "ended",
        /** @external demo meeting wire field */
        isConfidential: false,
        confidentialitySource: null,
        /** @external demo meeting wire field */
        viewerCanChangeConfidentiality: false,
        viewerRole: "host",
        createdAt: startedAt,
        startedAt,
        endedAt,
        notePreview: source.preview,
        participantNames: names,
        participants: names.map((name) => ({
          userId: demoPersonId(name),
          displayName: name,
          avatarUrl: portraitUrl(name),
        })),
      };
      meetingSources.set(id, { meeting, source });
      if (names.includes(VIEWER)) {
        names.forEach((name) => {
          const personId = demoPersonId(name);
          const list = meetingsByPerson.get(personId) ?? [];
          meetingsByPerson.set(personId, [...list, { id, title: source.title, occurredAt: startedAt }]);
        });
      }

      return meeting;
    })
    .sort((a, b) => Date.parse(b.startedAt ?? b.createdAt) - Date.parse(a.startedAt ?? a.createdAt));

  return { meetings, meetingSources, meetingsByPerson };
}

const OPEN_MINE_DEMO_TASKS = new Set([
  "Review the security requirements with Livingston",
  "Check the mobile signup fix with Marcus",
  "Confirm the final pricing-page check",
  "Draft the weekly hiring update",
  "Confirm Dana’s salary range with Sergei",
  "Book security training with Omar",
  "Schedule Nia’s project follow-up",
  "Arrange three customer conversations",
]);

const COMPLETED_DEMO_TASK_EXAMPLES: [string, string, string][] = [
  ["Confirm the rollout review with Sophie", "Send the calendar invite for Meridian’s rollout review.", VIEWER],
  ["Share the permissions usability findings", "Send the five-session readout to the design team.", "Maya Lin"],
  [
    "Send Nia the portfolio feedback",
    "Ask for one example that connects a design decision to a better user outcome.",
    VIEWER,
  ],
];

function buildDemoWorkspaceTasks(input: {
  meetingSources: Map<string, DemoMeetingSource>;
  memberById: Map<string, WorkspaceMember>;
  workspaceId: string;
  viewerId: string;
  now: number;
  at: (iso: string) => string;
}): UnifiedAssignedTask[] {
  const tasks: UnifiedAssignedTask[] = Array.from(input.meetingSources.values())
    .flatMap(({ meeting, source }) => source.tasks.map((task, index) => ({ meeting, source, task, index })))
    .map(({ meeting, source, task, index }, position) => {
      const ownerId = demoPersonId(task.owner);
      const isMine = ownerId === input.viewerId;
      const owner = input.memberById.get(ownerId);

      return {
        sourceType: "meeting",
        sourceId: meeting.id,
        taskId: demoId(`task:${task.id ?? `${source.id}-${index}`}`),
        workspaceId: input.workspaceId,
        viewerWorkspaceId: input.workspaceId,
        /** @external demo task wire field */
        editable: isMine,
        /** @external demo task wire field */
        reassignable: true,
        /** @external demo task wire field */
        deletable: true,
        /** @external demo task wire field */
        reorderable: false,
        /** @external demo task wire field */
        isMine,
        owner:
          isMine || owner === undefined
            ? null
            : { userId: owner.userId, displayName: owner.displayName, avatarUrl: owner.avatarUrl },
        title: task.title,
        description: task.description !== "" ? task.description : null,
        status: "open",
        dueDate: { value: null, confidence: null },
        sectionId: UNPLACED_ASSIGNED_TASK_SECTION_ID,
        position,
        revision: 1,
        placementRevision: 1,
        updatedAt: meeting.endedAt ?? meeting.createdAt,
        completedAt: null,
        sourceMeeting: { id: meeting.id, title: meeting.title, startedAt: meeting.startedAt, endedAt: meeting.endedAt },
      };
    });
  const tasksWithAutoCompleted = tasks.map((task, index): UnifiedAssignedTask => {
    if (!task.isMine || OPEN_MINE_DEMO_TASKS.has(task.title)) {
      return task;
    }
    const meetingEnd = Date.parse(task.sourceMeeting?.endedAt ?? task.updatedAt);
    const completedAt = new Date(Math.min(input.now, meetingEnd + (1 + (index % LINT_NUM_N2)) * DAY_MS)).toISOString();

    return { ...task, status: "completed", revision: task.revision + 1, updatedAt: completedAt, completedAt };
  });
  const completedExampleTasks = COMPLETED_DEMO_TASK_EXAMPLES.map(
    ([title, description, ownerName], index): UnifiedAssignedTask => {
      const owner = input.memberById.get(demoPersonId(ownerName));
      const isMine = ownerName === VIEWER;
      const completedDayOffset = COMPLETED_DEMO_TASK_EXAMPLES.length - index;
      const completedAt = input.at(`2026-09-0${completedDayOffset}T10:00:00-07:00`);

      return {
        sourceType: "workspace",
        sourceId: demoId(`workspace-task:completed-${index}`),
        taskId: demoId(`workspace-task:completed-${index}`),
        workspaceId: input.workspaceId,
        viewerWorkspaceId: input.workspaceId,
        /** @external demo task wire field */
        editable: true,
        /** @external demo task wire field */
        reassignable: true,
        /** @external demo task wire field */
        deletable: true,
        /** @external demo task wire field */
        reorderable: false,
        /** @external demo task wire field */
        isMine,
        owner:
          isMine || owner === undefined
            ? null
            : { userId: owner.userId, displayName: owner.displayName, avatarUrl: owner.avatarUrl },
        title,
        description,
        status: "completed",
        dueDate: { value: null, confidence: null },
        sectionId: UNPLACED_ASSIGNED_TASK_SECTION_ID,
        position: tasksWithAutoCompleted.length + index,
        revision: 1,
        placementRevision: 1,
        updatedAt: completedAt,
        completedAt,
        sourceMeeting: null,
      };
    },
  );

  return [...tasksWithAutoCompleted, ...completedExampleTasks];
}

function buildDemoUpcomingMeetings(input: {
  now: number;
  includePerson: (name: string) => boolean;
  text: (value: string) => string;
}): DemoUpcomingMeeting[] {
  const upcomingDay = nextWeekday(input.now);
  const upcomingOffset = upcomingDay.getTime() - new Date(`${UPCOMING_ANCHOR_DAY}T00:00:00`).getTime();
  const atUpcoming = (iso: string) => new Date(Date.parse(iso) + upcomingOffset).toISOString();

  return DEMO_UPCOMING.filter((meeting) => meeting.participants.every(input.includePerson))
    .map((meeting) => {
      const brief = UPCOMING_BRIEFS[meeting.id];

      return {
        ...meeting,
        start: atUpcoming(meeting.start),
        end: atUpcoming(meeting.end),
        prep: {
          brief: (brief?.brief ?? []).map(input.text),
          people: (brief?.people ?? []).map(input.text),
          company: brief?.company ? { name: brief.company.name, bullets: brief.company.bullets.map(input.text) } : null,
          sources: (brief?.sources ?? []).map((source) => ({
            kind: source.kind,
            title: input.text(source.title),
            meetingId: source.kind === "meeting" ? demoId(`meeting:${source.meetingId}`) : null,
          })),
        },
      };
    })
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

function buildDemoViewerUser(input: { viewerId: string; workspaceId: string; createdAt: string }): User {
  return {
    id: input.viewerId,
    email: "sam@ready.example",
    displayName: VIEWER,
    avatarUrl: portraitUrl(VIEWER),
    source: "auth",
    authProvider: "google",
    plan: "business",
    /** @external demo user wire field */
    hasCompletedFirstMeeting: true,
    /** @external demo user wire field */
    hasCompletedAgentIntro: true,
    /** @external demo user wire field */
    memoryAvailable: true,
    workspaceId: input.workspaceId,
    sessionVersion: 1,
    createdAt: input.createdAt,
  };
}

function buildWorkspaceDemoDatasetNamed(
  input: {
    now?: number;
    options?: { /** @external demo dataset option */ workExamplesOnly?: boolean };
  } = {},
) {
  const now = input.now ?? Date.now();
  const options = input.options ?? {};
  const shiftMs = Math.floor((now - LAST_RECORDED_AT) / WEEK_MS) * WEEK_MS;
  const at = (iso: string) => new Date(Date.parse(iso) + shiftMs).toISOString();
  const text = (value: string) => shiftDatesInText({ text: value, shiftMs });
  const workspaceId = demoId("workspace:ready-demo");
  const viewerId = demoPersonId(VIEWER);
  const user = buildDemoViewerUser({ viewerId, workspaceId, createdAt: at("2025-01-06T09:00:00-08:00") });
  const includePerson = (name: string) =>
    !(options.workExamplesOnly ?? false) || (name !== DANNY_OCEAN && name !== RUSTY_RYAN);
  const sourceMoments = DEMO_MOMENTS.filter((moment) =>
    [...(moment.interactionWith ?? []), ...(moment.entities.people ?? [])].every(includePerson),
  );
  const previews = DEMO_PREVIEWS;
  // The snapshot already contains the latest 30 contacts. Do not derive the
  // roster from the 30 memories: some contacts have only older exchanges.
  const people: MemoryPerson[] = DEMO_PEOPLE.filter((person) => includePerson(person.name)).map((person) => ({
    ...person,
    lastContact: at(person.lastContact),
  }));
  const peopleByName = new Set(people.map((person) => person.name));
  const personById = new Map(people.map((person) => [person.id, person]));
  const { memories, memorySourceById, memoryIdBySourceId, memoryById, memoriesByPerson } = buildDemoMemoriesBundle({
    sourceMoments,
    peopleByName,
    shiftMs,
    text,
  });
  const { meetings, meetingSources, meetingsByPerson } = buildDemoMeetingsBundle({
    includePerson,
    text,
    at,
    workspaceId,
    viewerId,
  });

  const getPersonDetail = createGetPersonDetail({
    personById,
    memoriesByPerson,
    previews,
    memoryIdBySourceId,
    meetingsByPerson,
    text,
  });
  const getMemoryEvidence = createGetMemoryEvidence({ memoryById, memorySourceById, text });
  const getMeetingTranscript = createGetMeetingTranscript({ meetingSources, text });

  // Workspace members are everyone who owns a task, plus the viewer.
  const ownerNames = new Set([
    VIEWER,
    ...Array.from(meetingSources.values()).flatMap(({ source }) => source.tasks.map((task) => task.owner)),
  ]);
  const members: WorkspaceMember[] = [...ownerNames].map((name) => ({
    workspaceId,
    userId: demoPersonId(name),
    email:
      name === VIEWER
        ? user.email
        : emailFor({
            name,
            domain: personById.get(demoPersonId(name))?.companyDomain ?? TEAM_EMAIL_DOMAIN,
          }),
    displayName: name,
    avatarUrl: portraitUrl(name),
    role: name === VIEWER ? "admin" : "member",
  }));
  const memberById = new Map(members.map((member) => [member.userId, member]));
  const tasksFinal = buildDemoWorkspaceTasks({
    meetingSources,
    memberById,
    workspaceId,
    viewerId,
    now,
    at,
  });
  const upcoming = buildDemoUpcomingMeetings({ now, includePerson, text });

  return {
    user,
    workspaceId,
    workspaceName: "Ready",
    featuredPersonId: demoPersonId(SOPHIE_CHEN),
    people,
    personById,
    memories,
    memorySourceById,
    meetings,
    meetingSources,
    members,
    tasks: tasksFinal,
    upcoming,
    getPersonDetail,
    getMemoryEvidence,
    getMeetingTranscript,
  };
}

export function buildWorkspaceDemoDataset(
  input: {
    now?: number;
    options?: { /** @external demo dataset option */ workExamplesOnly?: boolean };
  } = {},
): ReturnType<typeof buildWorkspaceDemoDatasetNamed> {
  return buildWorkspaceDemoDatasetNamed(input);
}

export type WorkspaceDemoDataset = ReturnType<typeof buildWorkspaceDemoDatasetNamed>;
