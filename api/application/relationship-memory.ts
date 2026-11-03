import type { MemoryJob, MemoryScope, MemorySource, RepositoryPort } from "@readymeet/db/ports/repository";
import {
  memoryGenerationSchema,
  rejectMemoryValidation,
  type RelationshipMemory,
  validateMemoryGeneration,
} from "@readymeet/shared";

import { apiEnv } from "../ports/api-env";
import { triggerMemoryGeneration } from "../ports/gate-assistant-client";
import { repositories } from "../ports/repository-runtime";

import { resolveMeetingNotesAccess } from "./meeting-notes-access";

const RELATIONSHIP_MEMORY_PAGE_LIMIT = 200;

const MEMORY_SOURCE_UNAVAILABLE_MESSAGE = "Memory source is unavailable";
const MEMORY_SOURCE_CHANGED_MESSAGE = "Memory source changed";
const MEMORY_SOURCE_ACCESS_CHANGED_MESSAGE = "Memory source access changed before generation";

async function filterMemorySourcesByNotesAccess(
  ...args: [scope: MemoryScope, sources: MemorySource[]]
): Promise<MemorySource[]> {
  return filterMemorySourcesByNotesAccessNamed({ scope: args[0], sources: args[1] });
}

async function filterMemorySourcesByNotesAccessNamed({
  scope,
  sources,
}: {
  scope: MemoryScope;
  sources: MemorySource[];
}): Promise<MemorySource[]> {
  return sources.reduce<Promise<MemorySource[]>>(async (pendingAllowed, source) => {
    const allowed = await pendingAllowed;
    const access = await resolveMeetingNotesAccess({
      meeting: {
        ...source,
        id: source.meetingId,
        workspaceId: source.meetingWorkspaceId ?? source.workspaceId,
      },
      viewerRole: "participant",
      userId: scope.userId,
    });

    return access.locked ? allowed : [...allowed, source];
  }, Promise.resolve([]));
}

async function enqueueAttendeeMeetingMemory(...args: [scope: MemoryScope, meetingId: string]): Promise<void> {
  return enqueueAttendeeMeetingMemoryNamed({ scope: args[0], meetingId: args[1] });
}

async function enqueueAttendeeMeetingMemoryNamed({
  scope,
  meetingId,
}: {
  scope: MemoryScope;
  meetingId: string;
}): Promise<void> {
  if (!apiEnv().MEMORY_ENABLED) {
    return;
  }
  const prefs = await repositories().getMemoryPreferences(scope);
  const meetings = await filterMemorySourcesByNotesAccess(
    scope,
    await repositories().listEligibleMemoryMeetings({ scope, meetingId }),
  );
  // Complete each attendee's generation before returning to the caller.
  await meetings.reduce(async (pending, meeting) => {
    await pending;
    const job = await repositories().enqueueMemorySource({ scope, meeting, preferencesRevision: prefs.revision });
    if (job === null) {
      return;
    }
    try {
      await processMemoryJob(job);
      await repositories().finishMemoryJob({ job });
    } catch (error) {
      await repositories().finishMemoryJob({ job, error });
      throw error;
    }
  }, Promise.resolve());
}
export async function generateFinalizedMeetingMemories(meetingId: string): Promise<void> {
  if (!apiEnv().MEMORY_ENABLED) {
    return;
  }
  const scopes = await repositories().listMemoryMeetingAttendees(meetingId);
  await scopes.reduce(async (pending, scope) => {
    await pending;
    await enqueueAttendeeMeetingMemory(scope, meetingId);
  }, Promise.resolve());
}

export async function memoryReadContext(scope: MemoryScope): Promise<{
  preferences: Awaited<ReturnType<RepositoryPort["getMemoryPreferences"]>>;
  sources: MemorySource[];
  sourceIds: string[];
}> {
  const preferences = await repositories().getMemoryPreferences(scope);
  const sources = apiEnv().MEMORY_ENABLED
    ? await filterMemorySourcesByNotesAccess(scope, await repositories().listAccessibleMemorySources(scope))
    : [];
  const sourceIds = sources.map((s) => s.id);

  return { preferences, sources, sourceIds };
}
async function readRelationshipMemoryPages({
  sourceIds,
  personId,
  before,
}: {
  sourceIds: string[];
  personId: string | undefined;
  before: string | undefined;
}): Promise<RelationshipMemory[]> {
  const page = await repositories().listRelationshipMemories({
    sourceIds,
    filters: {
      personId,
      before,
      limit: RELATIONSHIP_MEMORY_PAGE_LIMIT,
    },
  });
  if (page.length < RELATIONSHIP_MEMORY_PAGE_LIMIT) {
    return page;
  }

  const lastMemory = page.at(-1);
  if (!lastMemory) {
    return page;
  }

  const remaining = await readRelationshipMemoryPages({ sourceIds, personId, before: lastMemory.id });

  return [...page, ...remaining];
}

export async function allActiveMemories(
  ...args: [sourceIds: string[], personId?: string]
): Promise<RelationshipMemory[]> {
  return readRelationshipMemoryPages({ sourceIds: args[0], personId: args[1], before: undefined });
}

type ProcessMemoryJobOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: { pass: number; totalPasses: number; state: "started" | "saved" }) => void;
};

export async function processMemoryJob(...args: [job: MemoryJob, options?: ProcessMemoryJobOptions]): Promise<void> {
  return processMemoryJobNamed({ job: args[0], ...(args[1] ?? {}) });
}

async function processMemoryJobNamed({
  job,
  signal,
  onProgress,
}: {
  job: MemoryJob;
  signal?: AbortSignal;
  onProgress?: ProcessMemoryJobOptions["onProgress"];
}): Promise<void> {
  signal?.throwIfAborted();
  const preferences = await repositories().getMemoryPreferences(job);
  const context = await memoryReadContext(job);
  const source = context.sources.find((s) => s.id === job.sourceId && s.revision === job.sourceRevision);
  if (source === undefined) {
    throw new Error(MEMORY_SOURCE_UNAVAILABLE_MESSAGE);
  }
  const input = await repositories().prepareMemoryInput({ scope: job, source, preferences });
  if (input.people.length === 0) {
    return;
  }

  const existing = await repositories().listMemoryProjectionEvidence({
    sourceIds: context.sourceIds.filter((id) => id !== source.id),
    personIds: input.people.map((person) => person.id),
  });
  // Multiple guest sessions in one meeting may refer to the same memory person.
  const history = [...new Map(input.people.map((person) => [person.id, person])).values()].map((person) => {
    const memories = existing.filter((memory) => memory.personIds.includes(person.id));

    return {
      meetingId: input.meetingId,
      personId: person.id,
      name: person.name,
      language: preferences.language,
      memories: memories.map(({ id, title, description, occurredAt }) => ({
        id,
        title,
        description,
        occurredAt,
      })),
    };
  });
  // All supplied history can influence any generated paragraph, even if it is not cited.
  const inputSourceIds = new Set([source.id, ...existing.map((memory) => memory.sourceId)]);
  const inputSources = context.sources.filter((item) => inputSourceIds.has(item.id));
  const beforeRequest = await memoryReadContext(job);
  if (!beforeRequest.sources.some((s) => s.id === source.id && s.revision === source.revision)) {
    throw new Error(MEMORY_SOURCE_CHANGED_MESSAGE);
  }
  if (context.sourceIds.some((id) => !beforeRequest.sourceIds.includes(id))) {
    throw new Error(MEMORY_SOURCE_ACCESS_CHANGED_MESSAGE);
  }
  await repositories().heartbeatMemoryJob(job);
  onProgress?.({ pass: 1, totalPasses: 1, state: "started" });
  const generated = await triggerMemoryGeneration(
    { ...input, history },
    { jobId: job.id, leaseToken: job.leaseToken },
    signal,
  );
  signal?.throwIfAborted();
  const value = (() => {
    try {
      return validateMemoryGeneration({
        input: { ...input, history },
        value: memoryGenerationSchema.parse(generated.value),
      });
    } catch (error) {
      throw rejectMemoryValidation(error, "api");
    }
  })();
  const result = { value, history, model: generated.model };
  const latest = await memoryReadContext(job);
  if (!latest.sources.some((s) => s.id === source.id && s.revision === source.revision)) {
    throw new Error(MEMORY_SOURCE_CHANGED_MESSAGE);
  }
  signal?.throwIfAborted();
  await repositories().persistMemoryExtraction({
    job,
    source,
    candidates: result.value.memories,
    model: result.model,
    generation: {
      value: result.value,
      history: result.history,
      sourceIds: latest.sourceIds,
      inputSources,
      language: preferences.language,
    },
  });
}
