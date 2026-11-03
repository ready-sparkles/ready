/* eslint-disable @typescript-eslint/no-magic-numbers, @typescript-eslint/explicit-module-boundary-types -- Fixed pricing fixtures expose inferred mock controls. */
import type { RepositoryPort } from "@readymeet/db/ports/repository";
import type { TestContext } from "node:test";

import { assistantEnv } from "../ports/assistant-env";
import { configureRepositoryPort, repositories } from "../ports/repository-runtime";

const FIXTURE_INPUT_RATE = 5;
const FIXTURE_CACHED_INPUT_RATE = 0.5;
const FIXTURE_OUTPUT_RATE = 30;

export function mockAssistantUsageMetering(t: TestContext) {
  const previousPrices = assistantEnv().OPENAI_MODEL_PRICES_JSON;
  const previousCountBilling = assistantEnv().OPENAI_INPUT_TOKEN_COUNT_BILLING;
  assistantEnv().OPENAI_INPUT_TOKEN_COUNT_BILLING = "unverified";
  const prices = {
    maxContextTokens: 1_050_000,
    longContext: { thresholdTokens: 272_000, inputMultiplier: 1, outputMultiplier: 1 },
    cacheWritePerMillion: 6.25,
    inputPerMillion: FIXTURE_INPUT_RATE,
    cachedInputPerMillion: FIXTURE_CACHED_INPUT_RATE,
    outputPerMillion: FIXTURE_OUTPUT_RATE,
  };
  assistantEnv().OPENAI_MODEL_PRICES_JSON = JSON.stringify(
    Object.fromEntries(
      [
        "gpt-5.6",
        "gpt-5.6-sol",
        "gpt-5.6-sol-2026-09-01",
        "gpt-6-astra",
        "gpt-5.5",
        "gpt-5.4-mini",
        assistantEnv().OPENAI_CAPABILITY_SELECTION_MODEL,
        assistantEnv().OPENAI_MEMORY_MODEL,
        assistantEnv().OPENAI_MEETING_SUMMARY_MODEL,
      ].map((model) => [model, prices]),
    ),
  );
  t.after(() => {
    assistantEnv().OPENAI_MODEL_PRICES_JSON = previousPrices;
    assistantEnv().OPENAI_INPUT_TOKEN_COUNT_BILLING = previousCountBilling;
  });
  const meeting: NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingById"]>>> = {
    id: "fixture",
    title: "Fixture",
    roomName: "fixture-room",
    meetingLinkId: null,
    instanceNumber: 1,
    workspaceId: "host-workspace",
    createdByUserId: "creator",
    kind: "standard",
    status: "ended",
    isConfidential: false,
    confidentialitySource: null,
    confidentialityUpdatedByUserId: null,
    confidentialityUpdatedAt: null,
    createdAt: new Date(0),
    startedAt: null,
    endedAt: null,
    hiddenFromHistoryAt: null,
    hiddenFromHistoryReason: null,
  };
  const workflow: NonNullable<Awaited<ReturnType<RepositoryPort["getCapabilityWorkflowRunById"]>>> = {
    id: "workflow",
    meetingId: "fixture",
    status: "running",
    phase: "reading_meeting",
    error: null,
    context: {},
    capabilityKey: "meeting_coaching",
    recommendationId: "recommendation",
    plan: {},
    result: {},
    draft: {},
    createdAt: "",
    updatedAt: "",
    completedAt: null,
  };
  const previousRepository = repositories();
  const workspace = t.mock.fn(async () => "attendee-workspace");
  const admission = t.mock.fn(async (_input: Record<string, unknown>) => ({ id: "reservation" }));
  const credits = t.mock.fn(async (_input: Record<string, unknown>) => null);
  const usage = t.mock.fn(async (_input: Record<string, unknown>) => null);
  const release = t.mock.fn(async (_input: Record<string, unknown>) => undefined);
  const port = {
    ...previousRepository,
    getMeetingById: async (meetingId: string) => ({ ...meeting, id: meetingId }),
    getCapabilityWorkflowRunById: async () => workflow,
    getMeetingAttendeeWorkspace: workspace,
    getWorkspaceById: async () => ({ plan: "pro" }),
    getWorkspaceMembership: async () => ({ status: "active" }),
    getUserById: async () => ({ deletedAt: null, plan: "free" }),
    getUserCreditBalanceData: async () => ({ balance: 10 }),
    hasPrivateBetaProCreditEntitlement: async () => false,
    getWorkspaceMemberCreditAccess: async () => ({
      /** @external member credit access contract */ subscriptionActive: true,
      allowanceRemaining: 0,
      poolBalance: 0,
    }),
    countOtherHostedTrialMeetings: async () => 0,
    reservePlanCredits: admission,
    settlePlanCredits: credits,
    releasePlanCredits: release,
    recordUsageEvent: usage,
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Only fixture-owned repository methods may run in unit tests.
  configureRepositoryPort(port as unknown as RepositoryPort);
  t.after(() => configureRepositoryPort(previousRepository));

  return { meeting, workflow, workspace, admission, credits, usage, release, port };
}

export function gatewayTextResponse(text: string): Record<string, unknown> {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 20, text: 20, reasoning: 0 },
    },
    warnings: [],
  };
}
