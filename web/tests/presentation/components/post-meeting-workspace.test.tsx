import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { meetingNotesViewResponseSchema, userSchema } from "@readymeet/shared";
import { environmentManager, focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, type RenderResult } from "@testing-library/react";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import { SessionProvider } from "next-auth/react";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import {
  markWorkspaceNotesRevealPending,
  WORKSPACE_END_MEETING_REVEAL_COMPLETE_EVENT,
  WORKSPACE_END_MEETING_REVEAL_COMPLETE_KEY,
  WORKSPACE_END_MEETING_TRANSITION_KEY,
} from "../../../composition/workspace-transition";
import { buildDebugWorkspaceTaskList } from "../../../domain/debug-workspace-video-sequence";
import {
  meetingDetailQueryKey,
  meetingLinearTaskReviewQueryKey,
  meetingNotesViewQueryKey,
} from "../../../domain/query-keys";
import { AuthProvider } from "../../../presentation/components/auth-provider";
import { type MeetingLoadFailure, PostMeetingWorkspace } from "../../../presentation/components/post-meeting-workspace";
import { RealtimeClientProvider } from "../../../presentation/components/realtime-provider";
import { ToastProvider } from "../../../presentation/components/toast-provider";
import { WorkspaceShell } from "../../../presentation/components/workspace-shell";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const meetingId = "11111111-1111-4111-8111-111111111111";
const hostId = "22222222-2222-4222-8222-222222222222";
const attendeeId = "33333333-3333-4333-8333-333333333333";
const now = "2026-09-17T10:00:00.000Z";

const HTTP_STATUS_OK = 200;
const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_NOT_FOUND = 404;
const HTTP_STATUS_INTERNAL_ERROR = 500;
const HTTP_STATUS_UNAVAILABLE = 503;
const BROWSER_DEFAULT_QUERY_RETRIES = 3;

const END_MEETING_OVERLAY_WAIT_MS = 5_000;
const REVEAL_TICK_FIRST_MS = 680;
const REVEAL_TICK_SECOND_MS = 420;
const REVEAL_TICK_THIRD_MS = 420;
const REVEAL_TICK_FINAL_MS = 160;
const REVEAL_ANIMATION_TICKS_MS = [
  REVEAL_TICK_FIRST_MS,
  REVEAL_TICK_SECOND_MS,
  REVEAL_TICK_THIRD_MS,
  REVEAL_TICK_FINAL_MS,
] as const;
const TIMER_TICK_MS = 1;
const NOTES_REVEAL_WAIT_MS = 2_000;
const REJOIN_LINK_WAIT_MS = 10_000;
const LOCKED_NOTES_POLL_MS = 2_001;
const STALLED_PREVIEW_POLL_ITERATIONS = 145;
const STALLED_PREVIEW_POLL_INTERVAL_MS = 5_001;
const STALLED_PREVIEW_MIN_EXTRA_READS = 100;
const STALLED_PREVIEW_DEADLINE_ITERATIONS = 10;
const STALLED_PREVIEW_DEADLINE_INTERVAL_MS = 30_001;
const POLLING_STOP_WAIT_MS = 10_000;
const TRIAL_MEETINGS_REMAINING_CAP = 3;
const TRIAL_MEETING_INDEX_FIRST = 0;
const TRIAL_MEETING_INDEX_SECOND = 1;
const TRIAL_MEETING_INDEX_THIRD = 2;
const TRIAL_MEETING_INDEX_FOURTH = 3;
const TRIAL_MEETINGS_COMPLETED_INDICES = [
  TRIAL_MEETING_INDEX_FIRST,
  TRIAL_MEETING_INDEX_SECOND,
  TRIAL_MEETING_INDEX_THIRD,
  TRIAL_MEETING_INDEX_FOURTH,
] as const;
const CACHED_PLAN_FIRST_VISIT = 1;
const CACHED_PLAN_SECOND_VISIT = 2;
const EXPECTED_PLAN_CHECKS_AFTER_REVISIT = 2;
const TEST_SESSION_EXPIRES = "2099-01-01";

const POST_MEETING_WORKSPACE_TEST_COPY = {
  unableToLoadMeeting: "Unable to load this meeting.",
  meetingDocument: "Meeting document",
  meetingRequestFailed: "Meeting request failed",
  meetingNotesLockedCode: "meeting_notes_locked",
  meetingNotesLockedMessage: "Meeting notes are locked.",
  billingRequestNotCaptured: "Billing request was not captured",
  billingUnavailable: "Unavailable",
  meetingTooShortMessage: "Meeting was too short to process.",
  copyTranscriptShortcutCode: "KeyC",
  copyTranscriptShortcutKey: "C",
  tryAgainButton: "Try again",
  backToWorkspaceButton: "Back to workspace",
  upgradeToProButton: "Upgrade to Pro",
  meetingActionsButton: "Meeting actions",
  copyTranscriptMenuPattern: /Copy transcript/,
  recoveredMeetingTitle: "Recovered meeting",
  recoveredNotesLabel: "Recovered notes are visible.",
  meetingStillInProgress: "Meeting is still in progress",
  rejoinMeetingLink: "Rejoin meeting",
  customerPilotTitle: "Customer pilot",
  preparingYourNotes: "Preparing your notes",
  pilotPreparationLine: "The pilot starts next Tuesday.",
  launchPilotLabel: "Launch the pilot on Tuesday.",
  cachedNotesSnippet: "Cached notes appear immediately.",
  checkingYourPlan: "Checking your plan…",
  missingMeetingLoadFailure: "Expected a meeting load failure",
  missingUpgradePreview: "Expected meeting notes upgrade preview",
} as const;

const paidBilling = {
  plan: "business",
  /** @external billing fixture wire field */
  subscriptionActive: false,
  allowanceCredits: 0,
  allowanceUsed: 0,
  allowanceRemaining: 0,
  allowanceWindowEnd: null,
  poolBalance: 0,
  /** @external billing fixture wire field */
  trialEligible: false,
  trialCreditsUsed: 0,
  /** @external billing fixture wire field */
  hasTrialCredits: false,
  trialMeetingsRemaining: 0,
};

const testInviteeUser = userSchema.parse({
  id: attendeeId,
  email: "invitee@example.test",
  displayName: "Invitee",
  workspaceId: attendeeId,
  source: "auth",
  plan: "business",
  avatarUrl: null,
  createdAt: "2026-01-01T00:00:00Z",
});

// Cross-tab sync is not under test here; an inert channel keeps happy-dom from echoing cache broadcasts.
class InertBroadcastChannel extends EventTarget {
  constructor(public name: string) {
    super();
  }

  postMessage(_message: unknown) {}

  close() {}
}

function installMockBroadcastChannel(t: TestContext) {
  // happy-dom exposes BroadcastChannel as a lazy accessor, which t.mock.method cannot replace.
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "BroadcastChannel");
  Object.defineProperty(globalThis, "BroadcastChannel", {
    configurable: true,
    writable: true,
    value: InertBroadcastChannel,
  });
  t.after(() => {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, "BroadcastChannel", originalDescriptor);
    }
  });
}

function installPostMeetingTimerMocks(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.parse(now) });
  t.mock.method(window, "setTimeout", globalThis.setTimeout);
  t.mock.method(window, "clearTimeout", globalThis.clearTimeout);
}

function resolveFetchUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (input instanceof Request) {
    return input.url;
  }

  return "";
}

function createQueryClientWithCleanup(t: TestContext) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  t.after(() => {
    cleanup();
    client.clear();
    window.sessionStorage.clear();
  });

  return client;
}

function buildInviteeSession() {
  return {
    expires: TEST_SESSION_EXPIRES,
    apiToken: "test-token",
    appUser: testInviteeUser,
  };
}

function requiredHtmlButtonElement(input: { element: Element; label: string }): HTMLButtonElement {
  if (!(input.element instanceof HTMLButtonElement)) {
    throw new Error(input.label);
  }

  return input.element;
}

function assertTextPresent(input: { screen: { queryByText: (text: string) => Element | null }; text: string }) {
  assert.notEqual(input.screen.queryByText(input.text), null);
}

function assertRoleButtonPresent(input: { screen: RenderResult; name: string }) {
  assert.notEqual(input.screen.queryByRole("button", { name: input.name }), null);
}

function appendNavigation(input: { navigations: string[]; href: string }): string[] {
  return [...input.navigations, input.href];
}

function appendReadyId(input: { ready: string[]; id: string }): string[] {
  return [...input.ready, input.id];
}

function appendFailure(input: {
  failures: (MeetingLoadFailure | null)[];
  failure: MeetingLoadFailure | null;
}): (MeetingLoadFailure | null)[] {
  return [...input.failures, input.failure];
}

function appendRequest(input: { requests: string[]; url: string }): string[] {
  return [...input.requests, input.url];
}

function appendCopied(input: { copied: string[]; text: string }): string[] {
  return [...input.copied, input.text];
}

function requiredMeetingLoadFailure(failure: MeetingLoadFailure | null | undefined): MeetingLoadFailure {
  if (failure === undefined || failure === null) {
    throw new Error(POST_MEETING_WORKSPACE_TEST_COPY.missingMeetingLoadFailure);
  }

  return failure;
}

function pressCopyTranscriptShortcut() {
  fireEvent.keyDown(window, {
    code: POST_MEETING_WORKSPACE_TEST_COPY.copyTranscriptShortcutCode,
    key: POST_MEETING_WORKSPACE_TEST_COPY.copyTranscriptShortcutKey,
    /** @external keyboard event wire field */
    altKey: true,
    /** @external keyboard event wire field */
    shiftKey: true,
  });
}

function renderShellRevealTree(input: {
  client: QueryClient;
  isReady: boolean;
  hasFailed: boolean;
  onNavigate: (href: string) => void;
  onRetry: () => void;
}) {
  return (
    <AppRouterContext.Provider
      value={{
        push: (href) => {
          input.onNavigate(href);
        },
        replace() {},
        refresh() {},
        back() {},
        forward() {},
        prefetch: () => {},
      }}
    >
      <PathnameContext.Provider value={`/workspace/${meetingId}`}>
        <SearchParamsContext.Provider value={new URLSearchParams()}>
          <SessionProvider session={null}>
            <AuthProvider>
              <QueryClientProvider client={input.client}>
                <ToastProvider>
                  <WorkspaceShell
                    meetings={[]}
                    endMeetingContentReady={input.isReady}
                    endMeetingLoadFailure={
                      input.hasFailed
                        ? {
                            message: POST_MEETING_WORKSPACE_TEST_COPY.unableToLoadMeeting,
                            retry: input.onRetry,
                          }
                        : null
                    }
                  >
                    <div>{POST_MEETING_WORKSPACE_TEST_COPY.meetingDocument}</div>
                  </WorkspaceShell>
                </ToastProvider>
              </QueryClientProvider>
            </AuthProvider>
          </SessionProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>
  );
}

async function runPostCallShellRevealTest(input: { isReducedMotion: boolean; t: TestContext }) {
  const { isReducedMotion, t } = input;
  installMockBroadcastChannel(t);
  installPostMeetingTimerMocks(t);
  const matchMedia = window.matchMedia.bind(window);
  t.mock.method(window, "matchMedia", (query: string) => {
    const media = matchMedia(query);
    if (query === "(prefers-reduced-motion: reduce)") {
      Object.defineProperty(media, "matches", { value: isReducedMotion });
    }

    return media;
  });
  const client = createQueryClientWithCleanup(t);
  window.sessionStorage.setItem(WORKSPACE_END_MEETING_TRANSITION_KEY, "1");
  window.sessionStorage.removeItem(WORKSPACE_END_MEETING_REVEAL_COMPLETE_KEY);
  const retries = { count: 0 };
  const navigationLog = { hrefs: [] as string[] };
  const renderContent = (shellInput: { isReady: boolean; hasFailed?: boolean }) =>
    renderShellRevealTree({
      client,
      isReady: shellInput.isReady,
      hasFailed: shellInput.hasFailed ?? false,
      onNavigate: (href) => {
        navigationLog.hrefs = appendNavigation({ navigations: navigationLog.hrefs, href });
      },
      onRetry: () => {
        retries.count += 1;
      },
    });
  const screen = render(renderContent({ isReady: false }));
  await act(async () => t.mock.timers.tick(END_MEETING_OVERLAY_WAIT_MS));
  assert.ok(screen.container.querySelector(".live-end-meeting-overlay"));
  assert.equal(screen.container.querySelector(".is-end-meeting-background-revealed"), null);
  assert.equal(window.sessionStorage.getItem(WORKSPACE_END_MEETING_REVEAL_COMPLETE_KEY), null);
  screen.rerender(renderContent({ isReady: false, hasFailed: true }));
  assertTextPresent({ screen, text: POST_MEETING_WORKSPACE_TEST_COPY.unableToLoadMeeting });
  fireEvent.click(screen.getByRole("button", { name: POST_MEETING_WORKSPACE_TEST_COPY.tryAgainButton }));
  assert.equal(retries.count, 1);
  assertRoleButtonPresent({ screen, name: POST_MEETING_WORKSPACE_TEST_COPY.backToWorkspaceButton });
  await act(async () => t.mock.timers.tick(END_MEETING_OVERLAY_WAIT_MS));
  assert.equal(window.sessionStorage.getItem(WORKSPACE_END_MEETING_REVEAL_COMPLETE_KEY), null);
  assert.equal(screen.container.querySelector(".is-end-meeting-background-revealed"), null);
  assert.deepEqual(navigationLog.hrefs, []);
  screen.rerender(renderContent({ isReady: true }));
  assert.notEqual(screen.container.querySelector(".is-end-meeting-background-revealed"), null);
  await REVEAL_ANIMATION_TICKS_MS.reduce(async (previous, elapsed) => {
    await previous;
    await act(async () => t.mock.timers.tick(elapsed));
  }, Promise.resolve());
  assert.equal(window.sessionStorage.getItem(WORKSPACE_END_MEETING_REVEAL_COMPLETE_KEY), "1");
  assert.equal(screen.container.querySelector(".live-end-meeting-overlay"), null);
  assertTextPresent({ screen, text: POST_MEETING_WORKSPACE_TEST_COPY.meetingDocument });
}

void test("a reload during the post-call transition still releases notes waiting for the shell reveal", async (t) => {
  installMockBroadcastChannel(t);
  installPostMeetingTimerMocks(t);
  const client = createQueryClientWithCleanup(t);
  // The live page marked the notes reveal pending; the shell consumed the transition key, then the tab reloaded.
  markWorkspaceNotesRevealPending(meetingId);
  window.sessionStorage.removeItem(WORKSPACE_END_MEETING_TRANSITION_KEY);
  window.sessionStorage.removeItem(WORKSPACE_END_MEETING_REVEAL_COMPLETE_KEY);
  const revealEvents = { count: 0 };
  const onRevealComplete = () => {
    revealEvents.count += 1;
  };
  window.addEventListener(WORKSPACE_END_MEETING_REVEAL_COMPLETE_EVENT, onRevealComplete);
  t.after(() => {
    window.removeEventListener(WORKSPACE_END_MEETING_REVEAL_COMPLETE_EVENT, onRevealComplete);
  });
  const screen = render(
    renderShellRevealTree({ client, isReady: true, hasFailed: false, onNavigate: () => {}, onRetry: () => {} }),
  );
  await act(async () => {});
  assert.equal(window.sessionStorage.getItem(WORKSPACE_END_MEETING_REVEAL_COMPLETE_KEY), "1");
  assert.ok(revealEvents.count >= 1);
  assert.equal(screen.container.querySelector(".live-end-meeting-overlay"), null);
});

[false, true].forEach((isReducedMotion) => {
  void test(`the post-call shell requires content before revealing (reduced motion: ${isReducedMotion})`, async (t) => {
    await runPostCallShellRevealTest({ isReducedMotion, t });
  });
});

function createRecoveredMeetingDetail() {
  return meetingNotesViewResponseSchema.parse({
    meeting: {
      id: meetingId,
      workspaceId: hostId,
      createdByUserId: hostId,
      viewerRole: "participant",
      title: "Recovered meeting",
      roomName: "pilot",
      status: "ended",
      createdAt: now,
      startedAt: now,
      endedAt: now,
    },
    meetingRuntime: {
      activeHumanParticipantCount: 0,
      activeHumanParticipants: [],
      allHumanParticipants: [],
      isAwaitingMeetingEnd: false,
    },
    transcript: null,
    hasTranscriptSegments: false,
    summary: {
      id: hostId,
      meetingId,
      content: "Overview\n- Recovered notes are visible.",
      model: "test",
      generatedAt: now,
    },
    actionItems: [],
    tasks: null,
  });
}

function renderPostMeetingLoadFailureTree(input: {
  client: QueryClient;
  shouldLeaveWorkspace: boolean;
  onNavigate: (href: string) => void;
  onReady: (id: string) => void;
  onFailure: (failure: MeetingLoadFailure | null) => void;
}) {
  return (
    <AppRouterContext.Provider
      value={{
        push(href) {
          assert.equal(
            window.sessionStorage.getItem(WORKSPACE_END_MEETING_REVEAL_COMPLETE_KEY),
            "1",
            "complete the handoff before navigating",
          );
          input.onNavigate(href);
        },
        replace() {},
        refresh() {},
        back() {},
        forward() {},
        prefetch: () => {},
      }}
    >
      <PathnameContext.Provider value={`/workspace/${meetingId}`}>
        <SearchParamsContext.Provider value={new URLSearchParams()}>
          <SessionProvider session={buildInviteeSession()}>
            <AuthProvider>
              <QueryClientProvider client={input.client}>
                <RealtimeClientProvider session={null} refreshSession={async () => null}>
                  <ToastProvider>
                    <PostMeetingWorkspace
                      meetingId={meetingId}
                      renderShell={input.shouldLeaveWorkspace}
                      onMeetingReady={(id) => input.onReady(id)}
                      onMeetingLoadFailure={(failure) => input.onFailure(failure)}
                    />
                  </ToastProvider>
                </RealtimeClientProvider>
              </QueryClientProvider>
            </AuthProvider>
          </SessionProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>
  );
}

async function runMeetingLoadFailureScenario(input: {
  httpStatus: number;
  shouldLeaveWorkspace: boolean;
  t: TestContext;
}) {
  const { t } = input;
  installMockBroadcastChannel(t);
  installPostMeetingTimerMocks(t);
  const client = createQueryClientWithCleanup(t);
  const detail = createRecoveredMeetingDetail();
  const requestState = { shouldFail: true };
  t.mock.method(globalThis, "fetch", async (fetchInput: RequestInfo | URL) => {
    const url = resolveFetchUrl(fetchInput);
    if (url.endsWith("/billing/me")) {
      return new Response(JSON.stringify({ billing: paidBilling }));
    }
    if (url.endsWith(`/meetings/${meetingId}/notes-view`)) {
      return new Response(
        JSON.stringify(
          requestState.shouldFail ? { message: POST_MEETING_WORKSPACE_TEST_COPY.meetingRequestFailed } : detail,
        ),
        {
          status: requestState.shouldFail ? input.httpStatus : HTTP_STATUS_OK,
        },
      );
    }

    return new Response(
      JSON.stringify(url.endsWith("/meetings") ? { meetings: [] } : { status: "pending", lines: [], source: null }),
      { status: HTTP_STATUS_OK },
    );
  });
  const readyLog = { ids: [] as string[] };
  const failureLog = { items: [] as (MeetingLoadFailure | null)[] };
  const navigationLog = { hrefs: [] as string[] };
  if (input.shouldLeaveWorkspace) {
    markWorkspaceNotesRevealPending(meetingId);
    window.sessionStorage.setItem(WORKSPACE_END_MEETING_TRANSITION_KEY, "1");
    window.sessionStorage.removeItem(WORKSPACE_END_MEETING_REVEAL_COMPLETE_KEY);
  }
  const buildContent = () =>
    renderPostMeetingLoadFailureTree({
      client,
      shouldLeaveWorkspace: input.shouldLeaveWorkspace,
      onNavigate: (href) => {
        navigationLog.hrefs = appendNavigation({ navigations: navigationLog.hrefs, href });
      },
      onReady: (id) => {
        readyLog.ids = appendReadyId({ ready: readyLog.ids, id });
      },
      onFailure: (failure) => {
        failureLog.items = appendFailure({ failures: failureLog.items, failure });
      },
    });
  const renderedHolder = { current: render(buildContent()) };
  await act(async () => {});
  await act(async () => t.mock.timers.tick(TIMER_TICK_MS));
  assert.equal(readyLog.ids.length, 0, "failed and unavailable documents must not complete the transition");
  const failure = requiredMeetingLoadFailure(failureLog.items.at(-1));
  assert.equal(failure.meetingId, meetingId);
  assert.equal(renderedHolder.current.queryByText(POST_MEETING_WORKSPACE_TEST_COPY.recoveredMeetingTitle), null);
  requestState.shouldFail = false;
  if (input.shouldLeaveWorkspace) {
    fireEvent.click(
      renderedHolder.current.getByRole("button", { name: POST_MEETING_WORKSPACE_TEST_COPY.backToWorkspaceButton }),
    );
    assert.deepEqual(navigationLog.hrefs, ["/workspace"]);
    renderedHolder.current.unmount();
    renderedHolder.current = render(buildContent());
    await act(async () => {});
  } else {
    await act(async () => failure.retry());
  }
  await act(async () => t.mock.timers.tick(TIMER_TICK_MS));
  assert.ok(readyLog.ids.includes(meetingId));
  assertTextPresent({ screen: renderedHolder.current, text: POST_MEETING_WORKSPACE_TEST_COPY.recoveredMeetingTitle });
  assert.equal(failureLog.items.at(-1), null);
  if (input.shouldLeaveWorkspace) {
    await act(async () => t.mock.timers.tick(NOTES_REVEAL_WAIT_MS));
    assert.notEqual(renderedHolder.current.queryByText(POST_MEETING_WORKSPACE_TEST_COPY.recoveredNotesLabel), null);
    assert.equal(renderedHolder.current.container.querySelector(".live-end-meeting-overlay"), null);
  }
}

const meetingLoadFailureCases = [
  { httpStatus: HTTP_STATUS_INTERNAL_ERROR, shouldLeaveWorkspace: false },
  { httpStatus: HTTP_STATUS_FORBIDDEN, shouldLeaveWorkspace: false },
  { httpStatus: HTTP_STATUS_NOT_FOUND, shouldLeaveWorkspace: false },
  { httpStatus: HTTP_STATUS_NOT_FOUND, shouldLeaveWorkspace: true },
] as const;

meetingLoadFailureCases.forEach(({ httpStatus, shouldLeaveWorkspace }) => {
  void test(
    shouldLeaveWorkspace
      ? "Back to workspace resolves the handoff before navigation and reopened notes are visible"
      : `a ${httpStatus} load failure is not ready and a successful retry releases the document`,
    async (t) => {
      await runMeetingLoadFailureScenario({ httpStatus, shouldLeaveWorkspace, t });
    },
  );
});

type InviteeScenario = {
  isFreePlan: boolean;
  isStalledPreview: boolean;
  hasStaleAccess: boolean;
};

type InviteeTestContext = {
  client: QueryClient;
  detailState: { current: ReturnType<typeof meetingNotesViewResponseSchema.parse> };
  requestLog: { urls: string[] };
  readyLog: { ids: string[] };
  screen: RenderResult;
  t: TestContext;
};

function createActivePilotDetailState() {
  return {
    current: meetingNotesViewResponseSchema.parse({
      meeting: {
        id: meetingId,
        workspaceId: hostId,
        createdByUserId: hostId,
        viewerRole: "participant",
        title: "Customer pilot",
        roomName: "pilot",
        status: "active",
        createdAt: now,
        startedAt: now,
        endedAt: null,
      },
      meetingRuntime: {
        activeHumanParticipantCount: 1,
        activeHumanParticipants: [],
        allHumanParticipants: [],
        isAwaitingMeetingEnd: true,
      },
      transcript: null,
      hasTranscriptSegments: false,
      summary: null,
      actionItems: [],
      tasks: null,
    }),
  };
}

type MeetingDetailState = ReturnType<typeof meetingNotesViewResponseSchema.parse>;

function installInviteeFetchMock(input: {
  t: TestContext;
  getDetail: () => MeetingDetailState;
  setDetail: (next: MeetingDetailState) => void;
  onRequestUrl: (url: string) => void;
  isFreePlan: boolean;
  isStalledPreview: boolean;
}) {
  input.t.mock.method(globalThis, "fetch", async (fetchInput: RequestInfo | URL) => {
    const url = resolveFetchUrl(fetchInput);
    if (url.endsWith("/billing/me")) {
      return new Response(
        JSON.stringify({ billing: input.isFreePlan ? { ...paidBilling, plan: "free" } : paidBilling }),
      );
    }
    input.onRequestUrl(url);
    if (input.isFreePlan && url.endsWith("/run-snapshot")) {
      const existingDetail = input.getDetail();
      const nextDetail = {
        ...existingDetail,
        notesAccess: {
          /** @external meeting notes access wire field */
          locked: true,
          reason: "upgrade_required" as const,
        },
      };
      input.setDetail(nextDetail);

      return new Response(
        JSON.stringify({
          code: POST_MEETING_WORKSPACE_TEST_COPY.meetingNotesLockedCode,
          message: POST_MEETING_WORKSPACE_TEST_COPY.meetingNotesLockedMessage,
          notesAccess: nextDetail.notesAccess,
        }),
        { status: HTTP_STATUS_FORBIDDEN },
      );
    }
    const currentDetail = input.getDetail();
    if (url.endsWith(`/meetings/${meetingId}`)) {
      return Response.json({
        ...currentDetail,
        transcriptSegments: [
          {
            id: hostId,
            transcriptId: hostId,
            speakerIdentity: "invitee",
            speakerUserId: attendeeId,
            speakerRole: "human",
            speakerName: "Invitee",
            source: "livekit",
            sourceSegmentId: null,
            content: "Launch the pilot on Tuesday.",
            startedAt: now,
            endedAt: now,
          },
        ],
      });
    }
    const payload = url.endsWith("/preparation-preview")
      ? input.isStalledPreview && currentDetail.meeting.status === "ended"
        ? { status: "pending", source: null, lines: [] }
        : { status: "ready", source: "model", lines: [POST_MEETING_WORKSPACE_TEST_COPY.pilotPreparationLine] }
      : url.endsWith(`/meetings/${meetingId}/notes-view`)
        ? currentDetail
        : url.endsWith("/meetings")
          ? { meetings: [] }
          : {};

    return new Response(JSON.stringify(payload), { status: HTTP_STATUS_OK });
  });
}

function setupInviteeTest(input: { scenario: InviteeScenario; t: TestContext }): InviteeTestContext {
  const { scenario, t } = input;
  installMockBroadcastChannel(t);
  installPostMeetingTimerMocks(t);
  t.mock.method(window, "setInterval", globalThis.setInterval);
  t.mock.method(window, "clearInterval", globalThis.clearInterval);
  const client = createQueryClientWithCleanup(t);
  const detailState = createActivePilotDetailState();
  const requestLog = { urls: [] as string[] };
  const readyLog = { ids: [] as string[] };
  installInviteeFetchMock({
    t,
    getDetail: () => detailState.current,
    setDetail: (next) => {
      detailState.current = next;
    },
    onRequestUrl: (url) => {
      requestLog.urls = appendRequest({ requests: requestLog.urls, url });
    },
    isFreePlan: scenario.isFreePlan,
    isStalledPreview: scenario.isStalledPreview,
  });
  client.setQueryData(meetingNotesViewQueryKey(meetingId), detailState.current);
  markWorkspaceNotesRevealPending(meetingId);
  window.sessionStorage.removeItem(WORKSPACE_END_MEETING_REVEAL_COMPLETE_KEY);
  const screen = render(
    <AppRouterContext.Provider
      value={{
        push() {},
        replace() {},
        refresh() {},
        back() {},
        forward() {},
        prefetch: () => {},
      }}
    >
      <SessionProvider session={buildInviteeSession()}>
        <AuthProvider>
          <QueryClientProvider client={client}>
            <RealtimeClientProvider session={null} refreshSession={async () => null}>
              <ToastProvider>
                <PostMeetingWorkspace
                  meetingId={meetingId}
                  renderShell={false}
                  onMeetingReady={(id) => {
                    readyLog.ids = appendReadyId({ ready: readyLog.ids, id });
                  }}
                />
              </ToastProvider>
            </RealtimeClientProvider>
          </QueryClientProvider>
        </AuthProvider>
      </SessionProvider>
    </AppRouterContext.Provider>,
  );

  return { client, detailState, requestLog, readyLog, screen, t };
}

async function assertInviteeActiveMeetingPhase(context: InviteeTestContext) {
  const { screen, readyLog, t } = context;
  await act(async () => {});
  assert.ok(readyLog.ids.includes(meetingId));
  assertTextPresent({ screen, text: POST_MEETING_WORKSPACE_TEST_COPY.meetingStillInProgress });
  assert.equal(screen.queryByText(POST_MEETING_WORKSPACE_TEST_COPY.rejoinMeetingLink), null);
  assert.equal(screen.container.querySelector(".workspace-meeting-preparation-copy"), null);
  await act(async () => {
    window.sessionStorage.setItem(WORKSPACE_END_MEETING_REVEAL_COMPLETE_KEY, "1");
    window.dispatchEvent(new Event(WORKSPACE_END_MEETING_REVEAL_COMPLETE_EVENT));
  });
  assert.equal(
    screen.container.querySelector(".workspace-meeting-preparation-copy")?.getAttribute("aria-label"),
    POST_MEETING_WORKSPACE_TEST_COPY.pilotPreparationLine,
  );
  await act(async () => t.mock.timers.tick(REJOIN_LINK_WAIT_MS));
  assert.equal(
    screen.getByText(POST_MEETING_WORKSPACE_TEST_COPY.rejoinMeetingLink).getAttribute("href"),
    `/meetings/${meetingId}/live`,
  );
}

function applyEndedMeetingDetail(input: { context: InviteeTestContext; scenario: InviteeScenario }) {
  const { context, scenario } = input;
  const { detailState } = context;
  detailState.current = {
    ...detailState.current,
    meeting: { ...detailState.current.meeting, status: "ended", endedAt: now },
    meetingRuntime: {
      ...detailState.current.meetingRuntime,
      isAwaitingMeetingEnd: false,
      activeHumanParticipantCount: 0,
    },
    ...(scenario.isFreePlan
      ? {
          notesAccess: scenario.hasStaleAccess
            ? { locked: false, reason: null }
            : { locked: true, reason: "upgrade_required" as const },
          notesPreview: { status: "pending" as const, content: "" },
          transcript: {
            id: hostId,
            meetingId,
            source: "livekit-postcall",
            mode: "postcall-refined",
            isFinal: true,
            refinedAt: now,
          },
        }
      : {}),
  };
}

async function assertInviteeEndedMeetingPhase(input: { context: InviteeTestContext; scenario: InviteeScenario }) {
  const { context, scenario } = input;
  const { client, detailState, requestLog, screen, t } = context;
  applyEndedMeetingDetail({ context, scenario });
  await act(async () => {
    client.setQueryData(meetingNotesViewQueryKey(meetingId), detailState.current);
    t.mock.timers.tick(TIMER_TICK_MS);
  });
  assert.equal(screen.queryByText(POST_MEETING_WORKSPACE_TEST_COPY.rejoinMeetingLink), null);
  assertTextPresent({ screen, text: POST_MEETING_WORKSPACE_TEST_COPY.preparingYourNotes });
  assert.equal(
    screen.queryByRole("button", { name: POST_MEETING_WORKSPACE_TEST_COPY.upgradeToProButton }),
    null,
    "no upgrade before notes eligibility and preview are ready",
  );
  if (scenario.isFreePlan) {
    assert.equal(screen.container.querySelector(".error-text"), null, "access limits never flash a red error");
    assert.equal(
      requestLog.urls.filter((url) => url.endsWith("/run-snapshot")).length,
      scenario.hasStaleAccess ? 1 : 0,
      "known locks skip generation; stale access is handled without retrying generation",
    );
    const readsBefore = requestLog.urls.filter((url) => url.endsWith(`/meetings/${meetingId}/notes-view`)).length;
    await act(async () => t.mock.timers.tick(LOCKED_NOTES_POLL_MS));
    assert.ok(
      requestLog.urls.filter((url) => url.endsWith(`/meetings/${meetingId}/notes-view`)).length > readsBefore,
      "locked notes keep polling after the transcript is final",
    );
    assert.notEqual(screen.container.querySelector(".workspace-thinking-signal"), null);
  }
}

async function runStalledPreviewBranch(context: InviteeTestContext): Promise<boolean> {
  const { requestLog, screen, t } = context;
  const initialReads = requestLog.urls.filter((url) => url.endsWith(`/meetings/${meetingId}/notes-view`)).length;
  await Array.from({ length: STALLED_PREVIEW_POLL_ITERATIONS }, () => undefined).reduce(async (previous) => {
    await previous;
    await act(async () => t.mock.timers.tick(STALLED_PREVIEW_POLL_INTERVAL_MS));
  }, Promise.resolve());
  const finalReads = requestLog.urls.filter((url) => url.endsWith(`/meetings/${meetingId}/notes-view`)).length;
  assert.ok(finalReads > initialReads + STALLED_PREVIEW_MIN_EXTRA_READS, "Allow normal delayed processing to finish");
  const finalPreparationReads = requestLog.urls.filter((url) => url.endsWith("/preparation-preview")).length;
  await Array.from({ length: STALLED_PREVIEW_DEADLINE_ITERATIONS }, () => undefined).reduce(async (previous) => {
    await previous;
    await act(async () => t.mock.timers.tick(STALLED_PREVIEW_DEADLINE_INTERVAL_MS));
  }, Promise.resolve());
  assert.equal(
    requestLog.urls.filter((url) => url.endsWith(`/meetings/${meetingId}/notes-view`)).length,
    finalReads,
    "Locked previews stop automatic polling when the finite retry budget is exhausted",
  );
  assert.equal(
    requestLog.urls.filter((url) => url.endsWith("/preparation-preview")).length,
    finalPreparationReads,
    "The preparation preview also stops retrying at the deadline",
  );
  assert.equal(screen.queryByRole("button", { name: POST_MEETING_WORKSPACE_TEST_COPY.upgradeToProButton }), null);

  return true;
}

async function completeInviteeNotesReveal(input: { context: InviteeTestContext; scenario: InviteeScenario }) {
  const { context, scenario } = input;
  const { client, detailState, requestLog, screen, t } = context;
  const title = screen.getByText(POST_MEETING_WORKSPACE_TEST_COPY.customerPilotTitle);
  detailState.current = scenario.isFreePlan
    ? {
        ...detailState.current,
        notesPreview: { status: "ready", content: "Overview\n- Launch the pilot on Tuesday." },
      }
    : {
        ...detailState.current,
        summary: {
          id: hostId,
          meetingId,
          content: "Overview\n- Launch the pilot on Tuesday.",
          model: "test",
          generatedAt: now,
        },
      };
  await act(async () => {
    client.setQueryData(meetingNotesViewQueryKey(meetingId), detailState.current);
    t.mock.timers.tick(TIMER_TICK_MS);
  });
  await act(async () => t.mock.timers.tick(NOTES_REVEAL_WAIT_MS));
  assert.notEqual(screen.queryByText(POST_MEETING_WORKSPACE_TEST_COPY.launchPilotLabel), null);
  assert.notEqual(
    screen.container.querySelector(".workspace-flow-snapshot-notes.is-static"),
    null,
    "completed notes stay visible without replaying",
  );
  assert.equal(screen.getByText(POST_MEETING_WORKSPACE_TEST_COPY.customerPilotTitle), title);
  assert.equal(screen.queryByText("Create an account"), null);
  assert.ok(requestLog.urls.some((url) => url.endsWith("/preparation-preview")));
  if (scenario.isFreePlan) {
    assert.equal(screen.container.querySelector(".error-text"), null);
    assert.notEqual(screen.queryByRole("button", { name: POST_MEETING_WORKSPACE_TEST_COPY.upgradeToProButton }), null);
    assert.notEqual(
      screen.container.querySelector(".meeting-notes-upgrade-preview .workspace-flow-snapshot-notes.is-static"),
      null,
      "upgrade appears only once the preview is ready",
    );
    assert.equal(detailState.current.summary, null, "the reveal uses the limited preview, not unlocked notes");
    const reads = requestLog.urls.filter((url) => url.endsWith(`/meetings/${meetingId}/notes-view`)).length;
    await act(async () => t.mock.timers.tick(POLLING_STOP_WAIT_MS));
    assert.equal(
      requestLog.urls.filter((url) => url.endsWith(`/meetings/${meetingId}/notes-view`)).length,
      reads,
      "polling stops once the locked preview is ready",
    );
    assert.equal(
      requestLog.urls.some((url) => url.includes("/tasks/") || url.endsWith("/run-tasks")),
      false,
      "preview does not start paid task polling",
    );
  }
}

async function runInviteeCopyTranscriptFlow(input: { context: InviteeTestContext; scenario: InviteeScenario }) {
  const { context, scenario } = input;
  const { client, detailState, screen, t } = context;
  detailState.current = {
    ...detailState.current,
    transcript: {
      id: hostId,
      meetingId,
      source: "livekit-postcall",
      mode: "postcall-refined",
      isFinal: true,
      refinedAt: now,
    },
    hasTranscriptSegments: true,
  };
  await act(async () => {
    client.setQueryData(meetingNotesViewQueryKey(meetingId), detailState.current);
    t.mock.timers.tick(TIMER_TICK_MS);
  });
  const copiedLog = { texts: [] as string[] };
  t.mock.method(navigator.clipboard, "writeText", async (text: string) => {
    copiedLog.texts = appendCopied({ copied: copiedLog.texts, text });
  });
  t.mock.method(navigator.clipboard, "write", async (items: ClipboardItem[]) => {
    const blob = await items[0]?.getType("text/plain");
    assert.ok(blob);
    const text = await blob.text();
    copiedLog.texts = appendCopied({ copied: copiedLog.texts, text });
  });
  fireEvent.click(screen.getByRole("button", { name: POST_MEETING_WORKSPACE_TEST_COPY.meetingActionsButton }));
  const copyMenuItem = requiredHtmlButtonElement({
    element: screen.getByRole("menuitem", { name: POST_MEETING_WORKSPACE_TEST_COPY.copyTranscriptMenuPattern }),
    label: "Expected copy transcript menu item",
  });
  assert.equal(copyMenuItem.disabled, scenario.isFreePlan);
  await act(async () => {
    pressCopyTranscriptShortcut();
  });
  assert.equal(copiedLog.texts.length, scenario.isFreePlan ? 0 : 1);
  copiedLog.texts = [];

  if (!scenario.isFreePlan) {
    await TRIAL_MEETINGS_COMPLETED_INDICES.reduce(async (previous, trialMeetingsCompleted) => {
      await previous;
      await act(async () => {
        client.setQueryData(["workspace-trial-offer", attendeeId, attendeeId], {
          ...paidBilling,
          plan: "free",
          hasTrialCredits: true,
          trialMeetingsRemaining: TRIAL_MEETINGS_REMAINING_CAP - trialMeetingsCompleted,
        });
        t.mock.timers.tick(TIMER_TICK_MS);
      });
      assert.equal(screen.queryByRole("button", { name: POST_MEETING_WORKSPACE_TEST_COPY.upgradeToProButton }), null);
      assert.equal(screen.container.querySelector(".meeting-notes-upgrade-preview"), null);
      assert.notEqual(screen.queryByText(POST_MEETING_WORKSPACE_TEST_COPY.launchPilotLabel), null);
    }, Promise.resolve());
  }
}

async function runInviteeUpgradeLockFlow(context: InviteeTestContext) {
  const { client, detailState, screen, t } = context;
  await act(async () => {
    client.setQueryData(["workspace-trial-offer", attendeeId, attendeeId], {
      ...paidBilling,
      plan: "free",
      hasTrialCredits: true,
    });
    t.mock.timers.tick(TIMER_TICK_MS);
  });
  await act(async () => {
    detailState.current = { ...detailState.current, notesAccess: { locked: true, reason: "upgrade_required" } };
    client.setQueryData(meetingNotesViewQueryKey(meetingId), detailState.current);
    t.mock.timers.tick(TIMER_TICK_MS);
  });
  assert.notEqual(screen.queryByRole("button", { name: POST_MEETING_WORKSPACE_TEST_COPY.upgradeToProButton }), null);
  if (screen.queryByRole("menuitem", { name: POST_MEETING_WORKSPACE_TEST_COPY.copyTranscriptMenuPattern }) === null) {
    fireEvent.click(screen.getByRole("button", { name: POST_MEETING_WORKSPACE_TEST_COPY.meetingActionsButton }));
  }
  const copyItem = requiredHtmlButtonElement({
    element: screen.getByRole("menuitem", { name: POST_MEETING_WORKSPACE_TEST_COPY.copyTranscriptMenuPattern }),
    label: "Expected copy transcript menu item",
  });
  assert.equal(copyItem.disabled, true);
  const copiedLog = { texts: [] as string[] };
  t.mock.method(navigator.clipboard, "writeText", async (text: string) => {
    copiedLog.texts = appendCopied({ copied: copiedLog.texts, text });
  });
  t.mock.method(navigator.clipboard, "write", async (items: ClipboardItem[]) => {
    const blob = await items[0]?.getType("text/plain");
    assert.ok(blob);
    const text = await blob.text();
    copiedLog.texts = appendCopied({ copied: copiedLog.texts, text });
  });
  await act(async () => {
    fireEvent.click(copyItem);
    pressCopyTranscriptShortcut();
  });
  assert.deepEqual(copiedLog.texts, [], "neither the menu nor keyboard shortcut copies locked transcripts");
  await act(async () => t.mock.timers.tick(NOTES_REVEAL_WAIT_MS));
  const preview = screen.container.querySelector(".meeting-notes-upgrade-preview");
  assert.notEqual(preview, null);
  if (preview === null) {
    throw new Error(POST_MEETING_WORKSPACE_TEST_COPY.missingUpgradePreview);
  }
  assert.equal(preview.getAttribute("aria-hidden"), "true");
  assert.equal(preview.hasAttribute("inert"), true);
  const previewContent = preview.textContent;
  assert.notEqual(previewContent, null);
  assert.match(previewContent, /Launch the pilot on Tuesday/);
  assert.notEqual(preview.querySelector(".workspace-document-section > h3 + .workspace-flow-snapshot"), null);
  assert.equal(screen.container.querySelectorAll(".workspace-flow-snapshot").length, 1);
}

async function assertSkippedMeetingDisposition(context: InviteeTestContext) {
  const { client, detailState, screen, t } = context;
  await act(async () => {
    client.setQueryData(meetingNotesViewQueryKey(meetingId), {
      ...detailState.current,
      postMeetingDisposition: {
        status: "skipped",
        reason: "too_short_duration",
        redirectTo: "/workspace?view=upcoming",
        message: POST_MEETING_WORKSPACE_TEST_COPY.meetingTooShortMessage,
      },
    });
    t.mock.timers.tick(TIMER_TICK_MS);
  });
  assert.equal(
    screen.queryByRole("button", { name: POST_MEETING_WORKSPACE_TEST_COPY.upgradeToProButton }),
    null,
    "a skipped meeting never shows an upgrade even if fallback artifacts exist",
  );
}

async function runInviteeScenarioTest(input: { scenario: InviteeScenario; t: TestContext }) {
  const { scenario, t } = input;
  const context = setupInviteeTest({ scenario, t });
  await assertInviteeActiveMeetingPhase(context);
  const title = context.screen.getByText(POST_MEETING_WORKSPACE_TEST_COPY.customerPilotTitle);
  const orb = context.screen.container.querySelector(".workspace-thinking-signal");
  await assertInviteeEndedMeetingPhase({ context, scenario });
  if (scenario.isStalledPreview) {
    await runStalledPreviewBranch(context);

    return;
  }
  assert.equal(context.screen.getByText(POST_MEETING_WORKSPACE_TEST_COPY.customerPilotTitle), title);
  if (!scenario.isFreePlan) {
    assert.equal(context.screen.container.querySelector(".workspace-thinking-signal"), orb);
  }
  await completeInviteeNotesReveal({ context, scenario });
  await runInviteeCopyTranscriptFlow({ context, scenario });
  await runInviteeUpgradeLockFlow(context);
  await assertSkippedMeetingDisposition(context);
}

const inviteeScenarios: InviteeScenario[] = [
  { isFreePlan: false, isStalledPreview: false, hasStaleAccess: false },
  { isFreePlan: true, isStalledPreview: false, hasStaleAccess: false },
  { isFreePlan: true, isStalledPreview: true, hasStaleAccess: false },
  { isFreePlan: true, isStalledPreview: false, hasStaleAccess: true },
];

inviteeScenarios.forEach((scenario) => {
  void test(`logged-in invitee waits, rejoins, and reveals finalized notes (free preview: ${scenario.isFreePlan}, stalled: ${scenario.isStalledPreview}, stale access: ${scenario.hasStaleAccess})`, async (t) => {
    await runInviteeScenarioTest({ scenario, t });
  });
});

function createCachedMeetingDetail() {
  return meetingNotesViewResponseSchema.parse({
    meeting: {
      id: meetingId,
      workspaceId: hostId,
      createdByUserId: hostId,
      viewerRole: "participant",
      title: "Cached meeting",
      roomName: "cached",
      status: "ended",
      createdAt: now,
      startedAt: now,
      endedAt: now,
    },
    meetingRuntime: {
      activeHumanParticipantCount: 0,
      activeHumanParticipants: [],
      allHumanParticipants: [],
      isAwaitingMeetingEnd: false,
    },
    transcript: null,
    hasTranscriptSegments: false,
    summary: {
      id: hostId,
      meetingId,
      content: "Overview\n- Cached notes appear immediately.",
      model: "test",
      generatedAt: now,
    },
    actionItems: [],
    tasks: null,
  });
}

function renderCachedPlanPostMeeting(input: { client: QueryClient; visit: number; segmentId?: string }) {
  return (
    <AppRouterContext.Provider
      value={{ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch: () => {} }}
    >
      <SearchParamsContext.Provider
        value={new URLSearchParams(input.segmentId !== undefined ? { segmentId: input.segmentId } : {})}
      >
        <SessionProvider session={buildInviteeSession()}>
          <AuthProvider>
            <QueryClientProvider client={input.client}>
              <RealtimeClientProvider session={null} refreshSession={async () => null}>
                <ToastProvider>
                  <PostMeetingWorkspace key={input.visit} meetingId={meetingId} renderShell={false} />
                </ToastProvider>
              </RealtimeClientProvider>
            </QueryClientProvider>
          </AuthProvider>
        </SessionProvider>
      </SearchParamsContext.Provider>
    </AppRouterContext.Provider>
  );
}

async function runCachedPastNotesTest(input: {
  cachedPlan: "paid" | "free" | "unknown";
  outcome: "paid" | "free" | "failed";
  t: TestContext;
}) {
  const { t } = input;
  installMockBroadcastChannel(t);
  installPostMeetingTimerMocks(t);
  const client = createQueryClientWithCleanup(t);
  const detail = createCachedMeetingDetail();
  client.setQueryData(meetingNotesViewQueryKey(meetingId), detail);
  const billingKey = ["workspace-trial-offer", attendeeId, attendeeId];
  if (input.cachedPlan !== "unknown") {
    client.setQueryData(billingKey, {
      ...paidBilling,
      plan: input.cachedPlan === "free" ? "free" : paidBilling.plan,
    });
  }
  const billingGate: { resolve?: (response: Response) => void; requests: number } = { requests: 0 };
  t.mock.method(globalThis, "fetch", async (fetchInput: RequestInfo | URL) => {
    const url = resolveFetchUrl(fetchInput);
    if (url.endsWith("/billing/me")) {
      billingGate.requests += 1;

      return new Promise<Response>((resolve) => {
        billingGate.resolve = resolve;
      });
    }

    return new Response(
      JSON.stringify(
        url.endsWith(`/meetings/${meetingId}/notes-view`)
          ? detail
          : url.endsWith("/meetings")
            ? { meetings: [] }
            : { status: "pending", lines: [], source: null },
      ),
    );
  });
  const screen = render(renderCachedPlanPostMeeting({ client, visit: CACHED_PLAN_FIRST_VISIT }));
  const notes = screen.getByText(POST_MEETING_WORKSPACE_TEST_COPY.cachedNotesSnippet);
  assert.equal(billingGate.requests, 1, "the plan request runs without blocking the cached document");
  assert.equal(screen.queryByText(POST_MEETING_WORKSPACE_TEST_COPY.checkingYourPlan), null);
  assert.equal(
    Boolean(screen.queryByRole("button", { name: POST_MEETING_WORKSPACE_TEST_COPY.upgradeToProButton })),
    false,
  );
  assert.equal(Boolean(screen.container.querySelector(".meeting-notes-upgrade-preview")), false);
  await act(async () => {
    if (billingGate.resolve === undefined) {
      throw new Error(POST_MEETING_WORKSPACE_TEST_COPY.billingRequestNotCaptured);
    }
    billingGate.resolve(
      new Response(
        JSON.stringify(
          input.outcome === "failed"
            ? { message: POST_MEETING_WORKSPACE_TEST_COPY.billingUnavailable }
            : { billing: input.outcome === "free" ? { ...paidBilling, plan: "free" } : paidBilling },
        ),
        { status: input.outcome === "failed" ? HTTP_STATUS_UNAVAILABLE : HTTP_STATUS_OK },
      ),
    );
  });
  await act(async () => t.mock.timers.tick(TIMER_TICK_MS));
  assertTextPresent({ screen, text: POST_MEETING_WORKSPACE_TEST_COPY.cachedNotesSnippet });
  assert.equal(
    screen.getByText(POST_MEETING_WORKSPACE_TEST_COPY.cachedNotesSnippet),
    notes,
    "plan checks preserve included notes",
  );
  assert.equal(screen.queryByRole("button", { name: POST_MEETING_WORKSPACE_TEST_COPY.upgradeToProButton }), null);
  if (input.outcome === "failed") {
    assert.equal(
      Boolean(screen.queryByRole("button", { name: POST_MEETING_WORKSPACE_TEST_COPY.tryAgainButton })),
      input.cachedPlan === "unknown",
    );
  } else {
    screen.rerender(renderCachedPlanPostMeeting({ client, visit: CACHED_PLAN_SECOND_VISIT }));
    assertTextPresent({ screen, text: POST_MEETING_WORKSPACE_TEST_COPY.cachedNotesSnippet });
    assert.equal(billingGate.requests, EXPECTED_PLAN_CHECKS_AFTER_REVISIT);
    assert.equal(screen.queryByText(POST_MEETING_WORKSPACE_TEST_COPY.checkingYourPlan), null);
  }
}

(["paid", "free", "unknown"] as const).forEach((cachedPlan) => {
  (["paid", "free", "failed"] as const).forEach((outcome) => {
    void test(`cached past notes render before the background plan check resolves (cached ${cachedPlan}, response ${outcome})`, async (t) => {
      await runCachedPastNotesTest({ cachedPlan, outcome, t });
    });
  });
});

void test("a finalized fallback message remains visible in the signed-in workspace", async (t) => {
  installMockBroadcastChannel(t);
  installPostMeetingTimerMocks(t);
  const client = createQueryClientWithCleanup(t);
  const detail = createRecoveredMeetingDetail();
  const content = "Meeting notes could not be generated automatically. The transcript is available for review.";
  assert.notEqual(detail.summary, null);
  const fallback = {
    ...detail,
    summary: { ...detail.summary, id: hostId, meetingId, generatedAt: now, content, model: "fallback-summary-v1" },
  };
  client.setQueryData(meetingNotesViewQueryKey(meetingId), fallback);
  client.setQueryData(["workspace-trial-offer", attendeeId, attendeeId], paidBilling);
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = resolveFetchUrl(input);

    return new Response(
      JSON.stringify(
        url.endsWith("/billing/me")
          ? { billing: paidBilling }
          : url.endsWith(`/meetings/${meetingId}/notes-view`)
            ? fallback
            : { status: "pending", lines: [], source: null },
      ),
    );
  });
  const screen = render(renderCachedPlanPostMeeting({ client, visit: CACHED_PLAN_FIRST_VISIT }));
  await act(async () => {});
  assert.notEqual(screen.getByText(content), null);
  assert.equal(screen.queryByText(POST_MEETING_WORKSPACE_TEST_COPY.preparingYourNotes), null);
});

const NO_NOTES_CAPTURED_COPY = "No notes were captured for this meeting.";
const TASK_TEXT = "Sam: send the brief.";

function overviewTexts(container: HTMLElement): string {
  return Array.from(container.querySelectorAll(".workspace-flow-snapshot, p.muted, .workspace-meeting-notes-thinking"))
    .map((element) => element.textContent)
    .join(" | ");
}

[
  {
    name: "a summary that starts with Action items",
    content: `Action items\n- ${TASK_TEXT}\n\nOverview\n- Beta ships Friday.`,
    expected: "Beta ships Friday.",
  },
  { name: "a summary that is only a task section", content: `Tasks\n- ${TASK_TEXT}`, expected: NO_NOTES_CAPTURED_COPY },
  { name: "an empty summary", content: "", expected: NO_NOTES_CAPTURED_COPY },
].forEach(({ name, content, expected }) => {
  void test(`${name} resolves in the signed-in workspace instead of preparing notes forever`, async (t) => {
    installMockBroadcastChannel(t);
    installPostMeetingTimerMocks(t);
    const client = createQueryClientWithCleanup(t);
    const detail = createCachedMeetingDetail();
    assert.notEqual(detail.summary, null);
    const finalized = { ...detail, summary: { ...detail.summary, id: hostId, meetingId, generatedAt: now, content } };
    client.setQueryData(meetingNotesViewQueryKey(meetingId), finalized);
    client.setQueryData(["workspace-trial-offer", attendeeId, attendeeId], paidBilling);
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      const url = resolveFetchUrl(input);

      return new Response(
        JSON.stringify(
          url.endsWith("/billing/me")
            ? { billing: paidBilling }
            : url.endsWith(`/meetings/${meetingId}/notes-view`)
              ? finalized
              : { status: "pending", lines: [], source: null },
        ),
      );
    });
    const screen = render(renderCachedPlanPostMeeting({ client, visit: CACHED_PLAN_FIRST_VISIT }));
    await act(async () => {});
    await act(async () => t.mock.timers.tick(TIMER_TICK_MS));
    const overview = overviewTexts(screen.container);
    assert.equal(overview.includes(expected), true, overview);
    assert.equal(overview.includes(TASK_TEXT), false, overview);
    assert.equal(overview.includes(POST_MEETING_WORKSPACE_TEST_COPY.preparingYourNotes), false, overview);
    assert.equal(
      Boolean(screen.container.querySelector(".workspace-tasks-card")),
      false,
      "unfinished tasks stay hidden after notes are ready",
    );
    await act(async () => {
      client.setQueryData(meetingNotesViewQueryKey(meetingId), {
        ...finalized,
        tasks: buildDebugWorkspaceTaskList(meetingId, []),
      });
    });
    await act(async () => t.mock.timers.tick(TIMER_TICK_MS));
    assert.notEqual(screen.queryByText("No tasks"), null);
    assert.equal(screen.queryByText("Tasks will appear after notes are ready."), null);
  });
});

void test("a free plan's ready preview of a tasks-only summary resolves instead of preparing notes forever", async (t) => {
  installMockBroadcastChannel(t);
  installPostMeetingTimerMocks(t);
  const client = createQueryClientWithCleanup(t);
  const freeBilling = { ...paidBilling, plan: "free" as const };
  const lockedDetail = {
    ...createCachedMeetingDetail(),
    summary: null,
    notesAccess: {
      /** @external meeting notes access wire field */
      locked: true,
      reason: "upgrade_required" as const,
    },
    // The API previews the notes without their task section, so a tasks-only summary previews as "".
    notesPreview: { status: "ready" as const, content: "" },
  };
  client.setQueryData(meetingNotesViewQueryKey(meetingId), lockedDetail);
  client.setQueryData(["workspace-trial-offer", attendeeId, attendeeId], freeBilling);
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = resolveFetchUrl(input);

    return new Response(
      JSON.stringify(
        url.endsWith("/billing/me")
          ? { billing: freeBilling }
          : url.endsWith(`/meetings/${meetingId}/notes-view`)
            ? lockedDetail
            : { status: "pending", lines: [], source: null },
      ),
    );
  });
  const screen = render(renderCachedPlanPostMeeting({ client, visit: CACHED_PLAN_FIRST_VISIT }));
  await act(async () => {});
  await act(async () => t.mock.timers.tick(TIMER_TICK_MS));
  const overview = overviewTexts(screen.container);
  assert.equal(overview.includes(NO_NOTES_CAPTURED_COPY), true, overview);
  assert.equal(overview.includes(POST_MEETING_WORKSPACE_TEST_COPY.preparingYourNotes), false, overview);
  assert.notEqual(screen.queryByRole("button", { name: POST_MEETING_WORKSPACE_TEST_COPY.upgradeToProButton }), null);
});

void test("a past meeting that turns not found shows it after one request even with default retries", async (t) => {
  installMockBroadcastChannel(t);
  installPostMeetingTimerMocks(t);
  // Browsers retry failed queries 3 times by default; the shared test client turns retries off.
  const client = new QueryClient({ defaultOptions: { queries: { retry: BROWSER_DEFAULT_QUERY_RETRIES } } });
  t.after(() => {
    cleanup();
    client.clear();
    window.sessionStorage.clear();
  });
  const detail = createRecoveredMeetingDetail();
  const server = { isMissing: false, missingDetailRequests: 0 };
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = resolveFetchUrl(input);
    if (url.endsWith(`/meetings/${meetingId}/notes-view`)) {
      if (!server.isMissing) {
        return Response.json(detail);
      }
      server.missingDetailRequests += 1;

      return Response.json(
        { message: POST_MEETING_WORKSPACE_TEST_COPY.meetingRequestFailed },
        { status: HTTP_STATUS_NOT_FOUND },
      );
    }
    if (url.endsWith("/meetings")) {
      return Response.json({ meetings: [detail.meeting] });
    }
    if (url.endsWith("/billing/me")) {
      return Response.json({ billing: paidBilling });
    }

    return Response.json({ status: "pending", lines: [], source: null });
  });
  const screen = render(renderCachedPlanPostMeeting({ client, visit: CACHED_PLAN_FIRST_VISIT }));
  await act(async () => {});
  await act(async () => t.mock.timers.tick(TIMER_TICK_MS));
  assert.notEqual(screen.queryByText(POST_MEETING_WORKSPACE_TEST_COPY.recoveredNotesLabel), null);
  server.isMissing = true;
  await act(async () => {
    void client.invalidateQueries({ queryKey: meetingNotesViewQueryKey(meetingId) });
  });
  await act(async () => t.mock.timers.tick(TIMER_TICK_MS));
  assert.notEqual(screen.queryByText(POST_MEETING_WORKSPACE_TEST_COPY.meetingRequestFailed), null);
  assert.equal(server.missingDetailRequests, 1);
});

void test("cold past notes share pending reads and render without leaving the page", async (t) => {
  installMockBroadcastChannel(t);
  installPostMeetingTimerMocks(t);
  const client = createQueryClientWithCleanup(t);
  const detail = createRecoveredMeetingDetail();
  const requests = { meetings: 0, detail: 0, full: 0 };
  const response: { resolve?: (value: Response) => void } = {};
  const pendingResponse = new Promise<Response>((resolve) => {
    response.resolve = resolve;
  });
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = resolveFetchUrl(input);
    if (url.endsWith(`/meetings/${meetingId}`)) {
      requests.full += 1;

      return new Promise<Response>(() => {});
    }
    if (url.endsWith(`/meetings/${meetingId}/notes-view`)) {
      requests.detail += 1;

      return (await pendingResponse).clone();
    }
    if (url.endsWith("/meetings")) {
      requests.meetings += 1;

      return Response.json({ meetings: [detail.meeting] });
    }
    if (url.endsWith("/billing/me")) {
      return Response.json({ billing: paidBilling });
    }

    return Response.json({ status: "pending", lines: [], source: null });
  });
  const screen = render(renderCachedPlanPostMeeting({ client, visit: CACHED_PLAN_FIRST_VISIT }));
  await act(async () => {});
  assert.ok(screen.container.querySelector(".workspace-meeting-loading-frame"));
  assert.equal(requests.detail, 1);
  assert.equal(requests.meetings, 1);
  await act(async () => response.resolve?.(Response.json(detail)));
  await act(async () => t.mock.timers.tick(TIMER_TICK_MS));
  assert.equal(screen.container.querySelector(".workspace-meeting-loading-frame"), null);
  assert.notEqual(screen.queryByText(POST_MEETING_WORKSPACE_TEST_COPY.recoveredNotesLabel), null);
  assert.equal(requests.full, 0, "notes never request the heavy transcript endpoint");
});

void test("saved notes stay visible while a linked transcript excerpt loads", async (t) => {
  installMockBroadcastChannel(t);
  installPostMeetingTimerMocks(t);
  const client = createQueryClientWithCleanup(t);
  const detail = createRecoveredMeetingDetail();
  const pending: { resolve?: (response: Response) => void } = {};
  const transcriptResponse = new Promise<Response>((resolve) => {
    pending.resolve = resolve;
  });
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = resolveFetchUrl(input);
    if (url.endsWith(`/meetings/${meetingId}`)) {
      return transcriptResponse;
    }
    if (url.endsWith(`/meetings/${meetingId}/notes-view`)) {
      return Response.json(detail);
    }
    if (url.endsWith("/meetings")) {
      return Response.json({ meetings: [detail.meeting] });
    }
    if (url.endsWith("/billing/me")) {
      return Response.json({ billing: paidBilling });
    }

    return Response.json({ status: "pending", lines: [], source: null });
  });
  const screen = render(renderCachedPlanPostMeeting({ client, visit: CACHED_PLAN_FIRST_VISIT, segmentId: hostId }));
  await act(async () => {});
  await act(async () => t.mock.timers.tick(TIMER_TICK_MS));
  assert.notEqual(screen.queryByText(POST_MEETING_WORKSPACE_TEST_COPY.recoveredNotesLabel), null);
  assert.notEqual(screen.queryByText("Loading transcript…"), null);
  await act(async () =>
    pending.resolve?.(
      Response.json({
        ...detail,
        transcriptSegments: [
          {
            id: hostId,
            transcriptId: hostId,
            speakerIdentity: "fixture",
            speakerUserId: attendeeId,
            speakerRole: "human",
            speakerName: "Fixture",
            source: "livekit",
            sourceSegmentId: null,
            content: "An invented source excerpt.",
            startedAt: now,
            endedAt: now,
          },
        ],
      }),
    ),
  );
  await act(async () => t.mock.timers.tick(TIMER_TICK_MS));
  assert.notEqual(screen.queryByText("An invented source excerpt."), null);
  assert.notEqual(screen.queryByText(POST_MEETING_WORKSPACE_TEST_COPY.recoveredNotesLabel), null);
});

void test("a failed transcript load explains the copy failure instead of showing the browser's error", async (t) => {
  installMockBroadcastChannel(t);
  installPostMeetingTimerMocks(t);
  const client = createQueryClientWithCleanup(t);
  const detail = {
    ...createRecoveredMeetingDetail(),
    transcript: {
      id: hostId,
      meetingId,
      source: "livekit-postcall",
      mode: "postcall-refined",
      isFinal: true,
      refinedAt: now,
    },
    hasTranscriptSegments: true,
  };
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = resolveFetchUrl(input);
    if (url.endsWith(`/meetings/${meetingId}`)) {
      // Access was lost after the notes loaded.
      return Response.json({
        ...detail,
        transcriptSegments: [],
        notesAccess: {
          /** @external notes access wire field */
          locked: true,
          reason: "upgrade_required",
        },
      });
    }
    if (url.endsWith(`/meetings/${meetingId}/notes-view`)) {
      return Response.json(detail);
    }
    if (url.endsWith("/meetings")) {
      return Response.json({ meetings: [detail.meeting] });
    }
    if (url.endsWith("/billing/me")) {
      return Response.json({ billing: paidBilling });
    }

    return Response.json({ status: "pending", lines: [], source: null });
  });
  // Browsers reject write() with their own error when a ClipboardItem's data promise rejects.
  const browserError = "NotAllowedError: Failed to execute 'write' on 'Clipboard'";
  t.mock.method(navigator.clipboard, "write", async (items: ClipboardItem[]) => {
    try {
      await items[0]?.getType("text/plain");
    } catch (error) {
      assert.ok(error instanceof Error);
      throw new Error(browserError);
    }
  });
  const screen = render(renderCachedPlanPostMeeting({ client, visit: CACHED_PLAN_FIRST_VISIT }));
  await act(async () => {});
  await act(async () => t.mock.timers.tick(TIMER_TICK_MS));
  assert.notEqual(screen.queryByText(POST_MEETING_WORKSPACE_TEST_COPY.recoveredNotesLabel), null);
  await act(async () => {
    pressCopyTranscriptShortcut();
  });
  await act(async () => t.mock.timers.tick(TIMER_TICK_MS));
  assert.notEqual(screen.queryByText("Transcript access is unavailable."), null);
  assert.equal(screen.queryByText(browserError), null);
});

void test("the host's Linear task review reloads when the meeting detail is invalidated", async (t) => {
  installMockBroadcastChannel(t);
  installPostMeetingTimerMocks(t);
  const client = createQueryClientWithCleanup(t);
  const recovered = createRecoveredMeetingDetail();
  const detail = { ...recovered, meeting: { ...recovered.meeting, createdByUserId: attendeeId } };
  const requests = { review: 0 };
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = resolveFetchUrl(input);
    if (url.endsWith(`/meetings/${meetingId}/linear-task-review`)) {
      requests.review += 1;

      return Response.json({ review: null });
    }
    if (url.endsWith(`/meetings/${meetingId}/notes-view`)) {
      return Response.json(detail);
    }
    if (url.endsWith("/meetings")) {
      return Response.json({ meetings: [detail.meeting] });
    }
    if (url.endsWith("/billing/me")) {
      return Response.json({ billing: paidBilling });
    }

    return Response.json({ status: "pending", lines: [], source: null });
  });
  const screen = render(renderCachedPlanPostMeeting({ client, visit: CACHED_PLAN_FIRST_VISIT }));
  await act(async () => {});
  await act(async () => t.mock.timers.tick(TIMER_TICK_MS));
  assert.notEqual(screen.queryByText(POST_MEETING_WORKSPACE_TEST_COPY.recoveredNotesLabel), null);
  assert.equal(requests.review, 1);
  // Task updates, realtime task events and billing changes all invalidate the meeting detail prefix.
  await act(async () => {
    void client.invalidateQueries({ queryKey: meetingDetailQueryKey(meetingId) });
  });
  await act(async () => t.mock.timers.tick(TIMER_TICK_MS));
  assert.equal(requests.review, 1 + 1, "the Linear task review refetches with the meeting detail");
  const reviewsBeforeBillingChange = requests.review;
  // Billing and trial changes invalidate every meeting detail.
  await act(async () => {
    void client.invalidateQueries({ queryKey: ["meetingDetail"] });
  });
  await act(async () => t.mock.timers.tick(TIMER_TICK_MS));
  assert.equal(
    requests.review,
    reviewsBeforeBillingChange + 1,
    "the Linear task review refetches after a billing change",
  );
});

void test("Linear review refreshes after an empty result and polls queued and syncing runs", async (t) => {
  const isServerInitially = environmentManager.isServer();
  environmentManager.setIsServer(() => false);
  t.after(() => environmentManager.setIsServer(() => isServerInitially));
  focusManager.setFocused(true);
  t.after(() => focusManager.setFocused(undefined));
  installMockBroadcastChannel(t);
  installPostMeetingTimerMocks(t);
  const client = createQueryClientWithCleanup(t);
  const detail = createCachedMeetingDetail();
  detail.meeting.createdByUserId = attendeeId;
  client.setQueryData(meetingNotesViewQueryKey(meetingId), detail);
  client.setQueryData(["workspace-trial-offer", attendeeId, attendeeId], paidBilling);
  const review = {
    id: hostId,
    meetingId,
    taskListId: hostId,
    userId: attendeeId,
    connectorId: null,
    status: "queued",
    phase: "queued",
    inputHash: "synthetic-input",
    model: null,
    promptVersion: null,
    error: null,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    items: [],
  };
  const state = { reviewRequests: 0, hasReview: false };
  const reviewPollTickMs = 4_001;
  const completedPollWaitMs = 8_001;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = resolveFetchUrl(input);
    if (url.endsWith("/linear-task-review")) {
      state.reviewRequests += 1;

      return new Response(JSON.stringify({ review: state.hasReview ? review : null }));
    }

    return new Response(
      JSON.stringify(
        url.endsWith("/billing/me")
          ? { billing: paidBilling }
          : url.endsWith("/notes-view")
            ? detail
            : url.endsWith("/meetings")
              ? { meetings: [] }
              : { status: "pending", lines: [], source: null },
      ),
    );
  });
  render(renderCachedPlanPostMeeting({ client, visit: CACHED_PLAN_FIRST_VISIT }));
  await act(async () => {});
  const key = meetingLinearTaskReviewQueryKey(meetingId);
  assert.equal(client.getQueryData(key), null);
  state.hasReview = true;
  await act(async () => {
    // Task realtime updates invalidate this same meeting prefix.
    await client.invalidateQueries({ queryKey: meetingDetailQueryKey(meetingId) });
    t.mock.timers.tick(TIMER_TICK_MS);
  });
  assert.equal(client.getQueryData<typeof review>(key)?.status, "queued");
  async function assertReviewPoll(status: string) {
    review.status = status;
    const previousRequests = state.reviewRequests;
    await act(async () => {
      t.mock.timers.tick(reviewPollTickMs);
    });
    assert.ok(state.reviewRequests > previousRequests, "active reviews keep polling");
    assert.equal(client.getQueryData<typeof review>(key)?.status, status);
    await act(async () => {
      t.mock.timers.tick(TIMER_TICK_MS);
    });
  }
  const scrolls = { count: 0 };
  t.mock.method(window, "scrollTo", () => {
    scrolls.count += 1;
  });
  await assertReviewPoll("syncing");
  const scrollsBeforeReviewing = scrolls.count;
  await assertReviewPoll("reviewing");
  assert.ok(scrolls.count > scrollsBeforeReviewing, "the page follows a running Linear review");
  await assertReviewPoll("completed");
  const scrollsAfterCompleted = scrolls.count;
  const completedRequests = state.reviewRequests;
  await act(async () => {
    t.mock.timers.tick(completedPollWaitMs);
  });
  assert.equal(state.reviewRequests, completedRequests, "completed reviews stop polling");
  assert.equal(scrolls.count, scrollsAfterCompleted, "the page stops following once the review completes");
});
