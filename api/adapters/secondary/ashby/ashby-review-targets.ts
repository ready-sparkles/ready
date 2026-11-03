import type { AshbyProposal, AshbyReviewItem } from "@readymeet/shared";
import { randomUUID } from "node:crypto";

import { AshbyApiError, type AshbyApplication, type AshbyCandidate, type AshbyClient } from "./ashby-client";

const MAX_ASHBY_CANDIDATES_FOR_AUTO_MATCH = 100;

const MESSAGE_ASHBY_ENABLE_CANDIDATES_WRITE =
  "Ask a workspace admin to enable candidatesWrite for stage changes, and interviewsRead for pipeline stages on the Ashby API key.";
const MESSAGE_ASHBY_RECONNECT = "Ask a workspace admin to reconnect Ashby.";
const MESSAGE_ASHBY_REQUEST_INCOMPLETE = "Ashby could not complete this request. Your draft is saved.";
const MESSAGE_ASHBY_COULD_NOT_PREPARE = "Could not prepare the Ashby review.";
const MESSAGE_ASHBY_NO_INTERVIEW_PLAN = "The application has no available interview plan. Choose another application.";
const MESSAGE_ASHBY_CHOOSE_CANDIDATE = "Choose the candidate in Ashby, or use Tell differently to change the name.";
const MESSAGE_ASHBY_CHOOSE_APPLICATION = "Choose the application to update.";
const MESSAGE_ASHBY_CHOOSE_STAGE = "Choose an interview stage from this application’s pipeline.";
const MESSAGE_ASHBY_RESOLVE_TARGET_BEFORE_CONFIRM = "Choose a candidate and resolve the target before confirming.";
const MESSAGE_ASHBY_CANDIDATE_UNAVAILABLE = "This candidate is no longer available. Revise the review.";
const MESSAGE_ASHBY_APPLICATION_NOT_OWNED = "The application no longer belongs to this candidate. Revise the review.";
const MESSAGE_ASHBY_APPLICATION_INACTIVE = "This application is no longer active. Revise the review.";
const MESSAGE_ASHBY_APPLICATION_STAGE_CHANGED =
  "The application stage changed in Ashby. Choose the target again before confirming.";
const MESSAGE_ASHBY_STAGE_UNAVAILABLE = "This stage is no longer available. Choose the target again.";

const DEFAULT_APPLICATION_LABEL = "Application";

type AshbyReviewSelection = {
  candidateId: string | null;
  applicationId: string | null;
  stageId: string | null;
};

type AshbyReviewStage = { id: string; name: string };

type AshbyResolvedReviewFields = Pick<
  AshbyReviewItem,
  | "candidates"
  | "candidateId"
  | "candidateName"
  | "applications"
  | "applicationId"
  | "stages"
  | "stageId"
  | "currentStageId"
  | "currentStageName"
  | "error"
>;

function ashbyNameKey(name: string): string {
  return name.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

export function ashbyReviewError(error: unknown): string {
  if (error instanceof AshbyApiError) {
    if (error.kind === "missing_permission") {
      return MESSAGE_ASHBY_ENABLE_CANDIDATES_WRITE;
    }
    if (error.kind === "invalid_key") {
      return MESSAGE_ASHBY_RECONNECT;
    }

    return MESSAGE_ASHBY_REQUEST_INCOMPLETE;
  }

  return error instanceof Error && !(error instanceof SyntaxError) ? error.message : MESSAGE_ASHBY_COULD_NOT_PREPARE;
}

export function isReviewStage(stage: { type: string; title: string }): boolean {
  return (
    ["Active", "PreInterviewScreen"].includes(stage.type) && !/\b(hired|rejected|archived|offer)\b/i.test(stage.title)
  );
}

async function listReviewStagesForApplication(input: {
  client: AshbyClient;
  application: AshbyApplication;
}): Promise<AshbyReviewStage[]> {
  const interviewPlanId = input.application.currentInterviewStage?.interviewPlanId;
  if (interviewPlanId === undefined || interviewPlanId === "") {
    throw new Error(MESSAGE_ASHBY_NO_INTERVIEW_PLAN);
  }
  const response = await input.client.call<{ id: string; title: string; type: string; interviewPlanId: string }[]>(
    "interviewStage.list",
    { interviewPlanId },
  );

  return (response.results ?? [])
    .filter((s) => s.interviewPlanId === interviewPlanId && isReviewStage(s))
    .map((s) => ({ id: s.id, name: s.title }));
}

export function readyAshbyItem(item: AshbyReviewItem): boolean {
  return (
    item.candidateId !== null && item.applicationId !== null && item.stageId !== null && item.currentStageId !== null
  );
}

function createPendingReviewItem(input: { proposal: AshbyProposal; previous?: AshbyReviewItem }): AshbyReviewItem {
  return {
    id: input.previous?.id ?? randomUUID(),
    proposal: input.proposal,
    candidates: [],
    candidateId: null,
    candidateName: null,
    applications: [],
    applicationId: null,
    stages: [],
    stageId: null,
    currentStageId: null,
    currentStageName: null,
    /** @external ashby review item included wire field */
    included: true,
    status: "pending",
    error: null,
  };
}

function filterExactAshbyCandidates(input: {
  candidates: AshbyCandidate[];
  proposal: AshbyProposal;
}): AshbyCandidate[] {
  const candidateEmail = input.proposal.candidateEmail;

  return input.candidates.filter((c) => {
    if (candidateEmail === null) {
      return (
        input.proposal.candidateName.trim().includes(" ") &&
        ashbyNameKey(c.name) === ashbyNameKey(input.proposal.candidateName)
      );
    }

    return (
      ashbyNameKey(c.name) === ashbyNameKey(input.proposal.candidateName) &&
      [c.primaryEmailAddress, ...(c.emailAddresses ?? [])].some(
        (e) => e?.value.toLowerCase() === candidateEmail.toLowerCase(),
      )
    );
  });
}

function selectAshbyCandidate(input: {
  candidates: AshbyCandidate[];
  exact: AshbyCandidate[];
  selection?: AshbyReviewSelection;
}): AshbyCandidate | null {
  const { selection } = input;
  if (selection) {
    return input.candidates.find((c) => c.id === selection.candidateId) ?? null;
  }
  if (input.exact.length === 1 && input.candidates.length < MAX_ASHBY_CANDIDATES_FOR_AUTO_MATCH) {
    return input.exact[0] ?? null;
  }

  return null;
}

async function loadActiveAshbyApplications(input: {
  client: AshbyClient;
  candidate: AshbyCandidate;
}): Promise<AshbyApplication[]> {
  return (input.candidate.applicationIds ?? []).reduce<Promise<AshbyApplication[]>>(async (previous, id) => {
    const collected = await previous;
    const application = await input.client.application(id);
    if (application?.candidate?.id === input.candidate.id && ["Active", "Lead"].includes(application.status ?? "")) {
      return [...collected, application];
    }

    return collected;
  }, Promise.resolve([]));
}

function selectAshbyApplication(input: {
  applications: AshbyApplication[];
  proposal: AshbyProposal;
  selection?: AshbyReviewSelection;
}): AshbyApplication | null {
  const jobTitle = input.proposal.jobTitle;
  const matching =
    jobTitle !== null && jobTitle !== ""
      ? input.applications.filter((a) => ashbyNameKey(a.job?.title ?? "") === ashbyNameKey(jobTitle))
      : input.applications;
  const { selection } = input;
  if (selection) {
    return input.applications.find((a) => a.id === selection.applicationId) ?? null;
  }
  if (matching.length === 1) {
    return matching[0] ?? null;
  }

  return null;
}

async function buildAshbyStageFields(input: {
  client: AshbyClient;
  proposal: AshbyProposal;
  application: AshbyApplication;
  selection?: AshbyReviewSelection;
}): Promise<Pick<AshbyResolvedReviewFields, "stages" | "stageId" | "currentStageId" | "currentStageName" | "error">> {
  const stages = await listReviewStagesForApplication({ client: input.client, application: input.application });
  const matches = stages.filter((s) => ashbyNameKey(s.name) === ashbyNameKey(input.proposal.stageName));
  const { selection } = input;
  const stage = selection ? stages.find((s) => s.id === selection.stageId) : matches.length === 1 ? matches[0] : null;

  return {
    stages,
    currentStageId: input.application.currentInterviewStage?.id ?? null,
    currentStageName: input.application.currentInterviewStage?.title ?? null,
    stageId: stage?.id ?? null,
    error: stage === null || stage === undefined ? MESSAGE_ASHBY_CHOOSE_STAGE : null,
  };
}

async function computeResolvedAshbyFields(input: {
  client: AshbyClient;
  proposal: AshbyProposal;
  selection?: AshbyReviewSelection;
}): Promise<AshbyResolvedReviewFields> {
  const emptyFields: AshbyResolvedReviewFields = {
    candidates: [],
    candidateId: null,
    candidateName: null,
    applications: [],
    applicationId: null,
    stages: [],
    stageId: null,
    currentStageId: null,
    currentStageName: null,
    error: null,
  };
  const searchInput =
    input.proposal.candidateEmail !== null
      ? { email: input.proposal.candidateEmail }
      : { name: input.proposal.candidateName };
  const candidates = await input.client.searchCandidates(searchInput);
  const candidateOptions = candidates.map((c) => ({
    id: c.id,
    name: c.name,
    email: c.primaryEmailAddress?.value ?? null,
  }));
  const exact = filterExactAshbyCandidates({ candidates, proposal: input.proposal });
  const candidate = selectAshbyCandidate({ candidates, exact, selection: input.selection });
  if (candidate === null) {
    return { ...emptyFields, candidates: candidateOptions, error: MESSAGE_ASHBY_CHOOSE_CANDIDATE };
  }
  const applications = await loadActiveAshbyApplications({ client: input.client, candidate });
  const applicationOptions = applications.map((a) => ({
    id: a.id,
    name: a.job?.title ?? DEFAULT_APPLICATION_LABEL,
  }));
  const application = selectAshbyApplication({
    applications,
    proposal: input.proposal,
    selection: input.selection,
  });
  if (application === null) {
    return {
      ...emptyFields,
      candidates: candidateOptions,
      candidateId: candidate.id,
      candidateName: candidate.name,
      applications: applicationOptions,
      error: MESSAGE_ASHBY_CHOOSE_APPLICATION,
    };
  }
  const stageFields = await buildAshbyStageFields({
    client: input.client,
    proposal: input.proposal,
    application,
    selection: input.selection,
  });

  return {
    candidates: candidateOptions,
    candidateId: candidate.id,
    candidateName: candidate.name,
    applications: applicationOptions,
    applicationId: application.id,
    ...stageFields,
  };
}

export async function resolveAshbyItem(
  ...args: [client: AshbyClient, proposal: AshbyProposal, selection?: AshbyReviewSelection, previous?: AshbyReviewItem]
): Promise<AshbyReviewItem> {
  const [client, proposal, selection, previous] = args;
  const item = createPendingReviewItem({ proposal, previous });
  try {
    const resolved = await computeResolvedAshbyFields({ client, proposal, selection });
    item.candidates = resolved.candidates;
    item.candidateId = resolved.candidateId;
    item.candidateName = resolved.candidateName;
    item.applications = resolved.applications;
    item.applicationId = resolved.applicationId;
    item.stages = resolved.stages;
    item.stageId = resolved.stageId;
    item.currentStageId = resolved.currentStageId;
    item.currentStageName = resolved.currentStageName;
    item.error = resolved.error;
  } catch (error) {
    item.error = ashbyReviewError(error);
  }

  return item;
}

async function assertAshbyCandidateForWrite(input: {
  client: AshbyClient;
  item: AshbyReviewItem;
  applicationId: string;
}): Promise<void> {
  const candidate = (await input.client.call<AshbyCandidate>("candidate.info", { candidateId: input.item.candidateId }))
    .results;
  if (candidate?.id !== input.item.candidateId) {
    throw new Error(MESSAGE_ASHBY_CANDIDATE_UNAVAILABLE);
  }
  if (!(candidate.applicationIds?.includes(input.applicationId) ?? false)) {
    throw new Error(MESSAGE_ASHBY_APPLICATION_NOT_OWNED);
  }
}

async function assertActiveAshbyApplicationForWrite(input: {
  client: AshbyClient;
  item: AshbyReviewItem;
  applicationId: string;
}): Promise<AshbyApplication> {
  const application = await input.client.application(input.applicationId);
  if (
    !application ||
    application.candidate?.id !== input.item.candidateId ||
    !["Active", "Lead"].includes(application.status ?? "")
  ) {
    throw new Error(MESSAGE_ASHBY_APPLICATION_INACTIVE);
  }

  return application;
}

async function assertAshbyStageStillAvailable(input: {
  client: AshbyClient;
  application: AshbyApplication;
  stageId: string | null;
}): Promise<void> {
  const stages = await listReviewStagesForApplication({ client: input.client, application: input.application });
  if (!stages.some((s) => s.id === input.stageId)) {
    throw new Error(MESSAGE_ASHBY_STAGE_UNAVAILABLE);
  }
}

export async function validateAshbyWriteTarget(...args: [client: AshbyClient, item: AshbyReviewItem]): Promise<void> {
  const [client, item] = args;
  const applicationId = item.applicationId;
  if (!readyAshbyItem(item) || applicationId === null) {
    throw new Error(MESSAGE_ASHBY_RESOLVE_TARGET_BEFORE_CONFIRM);
  }
  await assertAshbyCandidateForWrite({ client, item, applicationId });
  const application = await assertActiveAshbyApplicationForWrite({ client, item, applicationId });
  if (application.currentInterviewStage?.id !== item.currentStageId) {
    throw new Error(MESSAGE_ASHBY_APPLICATION_STAGE_CHANGED);
  }
  await assertAshbyStageStillAvailable({ client, application, stageId: item.stageId });
}
