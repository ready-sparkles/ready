import { memoryCategoryFilterValues, type RelationshipMemory, type UnifiedAssignedTask } from "@readymeet/shared";
import { z } from "zod";

import { ApiError } from "../api-error";

import { type WorkspaceDemoDataset } from "./demo-dataset";

const LINT_NUM_N404 = 404;
export const LINT_NUM_N1000 = 1000;
export const LINT_NUM_N12_000 = 12_000;
export const LINT_NUM_N7 = 7;
export const LINT_NUM_N3 = 3;
export const LINT_NUM_N10 = 10;
export const LINT_NUM_N100 = 100;
export const LINT_NUM_N2 = 2;
export const LINT_NUM_N4 = 4;
export const LINT_NUM_N8 = 8;
export const LINT_NUM_N6 = 6;
export const LINT_NUM_N2000 = 2000;
export const LINT_NUM_N340 = 340;
export const LINT_NUM_N1660 = 1660;
export const LINT_NUM_N18 = 18;
export const LINT_NUM_N86_400_000 = 86_400_000;

export const PAGE_SIZE = 50;
export type Filters = Record<string, string>;
export type Handler = (input: {
  match: RegExpMatchArray;
  context: { body: Record<string, unknown>; query: URLSearchParams };
}) => unknown;

const DEMO_NOT_AVAILABLE_MESSAGE = "This isn’t available in the demo.";
export const DEMO_TASK_NO_LONGER_AVAILABLE_MESSAGE = "This task is no longer available.";
export const DEMO_PERSON_NOT_FOUND_MESSAGE = "Person not found";
export const DEMO_MEMORY_NOT_FOUND_MESSAGE = "Memory not found";
export const DEMO_MEETING_NOT_FOUND_MESSAGE = "Meeting not found";
export const DEMO_MEETING_PREP_NOT_FOUND_MESSAGE = "Meeting prep not found";

function isDemoRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readDemoFilters(value: unknown): Filters {
  if (!isDemoRecord(value)) {
    return {};
  }

  return Object.entries(value).reduce<Filters>((filters, [key, entry]) => {
    if (typeof entry === "string") {
      return { ...filters, [key]: entry };
    }

    return filters;
  }, {});
}

export function readOptionalString(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }

  return typeof value === "string" ? value : undefined;
}

export function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

export function readTaskStatus(input: {
  value: unknown;
  fallback: UnifiedAssignedTask["status"];
}): UnifiedAssignedTask["status"] {
  if (input.value === "open" || input.value === "completed" || input.value === "dismissed") {
    return input.value;
  }

  return input.fallback;
}

const demoRequestBodySchema = z.record(z.string(), z.unknown());

export function readDemoRequestBody(raw: BodyInit | null | undefined): Record<string, unknown> {
  if (typeof raw !== "string" || raw === "") {
    return {};
  }
  try {
    const parsed = demoRequestBodySchema.safeParse(JSON.parse(raw));

    return parsed.success ? parsed.data : {};
  } catch (error) {
    if (error instanceof SyntaxError) {
      return {};
    }

    throw error;
  }
}

export function notAvailable(message: string = DEMO_NOT_AVAILABLE_MESSAGE): ApiError {
  return new ApiError({ status: LINT_NUM_N404, responseText: JSON.stringify({ message }) });
}

export function capture(match: RegExpMatchArray): string {
  const value = match[1];
  if (value === undefined) {
    throw notAvailable();
  }

  return value;
}

export function secondCapture(match: RegExpMatchArray): string {
  const value = match[LINT_NUM_N2];
  if (value === undefined) {
    throw notAvailable();
  }

  return value;
}

export function notesToSummary(notes: { heading: string; bullets: string[] }[]): string {
  return notes.map((note) => [note.heading, ...note.bullets.map((bullet) => `- ${bullet}`)].join("\n")).join("\n\n");
}

export type WorkspaceDemoRequestHandler = (input: { path: string; options: RequestInit }) => Promise<unknown>;

export function workspaceDemoOrigin(): string {
  return typeof window === "undefined" ? "https://ready.app" : window.location.origin;
}

export function workspaceDemoAbsoluteUrl(input: { origin: string; path: string | null | undefined }): string | null {
  const { origin, path } = input;

  return path !== null && path !== undefined && path !== "" ? `${origin}${path}` : null;
}

type WorkspaceDemoSession = {
  memories: WorkspaceDemoDataset["memories"];
  tasks: WorkspaceDemoDataset["tasks"];
  memoryVersion: number;
  searchIndex: Map<string, string> | null;
  forgotten: { id: string; version: number }[];
  recentMeetings: WorkspaceDemoDataset["meetings"];
};

export type WorkspaceDemoRuntime = {
  dataset: WorkspaceDemoDataset;
  user: WorkspaceDemoDataset["user"];
  workspaceId: string;
  session: WorkspaceDemoSession;
  memoryPreferences: {
    /** @external demo memory preference wire field */
    includeSensitive: boolean;
    language: string;
  };
};

export function demoMemoryMatchesPersonFilter(input: { memory: RelationshipMemory; filters: Filters }): boolean {
  const { memory, filters } = input;
  if (filters.personId === undefined || filters.personId === "") {
    return true;
  }
  const isInverted = filters.personOperator === "is_not";

  return memory.personIds.includes(filters.personId) !== isInverted;
}

export function demoMemoryMatchesCategoryFilter(input: { memory: RelationshipMemory; filters: Filters }): boolean {
  const { memory, filters } = input;
  if (filters.category === undefined || filters.category === "") {
    return true;
  }
  const isInverted = filters.categoryOperator === "is_not";

  return memoryCategoryFilterValues(filters.category).includes(memory.category) !== isInverted;
}

export function demoMemoryMatchesDateFilter(input: { memory: RelationshipMemory; filters: Filters }): boolean {
  const { memory, filters } = input;
  const { from, to } = filters;
  const hasFromFilter = from !== undefined && from !== "";
  const hasToFilter = to !== undefined && to !== "";
  if (!hasFromFilter && !hasToFilter) {
    return true;
  }
  const isInverted = filters.dateOperator === "is_not";
  const time = Date.parse(memory.occurredAt);
  const isInRange = (!hasFromFilter || time >= Date.parse(from)) && (!hasToFilter || time < Date.parse(to));

  return isInRange !== isInverted;
}

export function demoMemoryMatchesQueryFilter(input: {
  memory: RelationshipMemory;
  filters: Filters;
  searchText: (memory: RelationshipMemory) => string;
}): boolean {
  const { memory, filters, searchText } = input;
  if (filters.q === undefined || filters.q === "") {
    return true;
  }
  const text = searchText(memory);
  const queryWords = filters.q
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");

  return queryWords.every((word) => text.includes(word));
}

export function demoTaskOwnerFromAssignee(input: {
  runtime: WorkspaceDemoRuntime;
  assigneeUserId: string | null | undefined;
  current: UnifiedAssignedTask;
}): {
  isMine: boolean;
  owner: UnifiedAssignedTask["owner"];
} {
  const { runtime, assigneeUserId, current } = input;
  if (assigneeUserId === undefined) {
    return { isMine: current.isMine, owner: current.owner };
  }
  if (assigneeUserId === null || assigneeUserId === "") {
    return { isMine: false, owner: null };
  }
  const member = runtime.dataset.members.find((item) => item.userId === assigneeUserId);
  const isMine = assigneeUserId === runtime.user.id;

  return {
    isMine,
    owner:
      isMine || !member
        ? null
        : { userId: member.userId, displayName: member.displayName, avatarUrl: member.avatarUrl },
  };
}
