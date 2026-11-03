import type { RepositoryPort } from "@readymeet/db/ports/repository";
import { z } from "zod";

import { decryptJsonSecret } from "../../../ports/gate-secret-crypto";
import { repositories } from "../../../ports/repository-runtime";

import { type AshbyCandidate, type AshbyClient, createAshbyClient } from "./ashby-client";

export type AshbyKeySecret = { apiKey: string };
export type ProfileLink = { label: string; url: string };

const ASHBY_PROFILE_LABEL = "Ashby";
const LOOKUP_CACHE_HOURS = 24;
const LOOKUP_CACHE_MINUTES_PER_HOUR = 60;
const LOOKUP_CACHE_SECONDS_PER_MINUTE = 60;
const LOOKUP_CACHE_MS_PER_SECOND = 1000;
/** Candidate emails rarely change; re-check a day later so new candidates appear. */
const LOOKUP_CACHE_MS =
  LOOKUP_CACHE_HOURS * LOOKUP_CACHE_MINUTES_PER_HOUR * LOOKUP_CACHE_SECONDS_PER_MINUTE * LOOKUP_CACHE_MS_PER_SECOND;
/** A person page never waits long on Ashby; a slow lookup just omits the pill. */
const LOOKUP_DEADLINE_MS = 4_000;
const SINGLE_CANDIDATE_MATCH_COUNT = 1;

function candidateEmails(candidate: AshbyCandidate): string[] {
  return [candidate.primaryEmailAddress, ...(candidate.emailAddresses ?? [])]
    .flatMap((address) => (address === null || address === undefined ? [] : [address.value.trim().toLowerCase()]))
    .filter((value) => value.length > 0);
}

function isAshbyHost(hostname: string): boolean {
  return hostname === "ashbyhq.com" || hostname.endsWith(".ashbyhq.com");
}

/** Only Ashby's own candidate pages may become links in Ready. */
export function safeAshbyProfileUrl(candidate: AshbyCandidate): string {
  const fallback = `https://app.ashbyhq.com/candidates/${encodeURIComponent(candidate.id)}`;
  if (candidate.profileUrl === undefined || candidate.profileUrl === null || candidate.profileUrl === "") {
    return fallback;
  }
  try {
    const url = new URL(candidate.profileUrl);

    return url.protocol === "https:" && isAshbyHost(url.hostname) ? url.toString() : fallback;
  } catch (error) {
    if (error instanceof Error) {
      return fallback;
    }

    return fallback;
  }
}

type AshbyProfileLinksDependencies = {
  createClient?: (input: { apiKey: string; signal: AbortSignal }) => AshbyClient;
};

/** Returns null when Ashby could not answer, so the miss is never cached. */
async function searchAshbyCandidates(input: {
  integration: NonNullable<Awaited<ReturnType<RepositoryPort["getWorkspaceAshbyIntegration"]>>>;
  email: string;
  createClient?: AshbyProfileLinksDependencies["createClient"];
}): Promise<AshbyCandidate[] | null> {
  const { integration } = input;
  const secret = decryptJsonSecret(integration.secretRef);
  try {
    const { apiKey } = z.object({ apiKey: z.string() }).parse(secret);
    const signal = AbortSignal.timeout(LOOKUP_DEADLINE_MS);
    const client = (
      input.createClient ??
      ((params: { apiKey: string; signal: AbortSignal }) => createAshbyClient(params.apiKey, { signal: params.signal }))
    )({
      apiKey,
      signal,
    });

    return await client.searchCandidates({ email: input.email });
  } catch (error) {
    if (error instanceof Error) {
      // Ashby being slow or down never breaks the person page; nothing is cached.
      return null;
    }

    return null;
  }
}

/**
 * The Ashby pill for a memory person page: shown only to members who turned
 * Ashby on, and only when exactly one Ashby candidate uses the person's email.
 */
function profileLinksFromUrl(profileUrl: string | null): ProfileLink[] {
  return profileUrl !== null && profileUrl !== "" ? [{ label: ASHBY_PROFILE_LABEL, url: profileUrl }] : [];
}

export async function ashbyProfileLinksForPerson(input: {
  workspaceId: string;
  userId: string;
  email: string | null | undefined;
  dependencies?: AshbyProfileLinksDependencies;
}): Promise<ProfileLink[]> {
  const email = input.email?.trim().toLowerCase() ?? "";
  if (email.length === 0 || !email.includes("@")) {
    return [];
  }
  if (!(await repositories().isAshbyMemberConnected({ workspaceId: input.workspaceId, userId: input.userId }))) {
    return [];
  }
  const integration = await repositories().getWorkspaceAshbyIntegration(input.workspaceId);
  if (integration === null) {
    return [];
  }

  const cached = await repositories().getCachedAshbyCandidateLookup({
    workspaceId: input.workspaceId,
    email,
    maxAgeMs: LOOKUP_CACHE_MS,
  });
  if (cached !== null) {
    return profileLinksFromUrl(cached.profileUrl);
  }

  const candidates = await searchAshbyCandidates({
    integration,
    email,
    createClient: input.dependencies?.createClient,
  });
  if (candidates === null) {
    return [];
  }
  const matches = candidates.filter((candidate) => candidateEmails(candidate).includes(email));
  const match = matches.length === SINGLE_CANDIDATE_MATCH_COUNT ? (matches.at(0) ?? null) : null;
  const profileUrl = match !== null ? safeAshbyProfileUrl(match) : null;
  await repositories().saveAshbyCandidateLookup({
    workspaceId: input.workspaceId,
    email,
    candidateId: match?.id ?? null,
    profileUrl,
  });

  return profileLinksFromUrl(profileUrl);
}
