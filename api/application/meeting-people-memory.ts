import type { MemoryScope } from "@readymeet/db/ports/repository";
import { meetingPeopleMemoryResponseSchema } from "@readymeet/shared";

import { bindPortFunction } from "../ports/bind-port";
import { isAuthorizedMeetingHost, type MeetingRecord } from "../ports/gate-meeting-access";
import { repositories } from "../ports/repository-runtime";

import { memorySectionFor } from "./person-card-private";
import { memoryReadContext } from "./relationship-memory";

const dependencies = {
  getUserById: bindPortFunction(() => repositories().getUserById),
  listParticipantsForMeeting: bindPortFunction(() => repositories().listParticipantsForMeeting),
  listWaitingJoinRequestsForMeeting: bindPortFunction(() => repositories().listWaitingJoinRequestsForMeeting),
  listMemoryPeople: bindPortFunction(() => repositories().listMemoryPeople),
  memoryPeopleForMeetingUsers: bindPortFunction(() => repositories().memoryPeopleForMeetingUsers),
  isAuthorizedMeetingHost,
  memoryReadContext,
  memorySectionFor,
};

type LoadMeetingPeopleMemoryParams = {
  scope: MemoryScope;
  meeting: MeetingRecord;
  overrides?: Partial<typeof dependencies>;
};

export async function meetingPeopleMemory(
  ...args: [scope: MemoryScope, meeting: MeetingRecord, overrides?: Partial<typeof dependencies>]
): Promise<ReturnType<typeof meetingPeopleMemoryResponseSchema.parse>> {
  const [scope, meeting, overrides = {}] = args;

  return loadMeetingPeopleMemory({ scope, meeting, overrides });
}

async function loadMeetingPeopleMemory({
  scope,
  meeting,
  overrides = {},
}: LoadMeetingPeopleMemoryParams): Promise<ReturnType<typeof meetingPeopleMemoryResponseSchema.parse>> {
  const deps = { ...dependencies, ...overrides };
  const context = await deps.memoryReadContext(scope);
  if (context.sourceIds.length === 0) {
    return { items: [] };
  }
  const [participants, people, isHost] = await Promise.all([
    deps.listParticipantsForMeeting(meeting.id),
    deps.listMemoryPeople({ scope, sourceIds: context.sourceIds }),
    deps.isAuthorizedMeetingHost({ meeting, userId: scope.userId }),
  ]);
  const subjects = new Map<string, string>();
  // Include assigned hosts, even before they arrive. Creating the meeting alone
  // does not make someone a subject: use the meeting's actual participant roles.
  participants.forEach((participant) => {
    if (participant.role !== "host" && (participant.role !== "guest" || participant.leftAt)) {
      return;
    }
    subjects.set(participant.userId, participant.joinedAt.toISOString());
  });
  // Waiting-room identities are available only to viewers allowed to admit them.
  if (isHost) {
    const requests = await deps.listWaitingJoinRequestsForMeeting(meeting.id);
    requests.forEach((request) => {
      subjects.set(request.userId, new Date(request.requestedAt).toISOString());
    });
  }
  subjects.delete(scope.userId);
  const identities = await deps.memoryPeopleForMeetingUsers({ scope, userIds: [...subjects.keys()] });
  const matched = new Map<string, string>();
  const matchedUsers = new Map<string, string>();
  [...subjects].forEach(([userId, occurredAt]) => {
    const ids = new Set(identities.filter((row) => row.userId === userId).map((row) => row.personId));
    if (ids.size !== 1) {
      return;
    }
    const [personId] = [...ids];
    if (personId === undefined) {
      return;
    }
    const previous = matched.get(personId);
    if (previous === undefined || occurredAt > previous) {
      matched.set(personId, occurredAt);
      matchedUsers.set(personId, userId);
    }
  });
  const items = await [...matched].reduce<Promise<unknown[]>>(async (previous, [personId, occurredAt]) => {
    const collected = await previous;
    const person = people.find((value) => value.id === personId);
    if (!person) {
      return collected;
    } // Includes source permissions, forgotten people and memory settings.
    const memory = await deps.memorySectionFor(scope, person.name, {
      memoryReadContext: async () => context,
      listMemoryPeople: async () => [person],
    });
    if (memory === null) {
      return collected;
    }
    const subjectId = matchedUsers.get(person.id);
    const subject = subjectId !== undefined && subjectId !== "" ? await deps.getUserById(subjectId) : null;
    const participantImageUrl = subject !== null && subject.deletedAt === null ? subject.avatarUrl : null;
    const participantEmail =
      subject !== null && subject.deletedAt === null && subject.source === "auth"
        ? subject.email
        : (memory.email ?? null);

    return collected.concat({
      id: person.id,
      meetingId: meeting.id,
      entityKind: "person" as const,
      canonicalKey: `private-memory:${person.id}`,
      displayName: person.name,
      qualifier: null,
      imageUrl: null,
      imageStatus: "unavailable" as const,
      professionalTitle: null,
      companyName: null,
      headquarters: null,
      officialWebsite: null,
      profileUrl: null,
      summary: null,
      facts: [],
      citations: [],
      facets: [],
      status: "ready" as const,
      mentionCount: 1,
      error: null,
      firstMentionedAt: occurredAt,
      lastMentionedAt: occurredAt,
      researchStartedAt: null,
      researchCompletedAt: occurredAt,
      createdAt: occurredAt,
      updatedAt: occurredAt,
      privateImageUrl: participantImageUrl,
      privateDetails: { memory: { ...memory, imageUrl: participantImageUrl, email: participantEmail }, ashby: null },
    });
  }, Promise.resolve([]));

  return meetingPeopleMemoryResponseSchema.parse({ items });
}
