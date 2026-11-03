import {
  acceptWorkspaceInvitationResponseSchema,
  addReadyMeetingToCalendarEventResponseSchema,
  adminAiUsageEventsResponseSchema,
  adminAiUsageSummaryResponseSchema,
  adminOverviewResponseSchema,
  agentSettingsResponseSchema,
  ambientContextPrivateDetailsSchema,
  ashbyIntegrationStatusResponseSchema,
  type AshbyReviewAction,
  ashbyReviewResponseSchema,
  authResponseSchema,
  billingCheckoutConfirmationRequestSchema,
  billingCheckoutConfirmationResponseSchema,
  billingCheckoutRequestSchema,
  billingRedirectResponseSchema,
  billingTopupRequestSchema,
  calendarAccountsResponseSchema,
  calendarConnectResponseSchema,
  calendarDisconnectResponseSchema,
  calendarEventPrepEstimateResponseSchema,
  type CalendarEventPrepProcessor,
  calendarEventPrepResponseSchema,
  calendarEventsResponseSchema,
  type CalendarProvider,
  type ClearDoneTasksRange,
  clearDoneTasksResponseSchema,
  clearSelectedDoneTasksRequestSchema,
  clearSelectedDoneTasksResponseSchema,
  createInstantMeetingResponseSchema,
  createWorkspaceResponseSchema,
  deleteAccountResponseSchema,
  deleteCalendarEventResponseSchema,
  deleteWorkspaceResponseSchema,
  deleteWorkspaceTaskSectionResponseSchema,
  getPrivateBetaWaitlistResponseSchema,
  guestMeetingNotesResponseSchema,
  inviteWorkspaceMembersResponseSchema,
  joinPrivateBetaWaitlistResponseSchema,
  linearConnectResponseSchema,
  linearDisconnectResponseSchema,
  linearTaskReviewResponseSchema,
  linkGuestSessionResponseSchema,
  logoutAllDevicesResponseSchema,
  mediaPreferencesResponseSchema,
  type MediaQualityDiagnostic,
  meetingAgentToolInvocationActionResponseSchema,
  meetingAmbientContextItemSchema,
  meetingAmbientContextResponseSchema,
  meetingAssetsResponseSchema,
  meetingDetailResponseSchema,
  meetingInviteSuggestionsResponseSchema,
  meetingJoinRequestDecisionResponseSchema,
  meetingJoinRequestListResponseSchema,
  meetingJoinRequestResponseSchema,
  meetingJoinRequestStatusResponseSchema,
  meetingLinkPrejoinResponseSchema,
  meetingLinkResolveResponseSchema,
  meetingListResponseSchema,
  meetingLiveResponseSchema,
  meetingNotesRegenerationProgressResponseSchema,
  meetingNotesViewResponseSchema,
  meetingPeopleMemoryResponseSchema,
  meetingPreparationPreviewResponseSchema,
  meetingSnapshotRunResponseSchema,
  meetingTasksStatusResponseSchema,
  type MeetingTrackerState,
  meetingTrackerStateSchema,
  type MemoryListChanges,
  type MemoryListPage,
  type MemoryPeoplePage,
  type MemoryPerson,
  type MemoryPreferences,
  type MemoryProjection,
  type MemoryStatus,
  myWorkspaceResponseSchema,
  type NormalizedCalendarEvent,
  personalAssignedTasksResponseSchema,
  type ProviderAccountKind,
  providerDataDeletionResponseSchema,
  regenerateMeetingNotesResponseSchema,
  type RelationshipMemory,
  removeWorkspaceMemberResponseSchema,
  reorderWorkspaceTasksResponseSchema,
  revokeWorkspaceInvitationResponseSchema,
  type SelectedDoneTask,
  sendMeetingInvitesResponseSchema,
  slackChannelsResponseSchema,
  slackConnectResponseSchema,
  slackCreateChannelResponseSchema,
  type SlackDeliveryConfig,
  slackDeliverySettingsResponseSchema,
  slackDisconnectResponseSchema,
  updateAdminUserPlanResponseSchema,
  updateCalendarAccountResponseSchema,
  updateMeetingTaskResponseSchema,
  updateUserProfileResponseSchema,
  type UserPlan,
  userWorkspaceIdsResponseSchema,
  voiceWebResearchRunResponseSchema,
  voiceWebResearchRunsResponseSchema,
  workspaceBillingSummaryResponseSchema,
  workspaceInvitationActionResponseSchema,
  workspaceInvitationPublicInfoResponseSchema,
  workspaceMemberActionResponseSchema,
  workspaceMemberBillingResponseSchema,
  workspaceMembersResponseSchema,
  workspaceMembersResponseSchemaV2,
  workspaceSettingsResponseSchema,
  workspaceTaskResponseSchema,
  workspaceTaskSectionResponseSchema,
} from "@readymeet/shared";
import { slackMeetingReviewResponseSchema } from "@readymeet/shared";
import { z } from "zod";

import { ApiError, getApiErrorCode } from "../domain/api-error";
import type { MeetingDetailPayload, MeetingNotesViewPayload, PostMeetingDisposition } from "../domain/types";

import { webEnv } from "./env";

export { ApiError, getApiErrorCode, getApiErrorMessage } from "../domain/api-error";
const ambientContextPrivateDetailsTimeoutMs = 15_000;
const mediaQualityUploadTimeoutMs = 5_000;
const ambientContextImageFailedPrefix = "Ambient context image failed";
const meetingAssetPreviewFailedPrefix = "Meeting asset preview failed";

type ApiJson = string | number | boolean | null | ApiJson[] | { [key: string]: ApiJson };

const apiJsonSchema: z.ZodType<ApiJson> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(apiJsonSchema), z.record(z.string(), apiJsonSchema)]),
);

type ApiRequestOptions = RequestInit & { token?: string; sameOriginPath?: string };

type ApiTransport = (input: { path: string; options: ApiRequestOptions }) => Promise<unknown>;

const apiTransportState: { current: ApiTransport | null } = { current: null };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const formatStatusFailure = (input: { prefix: string; status: number }): string =>
  `${input.prefix} (${String(input.status)})`;

type JoinMeetingResponse = {
  activeWorkspaceId?: string | null;
  participants: { userId: string; displayName: string; role: string }[];
};

type LiveKitTokenResponse = {
  token: string;
  wsUrl: string;
  roomName: string;
};
type DeleteWorkspaceTasksResponse = {
  taskIds: string[];
};

type EndMeetingResponse = {
  /** @external existing wire contract */
  ok: boolean;
  /** @external existing wire contract */
  finalized: boolean;
  meeting: MeetingDetailPayload["meeting"];
  meetingRuntime: MeetingDetailPayload["meetingRuntime"];
  postMeetingDisposition?: PostMeetingDisposition | null;
};

type StartedLiveTranscriptionResponse = {
  /** @external existing wire contract */
  ok: true;
  /** @external existing wire contract */
  started: boolean;
};

type OkResponse = {
  /** @external existing wire contract */
  ok: true;
};

type DeleteMeetingResponse = {
  /** @external existing wire contract */
  ok: true;
  mode: string;
};

type MemoryPreferencesResponse = {
  preferences: MemoryPreferences;
};

type MemoryPersonResponse = {
  person: MemoryPerson;
  projection: MemoryProjection | null;
  memories: RelationshipMemory[];
  meetings: { id: string; title: string; occurredAt: string }[];
  /** @external existing wire contract */
  processing: boolean;
};

type MemoryEvidenceResponse = {
  people?: MemoryPerson[];
  evidence: { segmentId: string; quote: string; speakerName: string; startedAt: string; meetingId: string }[];
};

const joinMeetingResponseSchema = z.custom<JoinMeetingResponse>((value): value is JoinMeetingResponse => {
  if (!isRecord(value) || !Array.isArray(value.participants)) {
    return false;
  }
  const activeWorkspaceId = value.activeWorkspaceId;
  if (activeWorkspaceId !== undefined && activeWorkspaceId !== null && typeof activeWorkspaceId !== "string") {
    return false;
  }

  return value.participants.every(
    (participant) =>
      isRecord(participant) &&
      typeof participant.userId === "string" &&
      typeof participant.displayName === "string" &&
      typeof participant.role === "string",
  );
});

const liveKitTokenResponseSchema = z.custom<LiveKitTokenResponse>(
  (value): value is LiveKitTokenResponse =>
    isRecord(value) &&
    typeof value.token === "string" &&
    typeof value.wsUrl === "string" &&
    typeof value.roomName === "string",
);
const deleteWorkspaceTasksResponseSchema = z.custom<DeleteWorkspaceTasksResponse>(
  (value): value is DeleteWorkspaceTasksResponse =>
    isRecord(value) && Array.isArray(value.taskIds) && value.taskIds.every((taskId) => typeof taskId === "string"),
);

const endMeetingResponseSchema = z.custom<EndMeetingResponse>((value): value is EndMeetingResponse => {
  if (!isRecord(value) || typeof value.ok !== "boolean" || typeof value.finalized !== "boolean") {
    return false;
  }
  if (!isRecord(value.meeting) || !isRecord(value.meetingRuntime)) {
    return false;
  }
  const disposition = value.postMeetingDisposition;

  return disposition === undefined || disposition === null || isRecord(disposition);
});

const startedLiveTranscriptionResponseSchema = z.custom<StartedLiveTranscriptionResponse>(
  (value): value is StartedLiveTranscriptionResponse =>
    isRecord(value) && value.ok === true && typeof value.started === "boolean",
);

const okResponseSchema = z.custom<OkResponse>((value): value is OkResponse => isRecord(value) && value.ok === true);

const deleteMeetingResponseSchema = z.custom<DeleteMeetingResponse>(
  (value): value is DeleteMeetingResponse => isRecord(value) && value.ok === true && typeof value.mode === "string",
);

const memoryStatusSchema = z.custom<MemoryStatus>(
  (value): value is MemoryStatus =>
    isRecord(value) && typeof value.available === "boolean" && isRecord(value.preferences) && isRecord(value.progress),
);

const memoryPreferencesResponseSchema = z.custom<MemoryPreferencesResponse>(
  (value): value is MemoryPreferencesResponse => isRecord(value) && isRecord(value.preferences),
);

const memoryListPageSchema = z.custom<MemoryListPage>(
  (value): value is MemoryListPage =>
    isRecord(value) &&
    Array.isArray(value.memories) &&
    (value.nextCursor === null || typeof value.nextCursor === "string"),
);

const memoryListChangesSchema = z.custom<MemoryListChanges>(
  (value): value is MemoryListChanges =>
    isRecord(value) &&
    Array.isArray(value.memories) &&
    Array.isArray(value.removedIds) &&
    typeof value.syncCursor === "string" &&
    typeof value.hasMore === "boolean",
);

const memoryPeoplePageSchema = z.custom<MemoryPeoplePage>(
  (value): value is MemoryPeoplePage => isRecord(value) && Array.isArray(value.people),
);

const memoryPersonResponseSchema = z.custom<MemoryPersonResponse>((value): value is MemoryPersonResponse => {
  if (!isRecord(value) || !isRecord(value.person) || typeof value.processing !== "boolean") {
    return false;
  }
  if (value.projection !== null && !isRecord(value.projection)) {
    return false;
  }

  return Array.isArray(value.memories) && Array.isArray(value.meetings);
});

const memoryEvidenceResponseSchema = z.custom<MemoryEvidenceResponse>(
  (value): value is MemoryEvidenceResponse =>
    isRecord(value) && Array.isArray(value.evidence) && (value.people === undefined || Array.isArray(value.people)),
);

const INVALID_API_TOKEN_MESSAGE = "Invalid token";
const HTTP_UNAUTHORIZED_STATUS = 401;
const invalidApiTokenListeners = new Set<(token: string) => void>();

/** Notifies when the API rejects a bearer token as invalid (e.g. revoked by "Log out of all devices"). */
export function onInvalidApiToken(listener: (token: string) => void): () => void {
  invalidApiTokenListeners.add(listener);

  return () => {
    invalidApiTokenListeners.delete(listener);
  };
}

const WORKSPACE_SUSPENDED_CODE = "workspace_suspended";
const HTTP_FORBIDDEN_STATUS = 403;
const suspendedWorkspaceListeners = new Set<(token: string) => void>();

/**
 * Notifies when the API refuses a request because the signed-in user is
 * suspended from that workspace. The session may still name the suspended
 * workspace, so listeners re-resolve the active workspace.
 */
export function onSuspendedWorkspace(listener: (token: string) => void): () => void {
  suspendedWorkspaceListeners.add(listener);

  return () => {
    suspendedWorkspaceListeners.delete(listener);
  };
}

function notifyRejectedTokenListeners(input: { error: ApiError; rejectedToken: string | undefined }): void {
  const { error, rejectedToken } = input;
  if (rejectedToken === undefined || rejectedToken === "") {
    return;
  }
  if (error.status === HTTP_UNAUTHORIZED_STATUS && error.displayMessage === INVALID_API_TOKEN_MESSAGE) {
    invalidApiTokenListeners.forEach((listener) => {
      listener(rejectedToken);
    });
  }
  if (error.status === HTTP_FORBIDDEN_STATUS && getApiErrorCode(error) === WORKSPACE_SUSPENDED_CODE) {
    suspendedWorkspaceListeners.forEach((listener) => {
      listener(rejectedToken);
    });
  }
}

/** Routes every API request in this window to a local handler (the homepage workspace demo). */
export function setApiTransport(transport: ApiTransport | null): void {
  apiTransportState.current = transport;
}

async function apiFetch(input: { path: string; options?: ApiRequestOptions }): Promise<ApiJson> {
  const options = input.options ?? {};
  if (apiTransportState.current !== null) {
    return apiJsonSchema.parse(await apiTransportState.current({ path: input.path, options }));
  }

  const headers = new Headers(options.headers);

  if (typeof options.body === "string") {
    headers.set("content-type", "application/json");
  }

  if (options.token !== undefined && options.token !== "") {
    headers.set("authorization", `Bearer ${options.token}`);
  }

  const { sameOriginPath, ...fetchOptions } = options;
  const response = await fetch(sameOriginPath ?? `${webEnv.NEXT_PUBLIC_API_BASE_URL}/v1${input.path}`, {
    ...fetchOptions,
    headers,
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text();
    const error = new ApiError({ status: response.status, responseText: text });
    notifyRejectedTokenListeners({ error, rejectedToken: options.token });
    throw error;
  }

  return apiJsonSchema.parse(await response.json());
}

export async function listMeetings(token: string): Promise<z.output<typeof meetingListResponseSchema>["meetings"]> {
  const payload = await apiFetch({ path: "/meetings", options: { token } });

  return meetingListResponseSchema.parse(payload).meetings;
}

export async function getCurrentAuthSession(token: string): Promise<z.output<typeof authResponseSchema>> {
  const payload = await apiFetch({ path: "/auth/me", options: { token } });

  return authResponseSchema.parse(payload);
}

export async function getAdminOverview(
  token: string,
): Promise<z.output<typeof adminOverviewResponseSchema>["overview"]> {
  const payload = await apiFetch({ path: "/admin/overview", options: { token } });

  return adminOverviewResponseSchema.parse(payload).overview;
}

export async function updateAdminUserPlan({
  token,
  userId,
  plan,
}: {
  token: string;
  userId: string;
  plan: UserPlan;
}): Promise<z.output<typeof updateAdminUserPlanResponseSchema>["user"]> {
  const payload = await apiFetch({
    path: `/admin/users/${userId}/plan`,
    options: {
      method: "PATCH",
      token,
      body: JSON.stringify({ plan }),
    },
  });

  return updateAdminUserPlanResponseSchema.parse(payload).user;
}

function buildQuery(params: Record<string, string | number | null | undefined>): string {
  const query = new URLSearchParams(
    Object.entries(params).flatMap(([key, value]): [string, string][] => {
      if (value === null || value === undefined || String(value).trim() === "") {
        return [];
      }

      return [[key, String(value)]];
    }),
  );
  const text = query.toString();

  return text === "" ? "" : `?${text}`;
}

export async function getAdminAiUsageSummary({
  token,
  params = {},
}: {
  token: string;
  params?: {
    startDate?: string | null;
    endDate?: string | null;
    actionType?: string | null;
    model?: string | null;
  };
}): Promise<z.output<typeof adminAiUsageSummaryResponseSchema>["summary"]> {
  const payload = await apiFetch({ path: `/admin/ai-usage/summary${buildQuery(params)}`, options: { token } });

  return adminAiUsageSummaryResponseSchema.parse(payload).summary;
}

export async function getAdminAiUsageEvents({
  token,
  params = {},
}: {
  token: string;
  params?: {
    startDate?: string | null;
    endDate?: string | null;
    actionType?: string | null;
    model?: string | null;
    limit?: number;
    offset?: number;
    sort?: string;
    direction?: string;
  };
}): Promise<z.output<typeof adminAiUsageEventsResponseSchema>> {
  const payload = await apiFetch({ path: `/admin/ai-usage/events${buildQuery(params)}`, options: { token } });

  return adminAiUsageEventsResponseSchema.parse(payload);
}

export async function getPrivateBetaWaitlistEntry(
  token: string,
): Promise<z.output<typeof getPrivateBetaWaitlistResponseSchema>["waitlistEntry"]> {
  const payload = await apiFetch({ path: "/me/waitlist", options: { token } });

  return getPrivateBetaWaitlistResponseSchema.parse(payload).waitlistEntry;
}

export async function joinPrivateBetaWaitlist(
  token: string,
): Promise<z.output<typeof joinPrivateBetaWaitlistResponseSchema>["waitlistEntry"]> {
  const payload = await apiFetch({
    path: "/me/waitlist",
    options: {
      method: "POST",
      token,
    },
  });

  return joinPrivateBetaWaitlistResponseSchema.parse(payload).waitlistEntry;
}
export async function createInstantMeeting({
  token,
  input = {},
}: {
  token: string;
  input?: { title?: string; existingMeetingId?: string | null; intent?: "standard" | "agent_intro" };
}): Promise<z.output<typeof createInstantMeetingResponseSchema>> {
  const payload = await apiFetch({
    path: "/meetings/instant",
    options: {
      method: "POST",
      token,
      body: JSON.stringify(input),
    },
  });

  return createInstantMeetingResponseSchema.parse(payload);
}

export async function getMeeting({
  token,
  meetingId,
  options = {},
}: {
  token: string;
  meetingId: string;
  options?: { signal?: AbortSignal };
}): Promise<MeetingDetailPayload> {
  const payload = await apiFetch({ path: `/meetings/${meetingId}`, options: { token, signal: options.signal } });

  return meetingDetailResponseSchema.parse(payload);
}

export async function getMeetingNotesView(input: {
  token: string;
  meetingId: string;
  signal?: AbortSignal;
}): Promise<MeetingNotesViewPayload> {
  const payload = await apiFetch({
    path: `/meetings/${input.meetingId}/notes-view`,
    options: { token: input.token, signal: input.signal },
  });

  return meetingNotesViewResponseSchema.parse(payload);
}

export async function getMeetingLinearTaskReview(input: {
  token: string;
  meetingId: string;
}): Promise<z.output<typeof linearTaskReviewResponseSchema>["review"]> {
  const payload = await apiFetch({
    path: `/meetings/${input.meetingId}/linear-task-review`,
    options: { token: input.token },
  });

  return linearTaskReviewResponseSchema.parse(payload).review;
}

export async function getMeetingPreparationPreview({
  token,
  meetingId,
  options = {},
}: {
  token: string;
  meetingId: string;
  options?: { signal?: AbortSignal };
}): Promise<z.output<typeof meetingPreparationPreviewResponseSchema>> {
  const payload = await apiFetch({
    path: `/meetings/${meetingId}/preparation-preview`,
    options: {
      token,
      signal: options.signal,
    },
  });

  return meetingPreparationPreviewResponseSchema.parse(payload);
}

export async function listMeetingWebResearchRuns({
  token,
  meetingId,
  signal,
}: {
  token: string;
  meetingId: string;
  signal?: AbortSignal;
}): Promise<z.output<typeof voiceWebResearchRunsResponseSchema>["runs"]> {
  const payload = await apiFetch({ path: `/meetings/${meetingId}/web-research-runs`, options: { token, signal } });

  return voiceWebResearchRunsResponseSchema.parse(payload).runs;
}

export async function getMeetingWebResearchRun({
  token,
  meetingId,
  runId,
  signal,
}: {
  token: string;
  meetingId: string;
  runId: string;
  signal?: AbortSignal;
}): Promise<z.output<typeof voiceWebResearchRunResponseSchema>["run"]> {
  const payload = await apiFetch({
    path: `/meetings/${meetingId}/web-research-runs/${runId}`,
    options: { token, signal },
  });

  return voiceWebResearchRunResponseSchema.parse(payload).run;
}

export async function getLiveMeeting({
  token,
  meetingId,
  signal,
}: {
  token: string;
  meetingId: string;
  signal?: AbortSignal;
}): Promise<z.output<typeof meetingLiveResponseSchema>> {
  const payload = await apiFetch({ path: `/meetings/${meetingId}/live`, options: { token, signal } });

  return meetingLiveResponseSchema.parse(payload);
}
export async function resolveMeetingLink({
  token,
  code,
}: {
  token: string;
  code: string;
}): Promise<z.output<typeof meetingLinkResolveResponseSchema>> {
  const payload = await apiFetch({
    path: `/meeting-links/${encodeURIComponent(code)}/resolve`,
    options: {
      method: "POST",
      token,
    },
  });

  return meetingLinkResolveResponseSchema.parse(payload);
}

export async function getMeetingLinkPrejoin(input: {
  code: string;
  token?: string | null;
}): Promise<z.output<typeof meetingLinkPrejoinResponseSchema>> {
  const payload = await apiFetch({
    path: `/meeting-links/${encodeURIComponent(input.code)}/prejoin`,
    options: {
      token: input.token ?? undefined,
    },
  });

  return meetingLinkPrejoinResponseSchema.parse(payload);
}

export async function createMeetingJoinRequest(input: {
  code: string;
  token?: string | null;
  displayName?: string;
  recognition?: {
    /** @external existing wire contract */
    enabled: boolean;
    noticeVersion: string;
    /** @external existing wire contract */
    explicitOptIn: boolean;
  };
}): Promise<z.output<typeof meetingJoinRequestResponseSchema>> {
  const send = () =>
    apiFetch({
      path: `/meeting-links/${encodeURIComponent(input.code)}/join-requests`,
      options: {
        sameOriginPath:
          (input.token !== undefined && input.token !== null && input.token !== "") || input.recognition === undefined
            ? undefined
            : `/api/guest-join/${encodeURIComponent(input.code)}`,
        method: "POST",
        token: input.token ?? undefined,
        body: JSON.stringify({
          displayName: input.displayName,
          recognition: input.recognition,
        }),
      },
    });
  // Serialize first opt-ins across tabs so the second request sees the first cookie.
  const payload =
    input.recognition?.enabled === true && typeof navigator !== "undefined"
      ? await navigator.locks.request("ready-guest-recognition-join", send)
      : await send();

  return meetingJoinRequestResponseSchema.parse(payload);
}

export async function listMeetingJoinRequests({
  token,
  meetingId,
  signal,
}: {
  token: string;
  meetingId: string;
  signal?: AbortSignal;
}): Promise<z.output<typeof meetingJoinRequestListResponseSchema>["requests"]> {
  const payload = await apiFetch({ path: `/meetings/${meetingId}/join-requests`, options: { token, signal } });

  return meetingJoinRequestListResponseSchema.parse(payload).requests;
}

export async function getMeetingInviteSuggestions({
  token,
  meetingId,
  input = {},
}: {
  token: string;
  meetingId: string;
  input?: { query?: string; signal?: AbortSignal };
}): Promise<z.output<typeof meetingInviteSuggestionsResponseSchema>> {
  const query = input.query?.trim();
  const querySuffix = query !== undefined && query !== "" ? `?q=${encodeURIComponent(query)}` : "";
  const payload = await apiFetch({
    path: `/meetings/${meetingId}/invite-suggestions${querySuffix}`,
    options: { token, signal: input.signal },
  });

  return meetingInviteSuggestionsResponseSchema.parse(payload);
}

export async function sendMeetingInvites({
  token,
  meetingId,
  emails,
  signal,
}: {
  token: string;
  meetingId: string;
  emails: string[];
  signal?: AbortSignal;
}): Promise<z.output<typeof sendMeetingInvitesResponseSchema>> {
  const payload = await apiFetch({
    path: `/meetings/${meetingId}/invitations`,
    options: {
      method: "POST",
      token,
      signal,
      body: JSON.stringify({ emails }),
    },
  });

  return sendMeetingInvitesResponseSchema.parse(payload);
}

export async function admitMeetingJoinRequest({
  token,
  meetingId,
  requestId,
  signal,
}: {
  token: string;
  meetingId: string;
  requestId: string;
  signal?: AbortSignal;
}): Promise<z.output<typeof meetingJoinRequestDecisionResponseSchema>["request"]> {
  const payload = await apiFetch({
    path: `/meetings/${meetingId}/join-requests/${requestId}/admit`,
    options: {
      method: "POST",
      token,
      signal,
    },
  });

  return meetingJoinRequestDecisionResponseSchema.parse(payload).request;
}

export async function denyMeetingJoinRequest({
  token,
  meetingId,
  requestId,
  signal,
}: {
  token: string;
  meetingId: string;
  requestId: string;
  signal?: AbortSignal;
}): Promise<z.output<typeof meetingJoinRequestDecisionResponseSchema>["request"]> {
  const payload = await apiFetch({
    path: `/meetings/${meetingId}/join-requests/${requestId}/deny`,
    options: {
      method: "POST",
      token,
      signal,
    },
  });

  return meetingJoinRequestDecisionResponseSchema.parse(payload).request;
}

export async function getMeetingJoinRequestStatus({
  token,
  requestId,
}: {
  token: string;
  requestId: string;
}): Promise<z.output<typeof meetingJoinRequestStatusResponseSchema>> {
  const payload = await apiFetch({ path: `/meeting-join-requests/${requestId}`, options: { token } });

  return meetingJoinRequestStatusResponseSchema.parse(payload);
}

export async function getGuestMeetingNotes({
  token,
  meetingId,
}: {
  token: string;
  meetingId: string;
}): Promise<z.output<typeof guestMeetingNotesResponseSchema>> {
  const payload = await apiFetch({ path: `/meetings/${meetingId}/guest-notes`, options: { token } });

  return guestMeetingNotesResponseSchema.parse(payload);
}

export async function linkGuestSession({
  token,
  guestToken,
}: {
  token: string;
  guestToken: string;
}): Promise<z.output<typeof linkGuestSessionResponseSchema>> {
  const payload = await apiFetch({
    path: "/auth/link-guest-session",
    options: {
      method: "POST",
      token,
      body: JSON.stringify({ guestToken }),
    },
  });

  return linkGuestSessionResponseSchema.parse(payload);
}

export async function joinMeeting({
  token,
  meetingId,
}: {
  token: string;
  meetingId: string;
}): Promise<z.output<typeof joinMeetingResponseSchema>> {
  return joinMeetingResponseSchema.parse(
    await apiFetch({
      path: `/meetings/${meetingId}/join`,
      options: {
        method: "POST",
        token,
      },
    }),
  );
}

export async function mintLiveKitToken(input: {
  token: string;
  meetingId: string;
  participantName: string;
}): Promise<z.output<typeof liveKitTokenResponseSchema>> {
  return liveKitTokenResponseSchema.parse(
    await apiFetch({
      path: "/livekit/token",
      options: {
        method: "POST",
        token: input.token,
        body: JSON.stringify({
          meetingId: input.meetingId,
          participantName: input.participantName,
        }),
      },
    }),
  );
}

export async function runMeetingSnapshot({
  token,
  meetingId,
}: {
  token: string;
  meetingId: string;
}): Promise<z.output<typeof meetingSnapshotRunResponseSchema>> {
  const payload = await apiFetch({
    path: `/meetings/${meetingId}/run-snapshot`,
    options: {
      method: "POST",
      token,
    },
  });

  return meetingSnapshotRunResponseSchema.parse(payload);
}

/** Starts (or joins) the one run that replaces a meeting's fallback notes. */
export async function regenerateMeetingNotes({
  token,
  meetingId,
}: {
  token: string;
  meetingId: string;
}): Promise<z.output<typeof regenerateMeetingNotesResponseSchema>> {
  const payload = await apiFetch({
    path: `/meetings/${meetingId}/regenerate-notes`,
    options: {
      method: "POST",
      token,
    },
  });

  return regenerateMeetingNotesResponseSchema.parse(payload);
}

/** Where the run that replaces a meeting's fallback notes stands. */
export async function getMeetingNotesRegenerationProgress({
  token,
  meetingId,
}: {
  token: string;
  meetingId: string;
}): Promise<z.output<typeof meetingNotesRegenerationProgressResponseSchema>> {
  const payload = await apiFetch({
    path: `/meetings/${meetingId}/regenerate-notes`,
    options: { token },
  });

  return meetingNotesRegenerationProgressResponseSchema.parse(payload);
}

export async function runMeetingTasks({
  token,
  meetingId,
}: {
  token: string;
  meetingId: string;
}): Promise<z.output<typeof meetingTasksStatusResponseSchema>> {
  const payload = await apiFetch({
    path: `/meetings/${meetingId}/run-tasks`,
    options: {
      method: "POST",
      token,
    },
  });

  return meetingTasksStatusResponseSchema.parse(payload);
}

export async function getMeetingTasksStatus({
  token,
  meetingId,
}: {
  token: string;
  meetingId: string;
}): Promise<z.output<typeof meetingTasksStatusResponseSchema>> {
  const payload = await apiFetch({ path: `/meetings/${meetingId}/tasks/status`, options: { token } });

  return meetingTasksStatusResponseSchema.parse(payload);
}

export async function updateMeetingTask({
  token,
  meetingId,
  taskId,
  input,
}: {
  token: string;
  meetingId: string;
  taskId: string;
  input: {
    title?: string;
    description?: string | null;
    assigneeUserId?: string | null;
    assigneeName?: string | null;
    assigneeEmail?: string | null;
    dueDateValue?: string | null;
    status?: "open" | "completed" | "dismissed";
  };
}): Promise<z.output<typeof updateMeetingTaskResponseSchema>["task"]> {
  const payload = await apiFetch({
    path: `/meetings/${meetingId}/tasks/${taskId}`,
    options: {
      method: "PATCH",
      token,
      body: JSON.stringify(input),
    },
  });

  return updateMeetingTaskResponseSchema.parse(payload).task;
}
export async function runLinearTaskReview({
  token,
  meetingId,
}: {
  token: string;
  meetingId: string;
}): Promise<z.output<typeof linearTaskReviewResponseSchema>["review"]> {
  const payload = await apiFetch({
    path: `/meetings/${meetingId}/linear-task-review/run`,
    options: {
      method: "POST",
      token,
    },
  });

  return linearTaskReviewResponseSchema.parse(payload).review;
}

export async function reviseLinearTaskReview({
  token,
  runId,
  instruction,
}: {
  token: string;
  runId: string;
  instruction: string;
}): Promise<z.output<typeof linearTaskReviewResponseSchema>["review"]> {
  const payload = await apiFetch({
    path: `/linear-task-reviews/${runId}/revise`,
    options: {
      method: "POST",
      token,
      body: JSON.stringify({ instruction }),
    },
  });

  return linearTaskReviewResponseSchema.parse(payload).review;
}

export async function syncLinearTaskReview({
  token,
  runId,
}: {
  token: string;
  runId: string;
}): Promise<z.output<typeof linearTaskReviewResponseSchema>["review"]> {
  const payload = await apiFetch({
    path: `/linear-task-reviews/${runId}/sync`,
    options: {
      method: "POST",
      token,
    },
  });

  return linearTaskReviewResponseSchema.parse(payload).review;
}

export async function updateLinearTaskReviewTarget({
  token,
  runId,
  itemId,
  input,
}: {
  token: string;
  runId: string;
  itemId: string;
  input: { action: "create" | "link_existing" | "create_duplicate"; issueId: string | null };
}): Promise<z.output<typeof linearTaskReviewResponseSchema>["review"]> {
  const payload = await apiFetch({
    path: `/linear-task-reviews/${runId}/items/${itemId}/target`,
    options: {
      method: "POST",
      token,
      body: JSON.stringify(input),
    },
  });

  return linearTaskReviewResponseSchema.parse(payload).review;
}

export async function listMeetingAssets({
  token,
  meetingId,
}: {
  token: string;
  meetingId: string;
}): Promise<z.output<typeof meetingAssetsResponseSchema>["assets"]> {
  const payload = await apiFetch({ path: `/meetings/${meetingId}/assets`, options: { token } });

  return meetingAssetsResponseSchema.parse(payload).assets;
}

export async function listMeetingAmbientContext({
  token,
  meetingId,
  signal,
}: {
  token: string;
  meetingId: string;
  signal?: AbortSignal;
}): Promise<z.output<typeof meetingAmbientContextResponseSchema>["items"]> {
  const payload = await apiFetch({ path: `/meetings/${meetingId}/ambient-context`, options: { token, signal } });

  return meetingAmbientContextResponseSchema.parse(payload).items;
}

export async function listMeetingPeopleMemory({
  token,
  meetingId,
  signal,
}: {
  token: string;
  meetingId: string;
  signal?: AbortSignal;
}): Promise<z.output<typeof meetingPeopleMemoryResponseSchema>["items"]> {
  return meetingPeopleMemoryResponseSchema.parse(
    await apiFetch({ path: `/meetings/${meetingId}/people-memory`, options: { token, signal } }),
  ).items;
}

export async function retryMeetingAmbientContextItem({
  token,
  meetingId,
  itemId,
  signal,
}: {
  token: string;
  meetingId: string;
  itemId: string;
  signal?: AbortSignal;
}): Promise<z.output<typeof meetingAmbientContextItemSchema>> {
  const payload = await apiFetch({
    path: `/meetings/${meetingId}/ambient-context/${itemId}/retry`,
    options: {
      method: "POST",
      token,
      signal,
    },
  });

  return meetingAmbientContextItemSchema.parse(payload);
}

/** The viewer's own sections of a person card: their memory and, if they turned Ashby on, Ashby. */
export async function getMeetingAmbientContextPrivateDetails({
  token,
  meetingId,
  itemId,
}: {
  token: string;
  meetingId: string;
  itemId: string;
}): Promise<z.output<typeof ambientContextPrivateDetailsSchema>> {
  const payload = await apiFetch({
    path: `/meetings/${meetingId}/ambient-context/${itemId}/private`,
    options: {
      token,
      signal: AbortSignal.timeout(ambientContextPrivateDetailsTimeoutMs),
    },
  });

  return ambientContextPrivateDetailsSchema.parse(payload);
}

export async function getMeetingAmbientContextImageObjectUrl({
  token,
  meetingId,
  itemId,
  cacheKey,
}: {
  token: string;
  meetingId: string;
  itemId: string;
  cacheKey?: string | null;
}): Promise<string> {
  const versionQuery =
    cacheKey !== undefined && cacheKey !== null && cacheKey !== "" ? `?v=${encodeURIComponent(cacheKey)}` : "";
  const response = await fetch(
    `${webEnv.NEXT_PUBLIC_API_BASE_URL}/v1/meetings/${meetingId}/ambient-context/${itemId}/image${versionQuery}`,
    {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(ambientContextPrivateDetailsTimeoutMs),
    },
  );
  if (!response.ok) {
    throw new Error(formatStatusFailure({ prefix: ambientContextImageFailedPrefix, status: response.status }));
  }

  return URL.createObjectURL(await response.blob());
}

export async function getMeetingAssetObjectUrl({
  token,
  meetingId,
  assetId,
}: {
  token: string;
  meetingId: string;
  assetId: string;
}): Promise<string> {
  const response = await fetch(
    `${webEnv.NEXT_PUBLIC_API_BASE_URL}/v1/meetings/${meetingId}/assets/${assetId}/content`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!response.ok) {
    throw new Error(formatStatusFailure({ prefix: meetingAssetPreviewFailedPrefix, status: response.status }));
  }

  return URL.createObjectURL(await response.blob());
}

export async function listWorkspaceMembers({
  token,
  workspaceId,
}: {
  token: string;
  workspaceId: string;
}): Promise<z.output<typeof workspaceMembersResponseSchema>["members"]> {
  const payload = await apiFetch({ path: `/workspaces/${workspaceId}/members`, options: { token } });

  return workspaceMembersResponseSchema.parse(payload).members;
}

export async function listMyWorkspaceIds(
  token: string,
): Promise<z.output<typeof userWorkspaceIdsResponseSchema>["workspaceIds"]> {
  const payload = await apiFetch({ path: "/me/workspaces", options: { token } });

  return userWorkspaceIdsResponseSchema.parse(payload).workspaceIds;
}

export async function listPersonalAssignedTasks(
  token: string,
): Promise<z.output<typeof personalAssignedTasksResponseSchema>> {
  const payload = await apiFetch({ path: "/me/tasks/personal", options: { token } });

  return personalAssignedTasksResponseSchema.parse(payload);
}

export async function clearPersonalDoneTasks({
  token,
  workspaceId,
  range,
}: {
  token: string;
  workspaceId: string;
  range: ClearDoneTasksRange;
}): Promise<z.output<typeof clearDoneTasksResponseSchema>> {
  const payload = await apiFetch({
    path: "/me/tasks/personal/clear-done",
    options: {
      token,
      method: "POST",
      body: JSON.stringify({ workspaceId, range }),
    },
  });

  return clearDoneTasksResponseSchema.parse(payload);
}

export async function clearSelectedDoneTasks({
  token,
  workspaceId,
  tasks,
}: {
  token: string;
  workspaceId: string;
  tasks: SelectedDoneTask[];
}): Promise<z.output<typeof clearSelectedDoneTasksResponseSchema>["tasks"]> {
  const request = clearSelectedDoneTasksRequestSchema.safeParse({ workspaceId, tasks });
  if (!request.success) {
    throw new Error(request.error.issues[0]?.message ?? "Selected tasks could not be cleared.");
  }
  const payload = await apiFetch({
    path: "/me/tasks/personal/clear-selected",
    options: {
      token,
      method: "POST",
      body: JSON.stringify(request.data),
    },
  });

  return clearSelectedDoneTasksResponseSchema.parse(payload).tasks;
}

export async function createWorkspaceTask({
  token,
  workspaceId,
  input,
}: {
  token: string;
  workspaceId: string;
  input: {
    title?: string;
    description?: string | null;
    assigneeUserId?: string | null;
    dueDateValue?: string | null;
    sectionId?: string | null;
    beforeTaskId?: string;
    afterTaskId?: string;
  };
}): Promise<z.output<typeof workspaceTaskResponseSchema>["task"]> {
  const payload = await apiFetch({
    path: `/workspaces/${workspaceId}/tasks`,
    options: {
      method: "POST",
      token,
      body: JSON.stringify(input),
    },
  });

  return workspaceTaskResponseSchema.parse(payload).task;
}

export async function updateWorkspaceTask({
  token,
  workspaceId,
  taskId,
  input,
}: {
  token: string;
  workspaceId: string;
  taskId: string;
  input: {
    title?: string;
    description?: string | null;
    assigneeUserId?: string | null;
    dueDateValue?: string | null;
    status?: "open" | "completed" | "dismissed";
    sectionId?: string | null;
  };
}): Promise<z.output<typeof workspaceTaskResponseSchema>["task"]> {
  const payload = await apiFetch({
    path: `/workspaces/${workspaceId}/tasks/${taskId}`,
    options: {
      method: "PATCH",
      token,
      body: JSON.stringify(input),
    },
  });

  return workspaceTaskResponseSchema.parse(payload).task;
}

export async function deleteWorkspaceTasks({
  token,
  workspaceId,
  taskIds,
}: {
  token: string;
  workspaceId: string;
  taskIds: string[];
}): Promise<z.output<typeof deleteWorkspaceTasksResponseSchema>["taskIds"]> {
  return deleteWorkspaceTasksResponseSchema.parse(
    await apiFetch({
      path: `/workspaces/${workspaceId}/tasks`,
      options: {
        method: "DELETE",
        token,
        body: JSON.stringify({ taskIds }),
      },
    }),
  ).taskIds;
}
export async function updateWorkspaceTaskSection({
  token,
  workspaceId,
  sectionId,
  input,
}: {
  token: string;
  workspaceId: string;
  sectionId: string;
  input: { title?: string; position?: number };
}): Promise<z.output<typeof workspaceTaskSectionResponseSchema>["section"]> {
  const payload = await apiFetch({
    path: `/workspaces/${workspaceId}/task-sections/${sectionId}`,
    options: {
      method: "PATCH",
      token,
      body: JSON.stringify(input),
    },
  });

  return workspaceTaskSectionResponseSchema.parse(payload).section;
}

export async function deleteWorkspaceTaskSection({
  token,
  workspaceId,
  sectionId,
}: {
  token: string;
  workspaceId: string;
  sectionId: string;
}): Promise<z.output<typeof deleteWorkspaceTaskSectionResponseSchema>> {
  const payload = await apiFetch({
    path: `/workspaces/${workspaceId}/task-sections/${sectionId}`,
    options: {
      method: "DELETE",
      token,
    },
  });

  return deleteWorkspaceTaskSectionResponseSchema.parse(payload);
}

export async function reorderWorkspaceTasks({
  token,
  workspaceId,
  input,
}: {
  token: string;
  workspaceId: string;
  input: {
    movedTaskIds: string[];
    targetSectionId: string;
    beforeTaskId?: string;
    afterTaskId?: string;
  };
}): Promise<z.output<typeof reorderWorkspaceTasksResponseSchema>["tasks"]> {
  const payload = await apiFetch({
    path: `/workspaces/${workspaceId}/tasks/reorder`,
    options: {
      method: "POST",
      token,
      body: JSON.stringify(input),
    },
  });

  return reorderWorkspaceTasksResponseSchema.parse(payload).tasks;
}

export async function connectLinear({
  token,
  input = {},
}: {
  token: string;
  input?: { returnTo?: string };
}): Promise<z.output<typeof linearConnectResponseSchema>["authorizationUrl"]> {
  const payload = await apiFetch({
    path: "/integrations/linear/connect",
    options: {
      method: "POST",
      token,
      body: JSON.stringify(input),
    },
  });

  return linearConnectResponseSchema.parse(payload).authorizationUrl;
}

export async function disconnectLinear(token: string): Promise<z.output<typeof linearDisconnectResponseSchema>["ok"]> {
  const payload = await apiFetch({
    path: "/integrations/linear/disconnect",
    options: {
      method: "POST",
      token,
    },
  });

  return linearDisconnectResponseSchema.parse(payload).ok;
}

function ashbyPath({ workspaceId, suffix = "" }: { workspaceId: string; suffix?: string }) {
  return `/workspaces/${encodeURIComponent(workspaceId)}/integrations/ashby${suffix}`;
}

export async function getAshbyIntegration({
  token,
  workspaceId,
}: {
  token: string;
  workspaceId: string;
}): Promise<z.output<typeof ashbyIntegrationStatusResponseSchema>> {
  return ashbyIntegrationStatusResponseSchema.parse(
    await apiFetch({ path: ashbyPath({ workspaceId }), options: { token } }),
  );
}

/** Admin only: verifies and stores the workspace's Ashby API key. */
export async function saveAshbyKey({
  token,
  workspaceId,
  apiKey,
}: {
  token: string;
  workspaceId: string;
  apiKey: string;
}): Promise<z.output<typeof ashbyIntegrationStatusResponseSchema>> {
  const payload = await apiFetch({
    path: ashbyPath({ workspaceId }),
    options: {
      method: "PUT",
      token,
      body: JSON.stringify({ apiKey }),
    },
  });

  return ashbyIntegrationStatusResponseSchema.parse(payload);
}

/** Admin only: removes the key and turns Ashby off for every member. */
export async function removeAshbyKey({
  token,
  workspaceId,
}: {
  token: string;
  workspaceId: string;
}): Promise<z.output<typeof ashbyIntegrationStatusResponseSchema>> {
  return ashbyIntegrationStatusResponseSchema.parse(
    await apiFetch({ path: ashbyPath({ workspaceId }), options: { method: "DELETE", token } }),
  );
}

export async function connectAshby({
  token,
  workspaceId,
}: {
  token: string;
  workspaceId: string;
}): Promise<z.output<typeof ashbyIntegrationStatusResponseSchema>> {
  return ashbyIntegrationStatusResponseSchema.parse(
    await apiFetch({ path: ashbyPath({ workspaceId, suffix: "/connect" }), options: { method: "POST", token } }),
  );
}

export async function disconnectAshby({
  token,
  workspaceId,
}: {
  token: string;
  workspaceId: string;
}): Promise<z.output<typeof ashbyIntegrationStatusResponseSchema>> {
  return ashbyIntegrationStatusResponseSchema.parse(
    await apiFetch({ path: ashbyPath({ workspaceId, suffix: "/disconnect" }), options: { method: "POST", token } }),
  );
}

export async function connectSlack({
  token,
  input = {},
}: {
  token: string;
  input?: { returnTo?: string };
}): Promise<z.output<typeof slackConnectResponseSchema>["authorizationUrl"]> {
  const payload = await apiFetch({
    path: "/integrations/slack/connect",
    options: {
      method: "POST",
      token,
      body: JSON.stringify(input),
    },
  });

  return slackConnectResponseSchema.parse(payload).authorizationUrl;
}

export async function disconnectSlack(token: string): Promise<z.output<typeof slackDisconnectResponseSchema>["ok"]> {
  const payload = await apiFetch({
    path: "/integrations/slack/disconnect",
    options: {
      method: "POST",
      token,
    },
  });

  return slackDisconnectResponseSchema.parse(payload).ok;
}

export async function listSlackChannels(
  token: string,
): Promise<z.output<typeof slackChannelsResponseSchema>["channels"]> {
  const payload = await apiFetch({ path: "/integrations/slack/channels", options: { token } });

  return slackChannelsResponseSchema.parse(payload).channels;
}
export async function getSlackDeliverySettings(
  token: string,
): Promise<z.output<typeof slackDeliverySettingsResponseSchema>["slack"]> {
  const payload = await apiFetch({ path: "/me/slack-delivery", options: { token } });

  return slackDeliverySettingsResponseSchema.parse(payload).slack;
}

export async function updateSlackDeliverySettings({
  token,
  config,
}: {
  token: string;
  config: SlackDeliveryConfig;
}): Promise<z.output<typeof slackDeliverySettingsResponseSchema>["slack"]> {
  const payload = await apiFetch({
    path: "/me/slack-delivery",
    options: {
      method: "PUT",
      token,
      body: JSON.stringify({ config }),
    },
  });

  return slackDeliverySettingsResponseSchema.parse(payload).slack;
}

export async function confirmMeetingAgentToolInvocation({
  token,
  meetingId,
  invocationId,
  signal,
}: {
  token: string;
  meetingId: string;
  invocationId: string;
  signal?: AbortSignal;
}): Promise<z.output<typeof meetingAgentToolInvocationActionResponseSchema>> {
  const payload = await apiFetch({
    path: `/meetings/${meetingId}/agent-tools/${invocationId}/confirm`,
    options: {
      method: "POST",
      token,
      signal,
    },
  });

  return meetingAgentToolInvocationActionResponseSchema.parse(payload);
}

export async function cancelMeetingAgentToolInvocation({
  token,
  meetingId,
  invocationId,
  signal,
}: {
  token: string;
  meetingId: string;
  invocationId: string;
  signal?: AbortSignal;
}): Promise<z.output<typeof meetingAgentToolInvocationActionResponseSchema>> {
  const payload = await apiFetch({
    path: `/meetings/${meetingId}/agent-tools/${invocationId}/cancel`,
    options: {
      method: "POST",
      token,
      signal,
    },
  });

  return meetingAgentToolInvocationActionResponseSchema.parse(payload);
}

export async function connectCalendar({
  token,
  input,
  signal,
}: {
  token: string;
  input: { provider: CalendarProvider; accountKind?: ProviderAccountKind; returnTo?: string; meetingId?: string };
  signal?: AbortSignal;
}): Promise<z.output<typeof calendarConnectResponseSchema>["authorizationUrl"]> {
  const payload = await apiFetch({
    path: "/integrations/calendar/connect",
    options: {
      method: "POST",
      token,
      signal,
      body: JSON.stringify(input),
    },
  });

  return calendarConnectResponseSchema.parse(payload).authorizationUrl;
}

export async function listCalendarAccounts(
  token: string,
): Promise<z.output<typeof calendarAccountsResponseSchema>["accounts"]> {
  const payload = await apiFetch({ path: "/me/calendar/accounts", options: { token } });

  return calendarAccountsResponseSchema.parse(payload).accounts;
}

export async function updateCalendarAccount({
  token,
  accountId,
  input,
}: {
  token: string;
  accountId: string;
  input: { accountKind: ProviderAccountKind };
}): Promise<z.output<typeof updateCalendarAccountResponseSchema>["account"]> {
  const payload = await apiFetch({
    path: `/me/calendar/accounts/${encodeURIComponent(accountId)}`,
    options: {
      method: "PATCH",
      token,
      body: JSON.stringify(input),
    },
  });

  return updateCalendarAccountResponseSchema.parse(payload).account;
}

export async function disconnectCalendar({
  token,
  input,
  signal,
}: {
  token: string;
  input: { provider: CalendarProvider };
  signal?: AbortSignal;
}): Promise<z.output<typeof calendarDisconnectResponseSchema>> {
  const payload = await apiFetch({
    path: "/integrations/calendar/disconnect",
    options: {
      method: "POST",
      token,
      signal,
      body: JSON.stringify(input),
    },
  });

  return calendarDisconnectResponseSchema.parse(payload);
}
export async function deleteCalendarAccountData({
  token,
  accountId,
  input,
}: {
  token: string;
  accountId: string;
  input: { confirmationEmail: string };
}): Promise<z.output<typeof providerDataDeletionResponseSchema>> {
  const payload = await apiFetch({
    path: `/me/calendar/accounts/${encodeURIComponent(accountId)}`,
    options: {
      method: "DELETE",
      token,
      body: JSON.stringify(input),
    },
  });

  return providerDataDeletionResponseSchema.parse(payload);
}

export async function listCalendarEvents({
  token,
  input = {},
}: {
  token: string;
  input?: {
    timeMin?: string;
    timeMax?: string;
    provider?: CalendarProvider;
    /** @external existing wire contract */
    includeCancelled?: boolean;
  };
}): Promise<z.output<typeof calendarEventsResponseSchema>> {
  const searchParams = new URLSearchParams();
  if (input.timeMin !== undefined && input.timeMin !== "") {
    searchParams.set("timeMin", input.timeMin);
  }
  if (input.timeMax !== undefined && input.timeMax !== "") {
    searchParams.set("timeMax", input.timeMax);
  }
  if (input.provider !== undefined) {
    searchParams.set("provider", input.provider);
  }
  if (input.includeCancelled !== undefined) {
    searchParams.set("includeCancelled", String(input.includeCancelled));
  }
  const calendarQuery = searchParams.toString();
  const suffix = calendarQuery === "" ? "" : `?${calendarQuery}`;
  const payload = await apiFetch({ path: `/me/calendar/events${suffix}`, options: { token } });

  return calendarEventsResponseSchema.parse(payload);
}

export async function deleteCalendarEvent({
  token,
  input,
}: {
  token: string;
  input: {
    calendarAccountId: string;
    providerEventId: string;
    calendarId: string;
  };
}): Promise<z.output<typeof deleteCalendarEventResponseSchema>> {
  const searchParams = new URLSearchParams({ calendarId: input.calendarId });
  const payload = await apiFetch({
    path: `/me/calendar/accounts/${encodeURIComponent(input.calendarAccountId)}/events/${encodeURIComponent(input.providerEventId)}?${searchParams.toString()}`,
    options: {
      method: "DELETE",
      token,
    },
  });

  return deleteCalendarEventResponseSchema.parse(payload);
}

export async function addReadyMeetingToCalendarEvent({
  token,
  input,
}: {
  token: string;
  input: {
    calendarAccountId: string;
    providerEventId: string;
    providerRecurringEventId?: string | null;
    calendarId: string;
  };
}): Promise<z.output<typeof addReadyMeetingToCalendarEventResponseSchema>> {
  const payload = await apiFetch({
    path: `/me/calendar/accounts/${encodeURIComponent(input.calendarAccountId)}/events/${encodeURIComponent(input.providerEventId)}/ready-meeting`,
    options: {
      method: "POST",
      token,
      body: JSON.stringify({
        calendarId: input.calendarId,
        providerRecurringEventId: input.providerRecurringEventId ?? null,
      }),
    },
  });

  return addReadyMeetingToCalendarEventResponseSchema.parse(payload);
}

export async function getCalendarEventPrepEstimate({
  token,
  event,
}: {
  token: string;
  event: NormalizedCalendarEvent;
}): Promise<z.output<typeof calendarEventPrepEstimateResponseSchema>> {
  const payload = await apiFetch({
    path: "/me/calendar/prep/estimate",
    options: {
      method: "POST",
      token,
      body: JSON.stringify({ event }),
    },
  });

  return calendarEventPrepEstimateResponseSchema.parse(payload);
}

export async function startCalendarEventPrep({
  token,
  event,
  processor,
}: {
  token: string;
  event: NormalizedCalendarEvent;
  processor?: CalendarEventPrepProcessor;
}): Promise<z.output<typeof calendarEventPrepResponseSchema>> {
  const payload = await apiFetch({
    path: "/me/calendar/prep",
    options: {
      method: "POST",
      token,
      body: JSON.stringify({ event, processor }),
    },
  });

  return calendarEventPrepResponseSchema.parse(payload);
}

export async function getCalendarEventPrep({
  token,
  prepId,
}: {
  token: string;
  prepId: string;
}): Promise<z.output<typeof calendarEventPrepResponseSchema>> {
  const payload = await apiFetch({ path: `/me/calendar/prep/${encodeURIComponent(prepId)}`, options: { token } });

  return calendarEventPrepResponseSchema.parse(payload);
}

export async function logoutAllDevices(token: string): Promise<z.output<typeof logoutAllDevicesResponseSchema>> {
  const payload = await apiFetch({
    path: "/me/logout-all-devices",
    options: {
      method: "POST",
      token,
    },
  });

  return logoutAllDevicesResponseSchema.parse(payload);
}

export async function updateUserProfile({
  token,
  input,
}: {
  token: string;
  input: { displayName: string };
}): Promise<z.output<typeof updateUserProfileResponseSchema>["user"]> {
  const payload = await apiFetch({
    path: "/me/profile",
    options: {
      method: "PATCH",
      token,
      body: JSON.stringify(input),
    },
  });

  return updateUserProfileResponseSchema.parse(payload).user;
}

export async function getMediaPreferences(
  token: string,
): Promise<z.output<typeof mediaPreferencesResponseSchema>["preferences"]> {
  const payload = await apiFetch({ path: "/me/media-preferences", options: { token } });

  return mediaPreferencesResponseSchema.parse(payload).preferences;
}

export async function updateMediaPreferences({
  token,
  input,
  signal,
}: {
  token: string;
  input: {
    /** @external existing wire contract */
    backgroundBlurEnabled: boolean;
  };
  signal?: AbortSignal;
}): Promise<z.output<typeof mediaPreferencesResponseSchema>["preferences"]> {
  const payload = await apiFetch({
    path: "/me/media-preferences",
    options: {
      method: "PATCH",
      token,
      signal,
      body: JSON.stringify(input),
    },
  });

  return mediaPreferencesResponseSchema.parse(payload).preferences;
}

export async function deleteReadyAccount({
  token,
  input,
}: {
  token: string;
  input: { confirmationEmail: string };
}): Promise<z.output<typeof deleteAccountResponseSchema>> {
  const payload = await apiFetch({
    path: "/me/account",
    options: {
      method: "DELETE",
      token,
      body: JSON.stringify(input),
    },
  });

  return deleteAccountResponseSchema.parse(payload);
}

export async function endMeeting({
  token,
  meetingId,
  action = "leave",
  options = {},
}: {
  token: string;
  meetingId: string;
  action?: "leave" | "end_for_all";
  options?: { signal?: AbortSignal };
}): Promise<z.output<typeof endMeetingResponseSchema>> {
  try {
    return endMeetingResponseSchema.parse(
      await apiFetch({
        path: `/meetings/${meetingId}/end`,
        options: {
          method: "POST",
          token,
          body: JSON.stringify({ action }),
          signal: options.signal,
        },
      }),
    );
  } catch (error) {
    const serverErrorStatus = 500;
    if (action !== "end_for_all" || (error instanceof ApiError && error.status < serverErrorStatus)) {
      throw error;
    }
    // Finalization can outlast the POST deadline after the meeting is already ended.
    const confirmationTimeoutMs = 8000;
    const detail = await (async () => {
      try {
        return await getMeeting({
          token,
          meetingId,
          options: { signal: AbortSignal.timeout(confirmationTimeoutMs) },
        });
      } catch (confirmationError) {
        void confirmationError;
        throw error;
      }
    })();
    if (detail.meeting.status !== "ended" || detail.meetingRuntime.activeHumanParticipantCount !== 0) {
      throw error;
    }

    return {
      /** @external meeting end response */
      ok: true,
      /** @external meeting end response */
      finalized: true,
      meeting: detail.meeting,
      meetingRuntime: detail.meetingRuntime,
      postMeetingDisposition: detail.postMeetingDisposition ?? null,
    };
  }
}

export async function startLiveTranscription({
  token,
  meetingId,
  signal,
}: {
  token: string;
  meetingId: string;
  signal?: AbortSignal;
}): Promise<z.output<typeof startedLiveTranscriptionResponseSchema>> {
  return startedLiveTranscriptionResponseSchema.parse(
    await apiFetch({
      path: `/meetings/${meetingId}/live-transcription/start`,
      options: {
        method: "POST",
        token,
        signal,
      },
    }),
  );
}

export async function reportMeetingMediaDiagnostic({
  token,
  meetingId,
  input,
}: {
  token: string;
  meetingId: string;
  input: {
    kind: "camera" | "microphone" | "unknown";
    phase: "join-acquire" | "join-publish" | "room-enable" | "room-device-event";
    failure: "permission-denied" | "not-found" | "device-in-use" | "other";
    errorName?: string;
    errorMessage?: string;
    fallbackErrorName?: string;
    fallbackErrorMessage?: string;
    /** @external existing wire contract */
    selectedDevice: boolean;
    /** @external existing wire contract */
    fallbackAttempted: boolean;
    /** @external existing wire contract */
    recovered: boolean;
  };
}): Promise<z.output<typeof okResponseSchema>> {
  return okResponseSchema.parse(
    await apiFetch({
      path: `/meetings/${meetingId}/media-diagnostics`,
      options: {
        method: "POST",
        token,
        body: JSON.stringify(input),
      },
    }),
  );
}

export type MeetingClientDiagnostic = {
  event:
    | "join-started"
    | "join-media-result"
    | "join-succeeded"
    | "join-failed"
    | "join-bookkeeping-failed"
    | "media-control"
    | "media-device-change"
    | "connection-state"
    | "connection-quality"
    | "track-subscription-failed"
    | "track-stream-state"
    | "audio-playback"
    | "video-playback"
    | "room-disconnected";
  phase: "token" | "acquire" | "connect" | "publish" | "bookkeeping" | "in-room";
  outcome: "started" | "succeeded" | "degraded" | "failed" | "enabled" | "disabled" | "changed";
  kind?: "camera" | "microphone" | "audio-output" | "screen-share" | "screen-share-audio" | "unknown";
  failure?: "permission-denied" | "not-found" | "device-in-use" | "other";
  errorName?: string;
  errorMessage?: string;
  /** @external existing wire contract */
  microphoneRequested?: boolean;
  /** @external existing wire contract */
  cameraRequested?: boolean;
  /** @external existing wire contract */
  microphoneAcquired?: boolean;
  /** @external existing wire contract */
  cameraAcquired?: boolean;
  /** @external existing wire contract */
  microphonePublished?: boolean;
  /** @external existing wire contract */
  cameraPublished?: boolean;
  /** @external existing wire contract */
  microphoneEnabled?: boolean;
  /** @external existing wire contract */
  cameraEnabled?: boolean;
  microphonePermission?: "granted" | "denied" | "prompt" | "unknown" | "unsupported";
  cameraPermission?: "granted" | "denied" | "prompt" | "unknown" | "unsupported";
  /** @external existing wire contract */
  selectedDevice?: boolean;
  connectionState?: "disconnected" | "connecting" | "connected" | "reconnecting" | "signalReconnecting";
  disconnectReason?:
    | "unknown"
    | "client-initiated"
    | "duplicate-identity"
    | "server-shutdown"
    | "participant-removed"
    | "room-deleted"
    | "state-mismatch"
    | "join-failure"
    | "migration"
    | "signal-close"
    | "room-closed"
    | "user-unavailable"
    | "user-rejected"
    | "sip-trunk-failure"
    | "connection-timeout"
    | "media-failure"
    | "agent-error";
  connectionQuality?: "poor" | "lost";
  remoteParticipantIdentity?: string;
  trackSid?: string;
  trackState?: "paused";
  attempt?: number;
  durationMs?: number;
};

export async function reportMeetingClientDiagnostic({
  token,
  meetingId,
  input,
  options = {},
}: {
  token: string;
  meetingId: string;
  input: MeetingClientDiagnostic;
  options?: {
    /** @external fetch RequestInit keepalive */
    keepalive?: boolean;
  };
}): Promise<z.output<typeof okResponseSchema>> {
  return okResponseSchema.parse(
    await apiFetch({
      path: `/meetings/${meetingId}/client-diagnostics`,
      options: {
        method: "POST",
        token,
        body: JSON.stringify(input),
        keepalive: options.keepalive,
      },
    }),
  );
}

// A stalled upload is abandoned after five seconds and never retried. The
// diagnostics queue keeps one upload in flight and holds later reports.
export async function reportMeetingMediaQuality({
  token,
  meetingId,
  reports,
  options = {},
}: {
  token: string;
  meetingId: string;
  reports: MediaQualityDiagnostic[];
  options?: {
    /** @external fetch RequestInit keepalive */
    keepalive?: boolean;
  };
}): Promise<z.output<typeof okResponseSchema>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), mediaQualityUploadTimeoutMs);
  try {
    return okResponseSchema.parse(
      await apiFetch({
        path: `/meetings/${meetingId}/media-quality`,
        options: {
          method: "POST",
          token,
          body: JSON.stringify({ reports }),
          keepalive: options.keepalive,
          signal: controller.signal,
        },
      }),
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function deleteMeeting({
  token,
  meetingId,
}: {
  token: string;
  meetingId: string;
}): Promise<z.output<typeof deleteMeetingResponseSchema>> {
  return deleteMeetingResponseSchema.parse(
    await apiFetch({
      path: `/meetings/${meetingId}`,
      options: {
        method: "DELETE",
        token,
      },
    }),
  );
}

export async function getMyAgentSettings(input: {
  token: string;
  signal?: AbortSignal;
}): Promise<z.output<typeof agentSettingsResponseSchema>> {
  const payload = await apiFetch({ path: "/me/agent", options: input });

  return agentSettingsResponseSchema.parse(payload);
}

// --- Workspace administration ---

export async function getMyWorkspace(token: string): Promise<z.output<typeof myWorkspaceResponseSchema>> {
  const payload = await apiFetch({ path: "/me/workspace", options: { token } });

  return myWorkspaceResponseSchema.parse(payload);
}

export async function createWorkspace({
  token,
  name,
}: {
  token: string;
  name: string;
}): Promise<z.output<typeof createWorkspaceResponseSchema>["workspace"]> {
  const payload = await apiFetch({
    path: "/workspaces",
    options: {
      method: "POST",
      token,
      body: JSON.stringify({ name }),
    },
  });

  return createWorkspaceResponseSchema.parse(payload).workspace;
}

export async function setActiveWorkspace({
  token,
  workspaceId,
}: {
  token: string;
  workspaceId: string;
}): Promise<void> {
  await apiFetch({
    path: "/me/workspace/active",
    options: {
      method: "POST",
      token,
      body: JSON.stringify({ workspaceId }),
    },
  });
}

export async function getWorkspaceSettings({
  token,
  workspaceId,
}: {
  token: string;
  workspaceId: string;
}): Promise<z.output<typeof workspaceSettingsResponseSchema>["workspace"]> {
  const payload = await apiFetch({ path: `/workspaces/${workspaceId}/settings`, options: { token } });

  return workspaceSettingsResponseSchema.parse(payload).workspace;
}

export async function updateWorkspaceSettings({
  token,
  workspaceId,
  input,
}: {
  token: string;
  workspaceId: string;
  input: { name?: string; isLiveSummaryEnabled?: boolean; isAmbientContextEnabled?: boolean };
}): Promise<z.output<typeof workspaceSettingsResponseSchema>["workspace"]> {
  const payload = await apiFetch({
    path: `/workspaces/${workspaceId}/settings`,
    options: {
      method: "PATCH",
      token,
      body: JSON.stringify(input),
    },
  });

  return workspaceSettingsResponseSchema.parse(payload).workspace;
}

export async function deleteWorkspace({
  token,
  workspaceId,
  input,
}: {
  token: string;
  workspaceId: string;
  input: { confirmationName: string };
}): Promise<z.output<typeof deleteWorkspaceResponseSchema>> {
  const payload = await apiFetch({
    path: `/workspaces/${workspaceId}`,
    options: {
      method: "DELETE",
      token,
      body: JSON.stringify(input),
    },
  });

  return deleteWorkspaceResponseSchema.parse(payload);
}

export async function uploadWorkspaceLogo({
  token,
  workspaceId,
  dataUrl,
}: {
  token: string;
  workspaceId: string;
  dataUrl: string;
}): Promise<z.output<typeof workspaceSettingsResponseSchema>["workspace"]> {
  const payload = await apiFetch({
    path: `/workspaces/${workspaceId}/logo`,
    options: {
      method: "PUT",
      token,
      body: JSON.stringify({ dataUrl }),
    },
  });

  return workspaceSettingsResponseSchema.parse(payload).workspace;
}

export async function removeWorkspaceLogo({
  token,
  workspaceId,
}: {
  token: string;
  workspaceId: string;
}): Promise<z.output<typeof workspaceSettingsResponseSchema>["workspace"]> {
  const payload = await apiFetch({
    path: `/workspaces/${workspaceId}/logo`,
    options: {
      method: "DELETE",
      token,
    },
  });

  return workspaceSettingsResponseSchema.parse(payload).workspace;
}

export async function getWorkspaceAdminMembers({
  token,
  workspaceId,
}: {
  token: string;
  workspaceId: string;
}): Promise<z.output<typeof workspaceMembersResponseSchemaV2>> {
  const payload = await apiFetch({ path: `/workspaces/${workspaceId}/settings/members`, options: { token } });

  return workspaceMembersResponseSchemaV2.parse(payload);
}

export async function transferWorkspaceOwnership({
  token,
  workspaceId,
  targetUserId,
}: {
  token: string;
  workspaceId: string;
  targetUserId: string;
}): Promise<z.output<typeof workspaceMemberActionResponseSchema>["member"]> {
  const payload = await apiFetch({
    path: `/workspaces/${workspaceId}/ownership/transfer`,
    options: {
      method: "POST",
      token,
      body: JSON.stringify({ targetUserId }),
    },
  });

  return workspaceMemberActionResponseSchema.parse(payload).member;
}

export async function getWorkspaceMemberBilling({
  token,
  workspaceId,
}: {
  token: string;
  workspaceId: string;
}): Promise<z.output<typeof workspaceMemberBillingResponseSchema>["billing"]> {
  const payload = await apiFetch({ path: `/workspaces/${workspaceId}/billing/me`, options: { token } });

  return workspaceMemberBillingResponseSchema.parse(payload).billing;
}

export async function getWorkspaceBilling({
  token,
  workspaceId,
}: {
  token: string;
  workspaceId: string;
}): Promise<z.output<typeof workspaceBillingSummaryResponseSchema>["billing"]> {
  const payload = await apiFetch({ path: `/workspaces/${workspaceId}/billing`, options: { token } });

  return workspaceBillingSummaryResponseSchema.parse(payload).billing;
}

export async function startWorkspaceBillingCheckout({
  token,
  workspaceId,
  interval,
  plan = "pro",
}: {
  token: string;
  workspaceId: string;
  interval: "month" | "year";
  plan?: "pro" | "max";
}): Promise<z.output<typeof billingRedirectResponseSchema>["url"]> {
  const payload = await apiFetch({
    path: `/workspaces/${workspaceId}/billing/checkout`,
    options: {
      token,
      method: "POST",
      body: JSON.stringify(billingCheckoutRequestSchema.parse({ interval, plan })),
    },
  });

  return billingRedirectResponseSchema.parse(payload).url;
}

export async function confirmWorkspaceBillingCheckout({
  token,
  workspaceId,
  sessionId,
}: {
  token: string;
  workspaceId: string;
  sessionId: string;
}): Promise<z.output<typeof billingCheckoutConfirmationResponseSchema>> {
  const payload = await apiFetch({
    path: `/workspaces/${workspaceId}/billing/checkout/confirm`,
    options: {
      token,
      method: "POST",
      body: JSON.stringify(billingCheckoutConfirmationRequestSchema.parse({ sessionId })),
    },
  });

  return billingCheckoutConfirmationResponseSchema.parse(payload);
}

export async function startWorkspaceCreditTopup({
  token,
  workspaceId,
  credits,
}: {
  token: string;
  workspaceId: string;
  credits: number;
}): Promise<z.output<typeof billingRedirectResponseSchema>["url"]> {
  const payload = await apiFetch({
    path: `/workspaces/${workspaceId}/billing/topup`,
    options: {
      token,
      method: "POST",
      body: JSON.stringify(billingTopupRequestSchema.parse({ credits })),
    },
  });

  return billingRedirectResponseSchema.parse(payload).url;
}

export async function openWorkspaceBillingPortal({
  token,
  workspaceId,
}: {
  token: string;
  workspaceId: string;
}): Promise<z.output<typeof billingRedirectResponseSchema>["url"]> {
  const payload = await apiFetch({
    path: `/workspaces/${workspaceId}/billing/portal`,
    options: {
      token,
      method: "POST",
      body: JSON.stringify({}),
    },
  });

  return billingRedirectResponseSchema.parse(payload).url;
}

export async function inviteWorkspaceMembers({
  token,
  workspaceId,
  input,
}: {
  token: string;
  workspaceId: string;
  input: { emails: string[]; role: "admin" | "member" };
}): Promise<z.output<typeof inviteWorkspaceMembersResponseSchema>> {
  const payload = await apiFetch({
    path: `/workspaces/${workspaceId}/invitations`,
    options: {
      method: "POST",
      token,
      body: JSON.stringify(input),
    },
  });

  return inviteWorkspaceMembersResponseSchema.parse(payload);
}

export async function updateWorkspaceMemberRole({
  token,
  workspaceId,
  targetUserId,
  role,
}: {
  token: string;
  workspaceId: string;
  targetUserId: string;
  role: "admin" | "member";
}): Promise<z.output<typeof workspaceMemberActionResponseSchema>["member"]> {
  const payload = await apiFetch({
    path: `/workspaces/${workspaceId}/members/${targetUserId}`,
    options: {
      method: "PATCH",
      token,
      body: JSON.stringify({ role }),
    },
  });

  return workspaceMemberActionResponseSchema.parse(payload).member;
}

export async function suspendWorkspaceMember({
  token,
  workspaceId,
  targetUserId,
}: {
  token: string;
  workspaceId: string;
  targetUserId: string;
}): Promise<z.output<typeof workspaceMemberActionResponseSchema>["member"]> {
  const payload = await apiFetch({
    path: `/workspaces/${workspaceId}/members/${targetUserId}/suspend`,
    options: {
      method: "POST",
      token,
    },
  });

  return workspaceMemberActionResponseSchema.parse(payload).member;
}

export async function restoreWorkspaceMember({
  token,
  workspaceId,
  targetUserId,
  role,
}: {
  token: string;
  workspaceId: string;
  targetUserId: string;
  role: "admin" | "member";
}): Promise<z.output<typeof workspaceMemberActionResponseSchema>["member"]> {
  const payload = await apiFetch({
    path: `/workspaces/${workspaceId}/members/${targetUserId}/restore`,
    options: {
      method: "POST",
      token,
      body: JSON.stringify({ role }),
    },
  });

  return workspaceMemberActionResponseSchema.parse(payload).member;
}

export async function removeWorkspaceMember({
  token,
  workspaceId,
  targetUserId,
}: {
  token: string;
  workspaceId: string;
  targetUserId: string;
}): Promise<z.output<typeof removeWorkspaceMemberResponseSchema>> {
  const payload = await apiFetch({
    path: `/workspaces/${workspaceId}/members/${targetUserId}`,
    options: {
      method: "DELETE",
      token,
    },
  });

  return removeWorkspaceMemberResponseSchema.parse(payload);
}

export async function resendWorkspaceInvitation({
  token,
  workspaceId,
  invitationId,
}: {
  token: string;
  workspaceId: string;
  invitationId: string;
}): Promise<z.output<typeof workspaceInvitationActionResponseSchema>["invitation"]> {
  const payload = await apiFetch({
    path: `/workspaces/${workspaceId}/invitations/${invitationId}/resend`,
    options: {
      method: "POST",
      token,
    },
  });

  return workspaceInvitationActionResponseSchema.parse(payload).invitation;
}

export async function revokeWorkspaceInvitation({
  token,
  workspaceId,
  invitationId,
}: {
  token: string;
  workspaceId: string;
  invitationId: string;
}): Promise<z.output<typeof revokeWorkspaceInvitationResponseSchema>> {
  const payload = await apiFetch({
    path: `/workspaces/${workspaceId}/invitations/${invitationId}`,
    options: {
      method: "DELETE",
      token,
    },
  });

  return revokeWorkspaceInvitationResponseSchema.parse(payload);
}

export async function getWorkspaceInvitationInfo(
  inviteToken: string,
): Promise<z.output<typeof workspaceInvitationPublicInfoResponseSchema>["invitation"]> {
  const payload = await apiFetch({ path: `/invitations/${inviteToken}`, options: {} });

  return workspaceInvitationPublicInfoResponseSchema.parse(payload).invitation;
}

export async function acceptWorkspaceInvitation({
  token,
  inviteToken,
}: {
  token: string;
  inviteToken: string;
}): Promise<z.output<typeof acceptWorkspaceInvitationResponseSchema>> {
  const payload = await apiFetch({
    path: `/invitations/${inviteToken}/accept`,
    options: {
      method: "POST",
      token,
    },
  });

  return acceptWorkspaceInvitationResponseSchema.parse(payload);
}

// Relationship memory is always fetched within the current user's workspace.
export async function getMemoryStatus({
  token,
  workspaceId,
}: {
  token: string;
  workspaceId: string;
}): Promise<z.output<typeof memoryStatusSchema>> {
  return memoryStatusSchema.parse(
    await apiFetch({ path: `/workspaces/${workspaceId}/memory/status`, options: { token } }),
  );
}
export async function saveMemorySettings({
  token,
  workspaceId,
  preferences,
}: {
  token: string;
  workspaceId: string;
  preferences: MemoryPreferences;
}): Promise<z.output<typeof memoryPreferencesResponseSchema>> {
  return memoryPreferencesResponseSchema.parse(
    await apiFetch({
      path: `/workspaces/${workspaceId}/memory/preferences`,
      options: {
        token,
        method: "PUT",
        body: JSON.stringify(preferences),
      },
    }),
  );
}
export async function listMemories({
  token,
  workspaceId,
  filters,
  signal,
}: {
  token: string;
  workspaceId: string;
  filters: Record<string, string>;
  signal?: AbortSignal;
}): Promise<z.output<typeof memoryListPageSchema>> {
  return memoryListPageSchema.parse(
    await apiFetch({
      path: `/workspaces/${workspaceId}/memory?${new URLSearchParams(filters)}`,
      options: {
        token,
        signal,
      },
    }),
  );
}
export async function syncMemories({
  token,
  workspaceId,
  request,
  signal,
}: {
  token: string;
  workspaceId: string;
  request: { filters: Record<string, string>; cursor: string; through: string | null };
  signal?: AbortSignal;
}): Promise<z.output<typeof memoryListChangesSchema>> {
  return memoryListChangesSchema.parse(
    await apiFetch({
      path: `/workspaces/${workspaceId}/memory/sync`,
      options: {
        token,
        signal,
        method: "POST",
        body: JSON.stringify(request),
      },
    }),
  );
}
export async function getMemoryPeople({
  token,
  workspaceId,
  signal,
  filters = {},
}: {
  token: string;
  workspaceId: string;
  signal?: AbortSignal;
  filters?: Record<string, string>;
}): Promise<z.output<typeof memoryPeoplePageSchema>> {
  return memoryPeoplePageSchema.parse(
    await apiFetch({
      path: `/workspaces/${workspaceId}/memory/people?${new URLSearchParams({ ...filters, paged: "1" })}`,
      options: { token, signal },
    }),
  );
}
export async function getMemoryPerson({
  token,
  workspaceId,
  personId,
}: {
  token: string;
  workspaceId: string;
  personId: string;
}): Promise<z.output<typeof memoryPersonResponseSchema>> {
  return memoryPersonResponseSchema.parse(
    await apiFetch({ path: `/workspaces/${workspaceId}/memory/people/${personId}`, options: { token } }),
  );
}
export async function updateMemories({
  token,
  workspaceId,
  ids,
  action,
}: {
  token: string;
  workspaceId: string;
  ids: string[];
  action: "forget";
}): Promise<z.output<typeof okResponseSchema>> {
  return okResponseSchema.parse(
    await apiFetch({
      path: `/workspaces/${workspaceId}/memory/actions`,
      options: {
        token,
        method: "POST",
        body: JSON.stringify({ ids, action }),
      },
    }),
  );
}
export async function getMemoryEvidence({
  token,
  workspaceId,
  memoryId,
}: {
  token: string;
  workspaceId: string;
  memoryId: string;
}): Promise<z.output<typeof memoryEvidenceResponseSchema>> {
  return memoryEvidenceResponseSchema.parse(
    await apiFetch({ path: `/workspaces/${workspaceId}/memory/${memoryId}`, options: { token } }),
  );
}

export async function getAshbyReview({
  token,
  meetingId,
}: {
  token: string;
  meetingId: string;
}): Promise<z.output<typeof ashbyReviewResponseSchema>> {
  return ashbyReviewResponseSchema.parse(
    await apiFetch({ path: `/meetings/${meetingId}/ashby-review`, options: { token } }),
  );
}
export async function updateAshbyReview({
  token,
  meetingId,
  action,
}: {
  token: string;
  meetingId: string;
  action: AshbyReviewAction;
}): Promise<z.output<typeof ashbyReviewResponseSchema>["review"]> {
  return ashbyReviewResponseSchema.parse(
    await apiFetch({
      path: `/meetings/${meetingId}/ashby-review`,
      options: {
        token,
        method: "POST",
        body: JSON.stringify(action),
      },
    }),
  ).review;
}

export async function prepareSlackSalesChannel(
  token: string,
): Promise<z.output<typeof slackCreateChannelResponseSchema>["channel"]> {
  const payload = await apiFetch({ path: "/integrations/slack/sales-channel", options: { method: "POST", token } });

  return slackCreateChannelResponseSchema.parse(payload).channel;
}
export async function actOnSlackReview({
  token,
  meetingId,
  action,
  body = {},
}: {
  token: string;
  meetingId: string;
  action: "prepare" | "revise" | "confirm" | "dismiss";
  body?: {
    version?: number;
    instruction?: string;
    /** @external existing wire contract */
    refresh?: boolean;
  };
}): Promise<z.output<typeof slackMeetingReviewResponseSchema>["review"]> {
  const payload = await apiFetch({
    path: `/meetings/${meetingId}/slack-review/${action}`,
    options: {
      method: "POST",
      token,
      body: JSON.stringify(body),
    },
  });

  return slackMeetingReviewResponseSchema.parse(payload).review;
}

export async function getMeetingTracker({
  token,
  meetingId,
  signal,
}: {
  token: string;
  meetingId: string;
  signal?: AbortSignal;
}): Promise<MeetingTrackerState> {
  return meetingTrackerStateSchema.parse(
    await apiFetch({ path: `/meetings/${meetingId}/tracker`, options: { token, signal } }),
  );
}
