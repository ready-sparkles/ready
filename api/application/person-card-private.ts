import type { MemoryScope } from "@readymeet/db/ports/repository";
import type { AmbientContextPrivateDetails, MemoryPerson } from "@readymeet/shared";
import { z } from "zod";

import { bindPortFunction } from "../ports/bind-port";
import {
  type AshbyApplication,
  type AshbyCandidate,
  type AshbyClient,
  createAshbyClient,
} from "../ports/gate-ashby-client";
import { safeAshbyProfileUrl } from "../ports/gate-ashby-profile-links";
import { decryptJsonSecret } from "../ports/gate-secret-crypto";
import { repositories } from "../ports/repository-runtime";

import { allActiveMemories, memoryReadContext } from "./relationship-memory";

type MemorySection = NonNullable<AmbientContextPrivateDetails["memory"]>;
type AshbySection = NonNullable<AmbientContextPrivateDetails["ashby"]>;
type Logger = {
  warn(...args: [bindings: Record<string, unknown>, message: string]): void;
};

const MAX_SUMMARY_SENTENCES = 3;
const MAX_STANDING = 3;
const MAX_APPLICATIONS_CHECKED = 5;
const MAX_HIRING_TEAM = 3;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1000;
const ASHBY_CACHE_MINUTES = 10;
/** A card never waits long on Ashby; a slow lookup just leaves the section out. */
const ASHBY_DEADLINE_MS = 5_000;
/** Mentions repeat during a call; reuse a workspace's Ashby answer for a while. */
const ASHBY_CACHE_MS = ASHBY_CACHE_MINUTES * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;

const ashbyKeySecretSchema = z.object({ apiKey: z.string() });

function normalizePersonName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * The viewer's memory person for a mentioned name: an exact full-name match,
 * or for a first name alone, the only person with that first name. Anything
 * ambiguous matches nobody, so a card never shows the wrong person's memory.
 */
function matchMemoryPerson(...args: [people: MemoryPerson[], displayName: string]): MemoryPerson | null {
  const [people, displayName] = args;

  return matchMemoryPersonNamed({ people, displayName });
}

function matchMemoryPersonNamed(input: { people: MemoryPerson[]; displayName: string }): MemoryPerson | null {
  const wanted = normalizePersonName(input.displayName);
  if (wanted === "") {
    return null;
  }
  const exact = input.people.filter((person) => normalizePersonName(person.name) === wanted);
  const [exactMatch] = exact;
  if (exact.length === 1 && exactMatch !== undefined) {
    return exactMatch;
  }
  if (exact.length > 1 || wanted.includes(" ")) {
    return null;
  }
  const byFirstName = input.people.filter((person) => normalizePersonName(person.name).split(" ")[0] === wanted);
  const [firstNameMatch] = byFirstName;

  return byFirstName.length === 1 && firstNameMatch !== undefined ? firstNameMatch : null;
}

const memoryDependencies = {
  memoryReadContext,
  listMemoryPeople: bindPortFunction(() => repositories().listMemoryPeople),
  readMemoryProjection: bindPortFunction(() => repositories().readMemoryProjection),
  allActiveMemories,
};

export async function memorySectionFor(
  ...args: [scope: MemoryScope, displayName: string, dependencies?: Partial<typeof memoryDependencies>]
): Promise<MemorySection | null> {
  const [scope, displayName] = args;

  return memorySectionForNamed({ scope, displayName, dependencies: args[2] ?? {} });
}

async function memoryStandingFor(input: {
  memory: typeof memoryDependencies;
  sourceIds: string[];
  personId: string;
  summary: string[];
  projectedStanding: string[];
}): Promise<string[]> {
  if (input.summary.length === 0 && input.projectedStanding.length === 0) {
    return (await input.memory.allActiveMemories(input.sourceIds, input.personId))
      .slice(0, MAX_STANDING)
      .map((item) => item.title);
  }

  return input.projectedStanding;
}

function memorySectionPayload(input: { person: MemoryPerson; summary: string[]; standing: string[] }): MemorySection {
  return {
    personId: input.person.id,
    name: input.person.name,
    summary: input.summary,
    standing: input.standing,
    lastContact: input.person.lastContact,
    ...(typeof input.person.imageUrl === "string" && input.person.imageUrl !== ""
      ? { imageUrl: input.person.imageUrl }
      : {}),
    ...(typeof input.person.email === "string" && input.person.email !== "" ? { email: input.person.email } : {}),
  };
}

async function memorySectionForNamed(input: {
  scope: MemoryScope;
  displayName: string;
  dependencies: Partial<typeof memoryDependencies>;
}): Promise<MemorySection | null> {
  const memory = { ...memoryDependencies, ...input.dependencies };
  const context = await memory.memoryReadContext(input.scope);
  if (context.sourceIds.length === 0) {
    return null;
  }
  const person = matchMemoryPerson(
    await memory.listMemoryPeople({ scope: input.scope, sourceIds: context.sourceIds }),
    input.displayName,
  );
  if (!person) {
    return null;
  }
  const projection = await memory.readMemoryProjection({ personId: person.id, sourceIds: context.sourceIds });
  const summary = projection?.summary.map((sentence) => sentence.text).slice(0, MAX_SUMMARY_SENTENCES) ?? [];
  const projectedStanding = projection?.standing.map((item) => item.text).slice(0, MAX_STANDING) ?? [];
  const standing = await memoryStandingFor({
    memory,
    sourceIds: context.sourceIds,
    personId: person.id,
    summary,
    projectedStanding,
  });
  if (summary.length === 0 && standing.length === 0) {
    return null;
  }

  return memorySectionPayload({ person, summary, standing });
}

function formatDate(value: string | null | undefined) {
  const time = Date.parse(value ?? "");

  return Number.isFinite(time)
    ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(
        time,
      )
    : null;
}

function ashbyRoleApplicationFact(input: { job?: string; stage?: string }) {
  const job = input.job ?? "";
  const stage = input.stage ?? "";
  if (job !== "") {
    return stage !== "" ? `Applied for ${job} · ${stage}` : `Applied for ${job}`;
  }
  if (stage !== "") {
    return `Stage: ${stage}`;
  }

  return null;
}

function ashbyStatusFact(application: AshbyApplication) {
  const status = application.status?.trim() ?? "";
  if (status === "Archived") {
    const reason = application.archiveReason?.text?.trim() ?? "";

    return reason !== "" ? `Archived · ${reason}` : "Archived";
  }
  if (status !== "") {
    return `Status: ${status}`;
  }

  return null;
}

function ashbyHiringTeamFact(application: AshbyApplication) {
  const team = (application.hiringTeam ?? [])
    .map((member) => {
      const name = [member.firstName, member.lastName]
        .filter((part) => part !== null && part !== undefined && part !== "")
        .join(" ")
        .trim();
      if (name === "") {
        return null;
      }
      const role = member.role ?? "";

      return role !== "" ? `${name} (${role})` : name;
    })
    .filter((member): member is string => member !== null)
    .slice(0, MAX_HIRING_TEAM);
  if (team.length === 0) {
    return null;
  }

  return `Hiring team: ${team.join(", ")}`;
}

/** Application facts only. Notes and scorecards are never shown on a meeting card. */
function ashbyApplicationFacts(application: AshbyApplication | null): string[] {
  if (application === null) {
    return ["No applications in Ashby yet"];
  }
  const source = application.source?.title?.trim() ?? "";
  const updated = formatDate(application.updatedAt ?? application.createdAt);
  const facts = [
    ashbyRoleApplicationFact({
      job: application.job?.title?.trim(),
      stage: application.currentInterviewStage?.title?.trim(),
    }),
    ashbyStatusFact(application),
    source !== "" ? `Source: ${source}` : null,
    ashbyHiringTeamFact(application),
    updated !== null && updated !== "" ? `Last updated ${updated}` : null,
  ].filter((fact): fact is string => fact !== null);

  return facts.length !== 0 ? facts : ["No application details in Ashby"];
}

const ashbyCache = new Map<string, { expiresAt: number; section: AshbySection | null }>();

async function ashbySectionForCandidate({
  candidate,
  client,
}: {
  candidate: AshbyCandidate;
  client: AshbyClient;
}): Promise<AshbySection> {
  const applications = (
    await Promise.all(
      (candidate.applicationIds ?? []).slice(0, MAX_APPLICATIONS_CHECKED).map((id) => client.application(id)),
    )
  )
    .filter((application): application is AshbyApplication => Boolean(application))
    .sort(
      (left, right) =>
        Date.parse(right.updatedAt ?? right.createdAt ?? "") - Date.parse(left.updatedAt ?? left.createdAt ?? ""),
    );
  const latest = applications[0] ?? null;

  return {
    candidateName: candidate.name,
    profileUrl: safeAshbyProfileUrl(candidate),
    facts: ashbyApplicationFacts(latest),
  };
}

type AshbySectionDependencies = {
  createClient?: (input: { apiKey: string; signal: AbortSignal }) => AshbyClient;
  now?: () => number;
};

async function ashbySectionFor(
  ...args: [
    input: { workspaceId: string; userId: string; displayName: string },
    dependencies?: AshbySectionDependencies,
  ]
): Promise<AshbySection | null> {
  const [input, dependencies = {}] = args;

  return ashbySectionForNamed({ input, dependencies });
}

async function ashbySectionForNamed(input: {
  input: { workspaceId: string; userId: string; displayName: string };
  dependencies: AshbySectionDependencies;
}): Promise<AshbySection | null> {
  const wanted = normalizePersonName(input.input.displayName);
  // A first name alone is too ambiguous to look up in a whole Ashby account.
  if (!wanted.includes(" ")) {
    return null;
  }
  if (
    !(await repositories().isAshbyMemberConnected({ workspaceId: input.input.workspaceId, userId: input.input.userId }))
  ) {
    return null;
  }
  const integration = await repositories().getWorkspaceAshbyIntegration(input.input.workspaceId);
  if (!integration) {
    return null;
  }

  const now = input.dependencies.now?.() ?? Date.now();
  const cacheKey = `${input.input.workspaceId}:${integration.updatedAt}:${wanted}`;
  const cached = ashbyCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.section;
  }

  const secret = decryptJsonSecret(integration.secretRef);
  const { apiKey } = ashbyKeySecretSchema.parse(secret);
  const signal = AbortSignal.timeout(ASHBY_DEADLINE_MS);
  const defaultCreateClient = (clientInput: { apiKey: string; signal: AbortSignal }) =>
    createAshbyClient(clientInput.apiKey, { signal: clientInput.signal });
  const createClient = input.dependencies.createClient ?? defaultCreateClient;
  const client = createClient({ apiKey, signal });
  const matches = (await client.searchCandidates({ name: input.input.displayName })).filter(
    (candidate: AshbyCandidate) => normalizePersonName(candidate.name) === wanted,
  );
  const [candidate] = matches;
  const section =
    matches.length === 1 && candidate !== undefined ? await ashbySectionForCandidate({ candidate, client }) : null;
  ashbyCache.set(cacheKey, { expiresAt: now + ASHBY_CACHE_MS, section });

  return section;
}

async function loadPrivateSection<T>({
  load,
  warn,
}: {
  load: () => Promise<T | null>;
  warn: (error: unknown) => void;
}): Promise<T | null> {
  try {
    return await load();
  } catch (error) {
    warn(error);

    return null;
  }
}

/**
 * The private sections of a person card for one viewer. Each section fails
 * on its own: a memory or Ashby problem never hides the other.
 */
export async function personCardPrivateDetails(
  ...args: [
    input: { userId: string; workspaceId: string; displayName: string; logger: Logger },
    dependencies?: AshbySectionDependencies,
  ]
): Promise<AmbientContextPrivateDetails> {
  const [input, dependencies = {}] = args;

  return personCardPrivateDetailsNamed({ input, dependencies });
}

async function personCardPrivateDetailsNamed(input: {
  input: { userId: string; workspaceId: string; displayName: string; logger: Logger };
  dependencies: AshbySectionDependencies;
}): Promise<AmbientContextPrivateDetails> {
  const scope = { userId: input.input.userId, workspaceId: input.input.workspaceId };
  const [memory, ashby] = await Promise.all([
    loadPrivateSection({
      load: () => memorySectionFor(scope, input.input.displayName),
      warn: (error) => input.input.logger.warn({ err: error }, "Person card memory lookup failed"),
    }),
    loadPrivateSection({
      load: () => ashbySectionFor({ ...scope, displayName: input.input.displayName }, input.dependencies),
      warn: (error) => input.input.logger.warn({ err: error }, "Person card Ashby lookup failed"),
    }),
  ]);

  return { memory, ashby };
}
