import {
  compareRelationshipMemories,
  decodeMemoryPosition,
  encodeMemoryPosition,
  meetingDetailResponseSchema,
  meetingNotesViewResponseSchema,
  type MeetingTask,
  type NormalizedCalendarEvent,
  type RelationshipMemory,
  type UnifiedAssignedTask,
} from "@readymeet/shared";

import {
  capture,
  DEMO_MEETING_NOT_FOUND_MESSAGE,
  DEMO_MEETING_PREP_NOT_FOUND_MESSAGE,
  DEMO_MEMORY_NOT_FOUND_MESSAGE,
  DEMO_PERSON_NOT_FOUND_MESSAGE,
  DEMO_TASK_NO_LONGER_AVAILABLE_MESSAGE,
  demoMemoryMatchesCategoryFilter,
  demoMemoryMatchesDateFilter,
  demoMemoryMatchesPersonFilter,
  demoMemoryMatchesQueryFilter,
  demoTaskOwnerFromAssignee,
  type Filters,
  type Handler,
  LINT_NUM_N2,
  LINT_NUM_N3,
  LINT_NUM_N4,
  LINT_NUM_N6,
  LINT_NUM_N7,
  LINT_NUM_N8,
  LINT_NUM_N10,
  LINT_NUM_N12_000,
  LINT_NUM_N18,
  LINT_NUM_N86_400_000,
  LINT_NUM_N100,
  LINT_NUM_N340,
  LINT_NUM_N1000,
  LINT_NUM_N1660,
  LINT_NUM_N2000,
  notAvailable,
  notesToSummary,
  PAGE_SIZE,
  readDemoFilters,
  readDemoRequestBody,
  readOptionalString,
  readStringArray,
  readTaskStatus,
  secondCapture,
  workspaceDemoAbsoluteUrl,
  workspaceDemoOrigin,
  type WorkspaceDemoRequestHandler,
  type WorkspaceDemoRuntime,
} from "./demo-api-shared";
import { demoPersonId } from "./demo-dataset";
import { demoId } from "./demo-ids";

type WorkspaceDemoHandlerApi = {
  searchText: (memory: RelationshipMemory) => string;
  matchesFilters: (input: { memory: RelationshipMemory; filters: Filters }) => boolean;
  filterKey: (filters: Filters) => string;
  syncCursor: (filters: Filters) => string;
  listMemories: (input: { filters: Filters }) => unknown;
  syncMemories: (input: { body: Record<string, unknown> }) => unknown;
  forgetMemories: (input: { ids: string[] }) => unknown;
  personDetail: (personId: string) => unknown;
  meetingTask: (input: { task: UnifiedAssignedTask; position: number }) => MeetingTask;
  meetingTaskList: (meetingId: string) => unknown;
  meetingDetail: (meetingId: string) => unknown;
  updateTask: (input: { taskId: string; body: Record<string, unknown> }) => UnifiedAssignedTask;
  workspaceTask: (task: UnifiedAssignedTask) => unknown;
  createTask: (input: { body: Record<string, unknown> }) => UnifiedAssignedTask;
  readyMeetingFor: (meetingId: string) => unknown;
  calendarEvents: () => unknown;
  briefSourceUrl: (source: { kind: string; title: string; meetingId: string | null }) => string;
  calendarPrep: (prepId: string) => unknown;
};

export function createWorkspaceDemoHandlers(runtime: WorkspaceDemoRuntime): WorkspaceDemoRequestHandler {
  const meetings = workspaceDemoMeetingsSection(runtime);
  const meetingTaskList = meetings.meetingTaskList;
  if (typeof meetingTaskList !== "function") {
    throw new TypeError(String(meetingTaskList));
  }

  const api = {
    ...workspaceDemoMemorySection(runtime),
    ...meetings,
    ...workspaceDemoMeetingDetailSection({ runtime, meetingTaskList }),
    ...workspaceDemoTasksSection(runtime),
    ...workspaceDemoCalendarSection(runtime),
    ...workspaceDemoPrepSection(runtime),
  } satisfies WorkspaceDemoHandlerApi;

  return workspaceDemoRoutesSection({ runtime, api });
}

function workspaceDemoMemorySection(runtime: WorkspaceDemoRuntime) {
  const { session } = runtime;

  function searchText(memory: RelationshipMemory) {
    const searchIndex = (session.searchIndex ??= new Map<string, string>());
    const cached = searchIndex.get(memory.id);
    if (cached !== undefined) {
      return cached;
    }
    const text = `${memory.title} ${memory.description}`.toLowerCase();
    searchIndex.set(memory.id, text);

    return text;
  }

  function matchesFilters(input: { memory: RelationshipMemory; filters: Filters }) {
    const { memory, filters } = input;

    return (
      demoMemoryMatchesPersonFilter({ memory, filters }) &&
      demoMemoryMatchesCategoryFilter({ memory, filters }) &&
      demoMemoryMatchesDateFilter({ memory, filters }) &&
      demoMemoryMatchesQueryFilter({ memory, filters, searchText })
    );
  }

  const filterKey = (filters: Filters) =>
    JSON.stringify(
      Object.entries(filters)
        .filter(([key]) => key !== "before")
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  const syncCursor = (filters: Filters) => `demo.${session.memoryVersion}.${filterKey(filters)}`;

  function listMemories(input: { filters: Filters }) {
    const { filters } = input;
    const boundary = decodeMemoryPosition(filters.before);
    const matched = session.memories.filter((memory) => {
      if (boundary && compareRelationshipMemories(memory, boundary) <= 0) {
        return false;
      }

      return matchesFilters({ memory, filters });
    });
    const page = matched.slice(0, PAGE_SIZE);
    const hasMore = matched.length > PAGE_SIZE;
    const last = page.at(-1);

    return {
      memories: page,
      nextCursor: hasMore && last !== undefined ? encodeMemoryPosition(last) : null,
      syncCursor: syncCursor(filters),
    };
  }

  function syncMemories(input: { body: Record<string, unknown> }) {
    const { body } = input;
    const filters = readDemoFilters(body.filters);
    const cursor = readOptionalString(body.cursor) ?? "";
    const [, version, ...scope] = cursor.split(".");
    if (scope.join(".") !== filterKey(filters)) {
      return {
        memories: [],
        removedIds: [],
        /** @external demo memory sync wire field */
        reset: true,
        /** @external demo memory sync wire field */
        hasMore: false,
        syncCursor: "",
      };
    }

    return {
      memories: [],
      removedIds: session.forgotten.filter((entry) => entry.version > Number(version)).map((entry) => entry.id),
      hasMore: false,
      syncCursor: syncCursor(filters),
    };
  }

  function forgetMemories(input: { ids: string[] }) {
    const { ids } = input;
    const removed = new Set(ids);
    session.memoryVersion += 1;
    session.forgotten = [...session.forgotten, ...ids.map((id) => ({ id, version: session.memoryVersion }))];
    session.memories = session.memories.filter((memory) => !removed.has(memory.id));

    return { /** @external demo API wire field */ ok: true };
  }

  return { searchText, matchesFilters, filterKey, syncCursor, listMemories, syncMemories, forgetMemories };
}

function workspaceDemoMeetingsSection(runtime: WorkspaceDemoRuntime) {
  const { dataset, session, user } = runtime;

  function personDetail(personId: string) {
    const detail = dataset.getPersonDetail(personId);
    if (!detail) {
      throw notAvailable(DEMO_PERSON_NOT_FOUND_MESSAGE);
    }
    const live = new Set(session.memories.map((memory) => memory.id));
    const personMemories = detail.memories.filter((memory) => live.has(memory.id));
    const projection =
      detail.projection !== null
        ? {
            summary: detail.projection.summary,
            standing: detail.projection.standing
              .map((item) => ({ ...item, memoryIds: item.memoryIds.filter((id) => live.has(id)) }))
              .filter((item) => item.memoryIds.length !== 0),
          }
        : undefined;

    return { ...detail, projection, memories: personMemories };
  }

  function meetingTask(input: { task: UnifiedAssignedTask; position: number }): MeetingTask {
    const { task, position } = input;
    const owner = task.isMine
      ? { userId: user.id, name: user.displayName, email: user.email, confidence: "high" as const }
      : {
          userId: task.owner?.userId ?? null,
          name: task.owner?.displayName ?? null,
          email: null,
          confidence: "high" as const,
        };

    return {
      id: task.taskId,
      meetingId: task.sourceId,
      taskListId: demoId(`task-list:${task.sourceId}`),
      position,
      title: task.title,
      description: task.description,
      type: "action_item",
      workKind: "general",
      owner,
      assignee: owner,
      dueDate: task.dueDate,
      confidence: "high",
      sourceQuotes: [{ quote: task.title, speaker: owner.name, timestamp: null }],
      sourceReason: "Agreed during the meeting.",
      status: task.status,
      revision: task.revision,
      createdFrom: "meeting_transcript",
      origin: "final",
      statusSource: "user",
      statusActorUserId: null,
      statusChangedAt: null,
      actionConfirmableAt: null,
      detectedAt: null,
      firstRenderedAt: null,
      assetIds: [],
      externalLinks: [],
      createdAt: task.sourceMeeting?.endedAt ?? task.updatedAt,
      updatedAt: task.updatedAt,
      completedAt: task.completedAt,
    };
  }

  function meetingTaskList(meetingId: string) {
    const entry = dataset.meetingSources.get(meetingId);
    if (!entry) {
      throw notAvailable(DEMO_MEETING_NOT_FOUND_MESSAGE);
    }
    const endedAt = entry.meeting.endedAt ?? entry.meeting.createdAt;

    return {
      id: demoId(`task-list:${meetingId}`),
      meetingId,
      status: "completed",
      phase: null,
      error: null,
      model: null,
      promptVersion: null,
      transcriptHash: null,
      taskListVersion: 1,
      items: session.tasks
        .filter((task) => task.sourceType === "meeting" && task.sourceId === meetingId && task.status !== "dismissed")
        .map((task, position) => meetingTask({ task, position })),
      createdAt: endedAt,
      updatedAt: endedAt,
      completedAt: endedAt,
    };
  }

  return { personDetail, meetingTask, meetingTaskList };
}

function workspaceDemoMeetingDetailSection(input: {
  runtime: WorkspaceDemoRuntime;
  meetingTaskList: WorkspaceDemoHandlerApi["meetingTaskList"];
}) {
  const { runtime, meetingTaskList } = input;
  const { dataset, user } = runtime;

  function meetingDetail(meetingId: string) {
    const entry = dataset.meetingSources.get(meetingId);
    if (!entry) {
      throw notAvailable(DEMO_MEETING_NOT_FOUND_MESSAGE);
    }
    const { meeting, source } = entry;
    const endedAt = meeting.endedAt ?? meeting.createdAt;
    const turns = dataset.getMeetingTranscript(meetingId);
    const transcriptId = demoId(`transcript:${meetingId}`);
    const startedAt = Date.parse(meeting.startedAt ?? meeting.createdAt);

    return {
      meeting,
      meetingRuntime: {
        activeHumanParticipantCount: 0,
        activeHumanParticipants: [],
        allHumanParticipants: (meeting.participants ?? []).map((participant) => ({
          userId: participant.userId,
          displayName: participant.displayName,
          email: participant.userId === user.id ? user.email : null,
          avatarUrl: participant.avatarUrl,
          role: participant.userId === user.id ? "host" : "guest",
        })),
        isAwaitingMeetingEnd: false,
      },
      transcript:
        turns.length !== 0
          ? { id: transcriptId, meetingId, source: "livekit", mode: "realtime", isFinal: true, refinedAt: endedAt }
          : null,
      transcriptSegments: turns.map((turn, index) => {
        const speakerId = demoPersonId(turn.speaker);
        const segmentStart = startedAt + turn.seconds * LINT_NUM_N1000;

        return {
          id: demoId(`transcript-segment:${meetingId}:${index}`),
          transcriptId,
          speakerIdentity: speakerId,
          speakerUserId: speakerId,
          speakerRole: "human",
          speakerName: turn.speaker,
          source: "livekit",
          sourceSegmentId: null,
          content: turn.text,
          startedAt: new Date(segmentStart).toISOString(),
          endedAt: new Date(segmentStart + LINT_NUM_N12_000).toISOString(),
        };
      }),
      summary:
        source.notes.length !== 0
          ? {
              id: demoId(`summary:${meetingId}`),
              meetingId,
              content: notesToSummary(source.notes),
              model: "ready-demo",
              generatedAt: endedAt,
            }
          : null,
      notesPreview: null,
      actionItems: [],
      tasks: meetingTaskList(meetingId),
      linearTaskReview: null,
      capabilityRecommendations: [],
      webResearchRuns: [],
      researchRuns: [],
      postMeetingDisposition: null,
      notesAccess: { /** @external demo meeting notes wire field */ locked: false, reason: null },
    };
  }

  return { meetingDetail };
}

function workspaceDemoTasksSection(runtime: WorkspaceDemoRuntime) {
  const { dataset, user, workspaceId, session, memoryPreferences } = runtime;

  function updateTask(input: { taskId: string; body: Record<string, unknown> }) {
    const { taskId, body } = input;
    const current = session.tasks.find((task) => task.taskId === taskId);
    if (!current) {
      throw notAvailable(DEMO_TASK_NO_LONGER_AVAILABLE_MESSAGE);
    }
    const assigneeUserId = readOptionalString(body.assigneeUserId);
    const ownerState = demoTaskOwnerFromAssignee({
      runtime: { dataset, user, workspaceId, session, memoryPreferences },
      assigneeUserId,
      current,
    });
    const status = readTaskStatus({ value: body.status, fallback: current.status });
    const now = new Date().toISOString();
    const updated: UnifiedAssignedTask = {
      ...current,
      title: typeof body.title === "string" ? body.title : current.title,
      description:
        body.description === undefined ? current.description : (readOptionalString(body.description) ?? null),
      dueDate:
        body.dueDateValue === undefined
          ? current.dueDate
          : { value: readOptionalString(body.dueDateValue) ?? null, confidence: null },
      status,
      /** @external demo task wire field */
      isMine: ownerState.isMine,
      /** @external demo task wire field */
      editable: current.sourceType === "workspace" || ownerState.isMine,
      owner: ownerState.owner,
      revision: current.revision + 1,
      updatedAt: now,
      completedAt: status === "completed" ? (current.completedAt ?? now) : null,
    };
    session.tasks = session.tasks.map((task) => (task.taskId === taskId ? updated : task));

    return updated;
  }

  function workspaceTask(task: UnifiedAssignedTask) {
    return {
      id: task.taskId,
      workspaceId,
      createdByUserId: user.id,
      updatedByUserId: user.id,
      assigneeUserId: task.isMine ? user.id : (task.owner?.userId ?? null),
      title: task.title,
      description: task.description,
      dueDate: task.dueDate,
      status: task.status,
      revision: task.revision,
      completedAt: task.completedAt,
      createdAt: task.updatedAt,
      updatedAt: task.updatedAt,
    };
  }

  function createTask(input: { body: Record<string, unknown> }) {
    const { body } = input;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const assigneeUserId = readOptionalString(body.assigneeUserId) ?? user.id;
    const member = dataset.members.find((item) => item.userId === assigneeUserId);
    const isMine = assigneeUserId === user.id;
    const task: UnifiedAssignedTask = {
      sourceType: "workspace",
      sourceId: id,
      taskId: id,
      workspaceId,
      viewerWorkspaceId: workspaceId,
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
        isMine || !member
          ? null
          : { userId: member.userId, displayName: member.displayName, avatarUrl: member.avatarUrl },
      title: typeof body.title === "string" && body.title.trim() !== "" ? body.title : "New task",
      description: readOptionalString(body.description) ?? null,
      status: "open",
      dueDate: { value: readOptionalString(body.dueDateValue) ?? null, confidence: null },
      sectionId: readOptionalString(body.sectionId) ?? session.tasks[0]?.sectionId ?? demoId("section:default"),
      position: 0,
      revision: 1,
      placementRevision: 1,
      updatedAt: now,
      completedAt: null,
      sourceMeeting: null,
    };
    session.tasks = [task, ...session.tasks];

    return task;
  }

  // Every upcoming call is a Ready meeting: a join link in the usual
  // xxx-xxxx-xxx form plus dial-in on a reserved fictional 555-01xx number.
  return { updateTask, workspaceTask, createTask };
}

function workspaceDemoCalendarSection(runtime: WorkspaceDemoRuntime) {
  const { dataset, user } = runtime;
  const origin = workspaceDemoOrigin();
  const absoluteUrl = (path: string | null | undefined) => workspaceDemoAbsoluteUrl({ origin, path });

  function readyMeetingFor(meetingId: string) {
    const letters = demoId(`meeting-link:${meetingId}`)
      .replace(/[^a-f0-9]/g, "")
      .split("")
      .map((digit) => "abcdefghjkmnpqrstuvwxyz".charAt(parseInt(digit, 16) + LINT_NUM_N7))
      .join("");
    const code = `${letters.slice(0, LINT_NUM_N3)}-${letters.slice(LINT_NUM_N3, LINT_NUM_N7)}-${letters.slice(LINT_NUM_N7, LINT_NUM_N10)}`;
    const digits = demoId(`meeting-pin:${meetingId}`).replace(/[^0-9]/g, "");

    return {
      source: "mapping" as const,
      meetingLinkId: demoId(`meeting-link:${meetingId}`),
      code,
      joinUrl: `https://ready.app/${code}`,
      callIn: {
        phoneNumber: `+1415555${String(LINT_NUM_N100 + (parseInt(digits.slice(0, LINT_NUM_N2), LINT_NUM_N10) % LINT_NUM_N100)).padStart(LINT_NUM_N4, "0")}`,
        pin: digits.slice(LINT_NUM_N2, LINT_NUM_N8).padEnd(LINT_NUM_N6, "0"),
      },
    };
  }

  function calendarEvents() {
    const events: NormalizedCalendarEvent[] = dataset.upcoming.map((meeting) => ({
      id: `demo-${meeting.id}`,
      calendarAccountId: demoId("calendar-account:google"),
      provider: "google_calendar",
      providerEventId: meeting.id,
      calendarId: "primary",
      title: meeting.title,
      start: meeting.start,
      end: meeting.end,
      timezone: "America/Los_Angeles",
      location: null,
      organizer: { name: user.displayName, email: user.email, responseStatus: "accepted" },
      attendees: meeting.participants.map((name) => ({
        name,
        avatarUrl: absoluteUrl(
          dataset.personById.get(demoPersonId(name))?.imageUrl ??
            dataset.members.find((member) => member.displayName === name)?.avatarUrl,
        ),
        email:
          name === user.displayName
            ? user.email
            : `${(name.split(" ")[0] ?? "person").toLowerCase()}@${dataset.personById.get(demoPersonId(name))?.companyDomain ?? "ready.app"}`,
        responseStatus: "accepted",
      })),
      isPrivate: false,
      isCancelled: false,
      isAllDay: false,
      canAddReadyMeeting: false,
      joinUrl: readyMeetingFor(meeting.id).joinUrl,
      readyMeeting: readyMeetingFor(meeting.id),
      sourceUrl: null,
    }));

    return {
      events,
      connectedProviders: ["google_calendar"],
      /** @external demo calendar wire field */
      needsConnection: false,
      prepAccess: {
        canStartCalendarPrep: false,
        freeCalendarPrepLimit: LINT_NUM_N3,
        hasPrepPlan: true,
        calendarPrepCount: events.length,
      },
      // Every upcoming call already has its brief, as if prepared overnight.
      prepSummaries: dataset.upcoming.map((meeting) => ({
        calendarEventId: `demo-${meeting.id}`,
        eventFingerprint: meeting.id,
        prepId: demoId(`prep:${meeting.id}`),
        status: "completed",
        /** @external demo calendar prep wire field */
        companyVisible: meeting.prep.company !== null,
        progress: null,
      })),
    };
  }

  return { readyMeetingFor, calendarEvents };
}

function workspaceDemoPrepSection(runtime: WorkspaceDemoRuntime) {
  const { dataset } = runtime;
  const origin = workspaceDemoOrigin();

  function briefSourceUrl(source: { kind: string; title: string; meetingId: string | null }) {
    if (source.meetingId !== null && source.meetingId !== "") {
      return `${origin}/workspace/${source.meetingId}`;
    }
    const key = demoId(`brief-source:${source.title}`).slice(0, LINT_NUM_N8);
    if (source.kind === "slack") {
      return `https://app.slack.com/client/demo/${key}`;
    }
    if (source.kind === "linkedin") {
      return `https://www.linkedin.com/in/demo-${key}`;
    }

    return `https://mail.google.com/mail/u/0/#all/${key}`;
  }

  function calendarPrep(prepId: string) {
    const meeting = dataset.upcoming.find((item) => demoId(`prep:${item.id}`) === prepId);
    if (!meeting) {
      throw notAvailable(DEMO_MEETING_PREP_NOT_FOUND_MESSAGE);
    }
    const sources = meeting.prep.sources.map((source) => ({ title: source.title, url: briefSourceUrl(source) }));

    return {
      prepId,
      status: "completed",
      brief: { status: "completed", bullets: meeting.prep.brief },
      people: { status: "completed", bullets: meeting.prep.people, sources },
      company: meeting.prep.company
        ? {
            status: "completed",
            companyName: meeting.prep.company.name,
            website: null,
            bullets: meeting.prep.company.bullets,
            sources: [],
          }
        : null,
      sources,
      error: null,
      progress: null,
    };
  }

  return { briefSourceUrl, calendarPrep };
}

type WorkspaceDemoRouteContext = WorkspaceDemoRuntime & {
  billing: Record<string, unknown>;
  workspaceSummary: { id: string; name: string; logoUrl: null; role: string };
  ws: string;
  agentProfile: Record<string, unknown>;
} & WorkspaceDemoHandlerApi;

function workspaceDemoRouteFixtures(runtime: WorkspaceDemoRuntime) {
  const { dataset, user, workspaceId } = runtime;
  const billing = {
    checkout: null,
    plan: "business",
    /** @external demo billing wire field */
    subscriptionActive: true,
    allowanceCredits: LINT_NUM_N2000,
    allowanceUsed: LINT_NUM_N340,
    allowanceRemaining: LINT_NUM_N1660,
    allowanceWindowEnd: new Date(Date.now() + LINT_NUM_N18 * LINT_NUM_N86_400_000).toISOString(),
    poolBalance: 0,
    /** @external demo billing wire field */
    trialEligible: false,
    trialCreditsUsed: 0,
    /** @external demo billing wire field */
    hasTrialCredits: false,
    trialMeetingsRemaining: 0,
  };
  const workspaceSummary = { id: workspaceId, name: dataset.workspaceName, logoUrl: null, role: "admin" };
  const ws = `/workspaces/${workspaceId}`;
  const agentProfile = {
    id: demoId("agent-profile:ready"),
    userId: user.id,
    name: "ready",
    displayName: "Ready",
    systemPrompt: null,
    voiceProvider: "openai",
    voiceId: null,
    llmModel: null,
    isDefault: true,
    createdAt: user.createdAt,
    updatedAt: user.createdAt,
  };

  return { billing, workspaceSummary, ws, agentProfile };
}

function demoMeetingNotesView(value: unknown) {
  const detail = meetingDetailResponseSchema.parse(value);

  return meetingNotesViewResponseSchema.parse({
    ...detail,
    hasTranscriptSegments: detail.transcriptSegments.length !== 0,
  });
}

function workspaceDemoMemoryAndMeetingRoutes(ctx: WorkspaceDemoRouteContext): [string, RegExp, Handler][] {
  const {
    dataset,
    user,
    workspaceId,
    session,
    memoryPreferences,
    billing,
    workspaceSummary,
    ws,
    listMemories,
    syncMemories,
    forgetMemories,
    personDetail,
    meetingDetail,
    meetingTaskList,
  } = ctx;

  return [
    ["GET", /^\/auth\/me$/, () => ({ token: "ready-demo", user })],
    ["GET", /^\/me\/workspaces$/, () => ({ workspaceIds: [workspaceId] })],
    [
      "GET",
      /^\/me\/workspace$/,
      () => ({
        workspace: { ...workspaceSummary, status: "active" },
        workspaces: [{ ...workspaceSummary, isActive: true }],
      }),
    ],
    ["GET", new RegExp(`^${ws}/billing/me$`), () => ({ billing })],
    ["GET", new RegExp(`^${ws}/members$`), () => ({ members: dataset.members })],
    [
      "GET",
      new RegExp(`^${ws}/memory/status$`),
      () => ({
        /** @external demo memory status wire field */
        available: true,
        preferences: memoryPreferences,
        processingMeeting: null,
        progress: { queued: 0, running: 0, completed: dataset.meetings.length, failed: 0 },
      }),
    ],
    [
      "PUT",
      new RegExp(`^${ws}/memory/preferences$`),
      ({ context: { body } }) => Object.assign(memoryPreferences, body),
    ],
    [
      "GET",
      new RegExp(`^${ws}/memory$`),
      ({ context: { query } }) => listMemories({ filters: Object.fromEntries(query) }),
    ],
    ["POST", new RegExp(`^${ws}/memory/sync$`), ({ context: { body } }) => syncMemories({ body })],
    [
      "POST",
      new RegExp(`^${ws}/memory/actions$`),
      ({ context: { body } }) => forgetMemories({ ids: readStringArray(body.ids) }),
    ],
    ["GET", new RegExp(`^${ws}/memory/people$`), () => ({ people: dataset.people })],
    ["GET", new RegExp(`^${ws}/memory/people/([^/]+)$`), ({ match }) => personDetail(capture(match))],
    [
      "GET",
      new RegExp(`^${ws}/memory/([^/]+)$`),
      ({ match }) => {
        const evidence = dataset.getMemoryEvidence(capture(match));
        if (!evidence) {
          throw notAvailable(DEMO_MEMORY_NOT_FOUND_MESSAGE);
        }

        return { evidence };
      },
    ],
    ["GET", /^\/meetings$/, () => ({ meetings: session.recentMeetings })],
    ["GET", /^\/meetings\/([^/]+)$/, ({ match }) => meetingDetail(capture(match))],
    ["GET", /^\/meetings\/([^/]+)\/notes-view$/, ({ match }) => demoMeetingNotesView(meetingDetail(capture(match)))],
    ["GET", /^\/meetings\/([^/]+)\/linear-task-review$/, () => ({ review: null })],
    [
      "DELETE",
      /^\/meetings\/([^/]+)$/,
      ({ match }) => {
        session.recentMeetings = session.recentMeetings.filter((meeting) => meeting.id !== match[1]);

        return { /** @external demo API wire field */ ok: true };
      },
    ],
    [
      "GET",
      /^\/meetings\/([^/]+)\/tasks\/status$/,
      ({ match }) => ({
        status: "completed",
        phase: "completed",
        error: null,
        /** @external demo task status wire field */
        isTerminal: true,
        /** @external demo task status wire field */
        isCurrent: true,
        job: null,
        tasks: meetingTaskList(capture(match)),
        progress: null,
        serverNow: new Date().toISOString(),
      }),
    ],
  ];
}

function workspaceDemoTaskAndCalendarRoutes(ctx: WorkspaceDemoRouteContext): [string, RegExp, Handler][] {
  const {
    session,
    ws,
    agentProfile,
    meetingTask,
    updateTask,
    workspaceTask,
    createTask,
    calendarEvents,
    calendarPrep,
  } = ctx;

  return [
    ["GET", /^\/meetings\/[^/]+\/research-runs$/, () => ({ runs: [] })],
    ["GET", /^\/meetings\/[^/]+\/capability-workflows$/, () => ({ workflows: [] })],
    ["GET", /^\/meetings\/[^/]+\/assets$/, () => ({ assets: [] })],
    ["GET", /^\/meetings\/[^/]+\/ambient-context$/, () => ({ items: [] })],
    [
      "PATCH",
      /^\/meetings\/([^/]+)\/tasks\/([^/]+)$/,
      ({ match, context: { body } }) => {
        const task = updateTask({ taskId: secondCapture(match), body });

        return { task: meetingTask({ task, position: 0 }) };
      },
    ],
    ["POST", /^\/meetings\/[^/]+\/tasks\/[^/]+\/rendered$/, () => ({ /** @external demo API wire field */ ok: true })],
    [
      "GET",
      /^\/me\/tasks\/personal$/,
      () => ({
        tasks: session.tasks.filter((task) => task.status !== "dismissed"),
        sourceMeetings: [],
      }),
    ],
    ["POST", new RegExp(`^${ws}/tasks$`), ({ context: { body } }) => ({ task: workspaceTask(createTask({ body })) })],
    [
      "PATCH",
      new RegExp(`^${ws}/tasks/([^/]+)$`),
      ({ match, context: { body } }) => ({
        task: workspaceTask(updateTask({ taskId: capture(match), body })),
      }),
    ],
    [
      "DELETE",
      new RegExp(`^${ws}/tasks$`),
      ({ context: { body } }) => {
        const ids = new Set(readStringArray(body.taskIds));
        session.tasks = session.tasks.filter((task) => !ids.has(task.taskId));

        return { taskIds: [...ids] };
      },
    ],
    ["GET", /^\/me\/calendar\/events/, () => calendarEvents()],
    ["GET", /^\/me\/calendar\/prep\/([^/]+)$/, ({ match }) => calendarPrep(decodeURIComponent(capture(match)))],
    [
      "POST",
      /^\/me\/calendar\/prep\/estimate$/,
      () => ({
        plan: {
          totalRuns: 0,
          peopleRunCount: 0,
          companyRunCount: 0,
          externalParticipantCount: 0,
          peopleTargetCount: 0,
          /** @external demo calendar prep wire field */
          companyVisible: false,
          advancedSearchRequestCount: 0,
        },
        options: [],
      }),
    ],
    ["GET", /^\/me\/calendar\/accounts$/, () => ({ accounts: [] })],
    ["POST", /^\/meetings\/[^/]+\/slack-review\/prepare$/, () => ({ review: null })],
    ["GET", /^\/me\/agent$/, () => ({ profile: agentProfile, memories: [], connectors: [], toolPolicies: [] })],
  ];
}

function workspaceDemoApiRequestHandler(routes: [string, RegExp, Handler][]): WorkspaceDemoRequestHandler {
  async function handleDemoApiRequestNamed(input: { path: string; options: RequestInit }): Promise<unknown> {
    const { path, options } = input;
    const method = (options.method ?? "GET").toUpperCase();
    const url = new URL(path, "https://demo.ready.local");
    const body = readDemoRequestBody(options.body);
    const matched = routes.reduce<{ handler: Handler; match: RegExpMatchArray } | null>(
      (found, [routeMethod, pattern, handler]) => {
        if (found !== null || routeMethod !== method) {
          return found;
        }
        const match = url.pathname.match(pattern);

        return match === null ? found : { handler, match };
      },
      null,
    );
    // Stored records are replaced, never mutated, so responses can share them.
    if (matched !== null) {
      return matched.handler({ match: matched.match, context: { body, query: url.searchParams } });
    }
    if (process.env.NODE_ENV !== "production") {
      console.error("[workspace demo] unhandled API request.", method, path);
    }
    throw notAvailable();
  }

  return handleDemoApiRequestNamed;
}

function workspaceDemoRoutesSection(input: {
  runtime: WorkspaceDemoRuntime;
  api: WorkspaceDemoHandlerApi;
}): WorkspaceDemoRequestHandler {
  const routeContext: WorkspaceDemoRouteContext = {
    ...input.runtime,
    ...workspaceDemoRouteFixtures(input.runtime),
    ...input.api,
  };

  return workspaceDemoApiRequestHandler([
    ...workspaceDemoMemoryAndMeetingRoutes(routeContext),
    ...workspaceDemoTaskAndCalendarRoutes(routeContext),
  ]);
}
