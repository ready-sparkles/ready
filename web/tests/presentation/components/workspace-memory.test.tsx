import "../../memory-dom";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { encodeMemoryPosition, memoryPreferencesSchema, userSchema } from "@readymeet/shared";
import { dehydrate, hydrate, QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import {
  PathnameContext,
  PathParamsContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import { SessionProvider } from "next-auth/react";
import assert from "node:assert/strict";
import test, { after, beforeEach, type TestContext } from "node:test";
import React, { useState } from "react";
import { z } from "zod";

import PeopleLayout from "../../../app/workspace/memory/people/layout";
import { memoryListOptions } from "../../../composition/memory-query-options";
import { shouldPersistQuery } from "../../../composition/query-cache-policy";
import { useMemoryNavigationCache } from "../../../composition/use-memory-navigation-cache";
import { AuthProvider } from "../../../presentation/components/auth-provider";
import {
  type BrowserFilters,
  MemoryBrowserToolbar,
  MemoryGroup,
  moveRowFocus,
} from "../../../presentation/components/memory-browser-controls";
import { memoryPersonMentions } from "../../../presentation/components/memory-person-text";
import { buildMemoryRulerItems } from "../../../presentation/components/memory-stack/memory-ruler";
import { ToastProvider } from "../../../presentation/components/toast-provider";
import { MemorySettingsPanel, WorkspaceMemoryPage } from "../../../presentation/components/workspace-memory";

after(async () => {
  await GlobalRegistrator.unregister();
});

const MEMORY_TEST_PERSON_FIXTURE_BASE_YEAR = 2026;
const MEMORY_TEST_PERSON_FIXTURE_MONTH_OFFSET_DIVISOR = 30;
const MEMORY_TEST_PERSON_FIXTURE_DAY = 15;
const MEMORY_TEST_PERSON_FIXTURE_HOUR = 12;
const MEMORY_TEST_PERSON_FIXTURE_MONTH_BASE = 8;
const MEMORY_TEST_PERSON_KEYBOARD_NAV_TARGET_INDEX = 89;

const WORKSPACE_MEMORY_TEST_COPY = {
  missingUrlPath: "Missing URL path",
  missingRequestBody: "Missing request body",
  missingElementPrefix: "Missing",
  missingIntersectionObserver: "Missing intersection observer.",
  missingPeopleGroup: "Missing people group.",
  memoryFailureToastMessage: "Some memories couldn’t be processed.",
  preparingMemoriesTitle: "Preparing memories",
  offlineFetchError: "offline",
  cardViewButton: "Card view",
  listViewButton: "List view",
  updatingMemoryPattern: /Updating memory|Updating relationship|Loading memor/,
  septemberGroupToggle: "September 2",
  personOpenLabelPrefix: "Open Person",
  memoryRetryMethod: "POST",
  billingMePathSuffix: "/billing/me",
  memoryStatusPathSuffix: "/memory/status",
  memoryPeoplePathSuffix: "/memory/people",
  memoryRetryPathSuffix: "/memory/retry",
  memoryListPathFragment: "/memory?",
  personFixtureBaseYear: MEMORY_TEST_PERSON_FIXTURE_BASE_YEAR,
  personFixtureMonthOffsetDivisor: MEMORY_TEST_PERSON_FIXTURE_MONTH_OFFSET_DIVISOR,
  personFixtureDay: MEMORY_TEST_PERSON_FIXTURE_DAY,
  personFixtureHour: MEMORY_TEST_PERSON_FIXTURE_HOUR,
  personFixtureMonthBase: MEMORY_TEST_PERSON_FIXTURE_MONTH_BASE,
  personKeyboardNavTargetIndex: MEMORY_TEST_PERSON_KEYBOARD_NAV_TARGET_INDEX,
  memoryBrowserSeptemberLabel: "September",
  memoryBrowserJussiLabel: "Personqa",
  memoryBrowserBobbyLabel: "Personqx",
  finnishEvidenceQuote: "Voin tehdä videon.",
  personProjectionSummary: "You discussed the demo.",
  standingVideoStep: "The last recorded next step was a video.",
  standingAnotherSentence: "Another standing sentence.",
  billingUnavailableMessage: "Unavailable",
  transcriptBudgetQuote: "The budget is approved.",
  standingDemoNextStep: "The demo is the next step.",
  missingPerson: "Missing person",
  missingPersonLink: "Missing person link",
  missingPersonRow: "Missing person row",
  backgroundRequestsNotHeld: "Background requests were not held",
  cachedPersonSummary: "Cached person summary.",
  memoryNoLongerAvailable: "This memory is no longer available.",
  openMemoryHarnessLabel: "Open Memory",
} as const;
const MEMORY_TEST_LAYOUT_WIDTH = 600;
const MEMORY_TEST_LAYOUT_HEIGHT = 900;
const MEMORY_TEST_STAGE_TOP = 800;
const MEMORY_TEST_STAGE_HEIGHT = 400;
const MEMORY_TEST_GROUP_HEADING_TOP = 80;
const MEMORY_TEST_GROUP_HEADING_HEIGHT = 24;
const MEMORY_TEST_LIST_ROW_TOP = 120;
const MEMORY_TEST_LIST_ROW_HEIGHT = 32;
const MEMORY_TEST_PROGRESS_QUEUED = 2;
const MEMORY_TEST_PROGRESS_RUNNING = 1;
const MEMORY_TEST_PROGRESS_COMPLETED = 0;
const MEMORY_TEST_PROGRESS_FAILED = 0;
const MEMORY_TEST_PROGRESS_PROJECTION_RUNNING = 1;
const MEMORY_TEST_HTTP_OK = 200;
const MEMORY_TEST_PROGRESS_SNAPSHOT_ONE_COMPLETE = {
  queued: MEMORY_TEST_PROGRESS_FAILED,
  running: MEMORY_TEST_PROGRESS_FAILED,
  completed: 1,
  failed: MEMORY_TEST_PROGRESS_FAILED,
};
const MEMORY_TEST_PROGRESS_COMPLETED_TWO = 2;
const MEMORY_TEST_PROGRESS_SNAPSHOT_TWO_COMPLETE = {
  ...MEMORY_TEST_PROGRESS_SNAPSHOT_ONE_COMPLETE,
  completed: MEMORY_TEST_PROGRESS_COMPLETED_TWO,
};
const MEMORY_TEST_PROGRESS_SNAPSHOT_ALL_IDLE = {
  queued: MEMORY_TEST_PROGRESS_FAILED,
  running: MEMORY_TEST_PROGRESS_FAILED,
  completed: MEMORY_TEST_PROGRESS_FAILED,
  failed: MEMORY_TEST_PROGRESS_FAILED,
};

type MemoryTestStatusProgress = {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  projectionRunning?: number;
};

function buildMemoryTestStatusBody(input: {
  progress?: MemoryTestStatusProgress;
  processingMeeting?: { meetingId: string; endedAt: string } | null;
}) {
  return {
    /** @external memory status wire field */
    available: true,
    preferences: memoryPreferencesSchema.parse({}),
    progress: input.progress ?? MEMORY_TEST_PROGRESS_SNAPSHOT_ALL_IDLE,
    processingMeeting: input.processingMeeting ?? null,
  };
}
const MEMORY_TEST_PEOPLE_SCALE_COUNT = 5000;
const MEMORY_TEST_PEOPLE_VISIBLE_ROW_CAP = 100;
const MEMORY_TEST_PEOPLE_KEYBOARD_FIXTURE_COUNT = 90;
const MEMORY_TEST_SINGLE_FETCH_COUNT = 1;
const MEMORY_TEST_DEHYDRATED_QUERY_COUNT = 2;
const MEMORY_TEST_POLL_INTERVAL_MS = 5000;
const MEMORY_TEST_DOCUMENT_POSITION_MASK = Node.DOCUMENT_POSITION_FOLLOWING;
const MEMORY_TEST_PAGINATION_FETCH_COUNT = 2;
const MEMORY_TEST_PEOPLE_DATE_PRESET_WEEK_DAYS = 7;
const MEMORY_TEST_MEMORY_IMPORTANCE_MEDIUM = 2;
const MEMORY_TEST_MEMORY_IMPORTANCE_HIGH = 4;
const MEMORY_TEST_HTTP_UNAVAILABLE = 503;
const MEMORY_TEST_RULER_FOURTH_ROW_INDEX = MEMORY_TEST_DEHYDRATED_QUERY_COUNT + MEMORY_TEST_SINGLE_FETCH_COUNT;
const MEMORY_TEST_RULER_MOMENT_INDICES = [
  MEMORY_TEST_RULER_FOURTH_ROW_INDEX,
  MEMORY_TEST_DEHYDRATED_QUERY_COUNT,
  MEMORY_TEST_SINGLE_FETCH_COUNT,
  MEMORY_TEST_PROGRESS_FAILED,
] as const;
const MEMORY_TEST_POLL_SYNC_REMOVE_PHASE = 2;
const MEMORY_TEST_EVIDENCE_FETCH_COUNT_AFTER_SYNC = 2;
const MEMORY_TEST_WAIT_FOR_LINK_TIMEOUT_MS = 2000;
const MEMORY_TEST_OCCLUSION_BANNER_INITIAL_TOP = 350;
const MEMORY_TEST_OCCLUSION_STAGE_HEIGHT = 400;
const MEMORY_TEST_OCCLUSION_PERSON_ROW_JUSSI_TOP = 120;
const MEMORY_TEST_OCCLUSION_PERSON_ROW_BOBBY_TOP = 170;
const MEMORY_TEST_OCCLUSION_PERSON_ROW_DANIEL_TOP = 220;
const MEMORY_TEST_OCCLUSION_PERSON_ROW_ALEX_TOP = 470;
const MEMORY_TEST_OCCLUSION_GROUP_AUGUST_TOP = 430;
const MEMORY_TEST_OCCLUSION_GROUP_SEPTEMBER_TOP = 104;
const MEMORY_TEST_PEOPLE_FIXTURE_FOURTH_INDEX = 3;
const MEMORY_TEST_OCCLUSION_BANNER_EXPANDED_TOP = 540;
const MEMORY_TEST_OCCLUSION_OUTER_SCROLL = 70;
const MEMORY_TEST_OCCLUSION_SCROLLPORT_TOP = 145;
const MEMORY_TEST_OCCLUSION_BANNER_MID_TOP = 290;
const MEMORY_TEST_TOGGLE_REMOUNT_DEFER_MS = 10;
const MEMORY_TEST_MEMORY_SEARCH_MAX_PAGE_INDEX = 20;
const MEMORY_TEST_MEMORY_SEARCH_CURSOR_TOTAL = 21;

// Cross-tab sync is not under test here; an inert channel keeps happy-dom from echoing cache broadcasts.
class InertBroadcastChannel extends EventTarget {
  constructor(public name: string) {
    super();
  }

  postMessage(_message: unknown) {}

  close() {}
}

function installMockBroadcastChannel(t: TestContext) {
  t.mock.method(globalThis, "BroadcastChannel", function (name: string) {
    return new InertBroadcastChannel(name);
  });
}

function throwMissingElement(label: string): never {
  throw new Error([WORKSPACE_MEMORY_TEST_COPY.missingElementPrefix, label].join(" "));
}

function requiredHtmlInputElement(input: { value: Element | null; label: string }): HTMLInputElement {
  const element = requiredElement({ value: input.value, label: input.label });
  if (!(element instanceof HTMLInputElement)) {
    throwMissingElement(input.label);
  }

  return element;
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

function urlPath(url: string) {
  const path = url.split("?")[0];
  if (path === undefined) {
    throw new Error(WORKSPACE_MEMORY_TEST_COPY.missingUrlPath);
  }

  return path;
}

function requiredElement<T extends Element>(input: { value: T | null; label: string }): T {
  const { value, label } = input;
  if (value === null) {
    throwMissingElement(label);
  }

  return value;
}

function assertTextPresent(input: { screen: { queryByText: (text: string) => Element | null }; text: string }) {
  assert.notEqual(input.screen.queryByText(input.text), null);
}

function assertRolePresent(input: {
  screen: Pick<ReturnType<typeof render>, "queryByRole">;
  role: string;
  name: string | RegExp;
}) {
  assert.notEqual(input.screen.queryByRole(input.role, { name: input.name }), null);
}

const requestJsonBodySchema = z.object({}).passthrough();

function requestJson(input: { options: RequestInit | undefined }) {
  const body = input.options?.body;
  if (typeof body !== "string") {
    throw new Error(WORKSPACE_MEMORY_TEST_COPY.missingRequestBody);
  }

  return requestJsonBodySchema.parse(JSON.parse(body));
}

const uid = "11111111-1111-4111-8111-111111111111",
  wid = "22222222-2222-4222-8222-222222222222",
  pid = "33333333-3333-4333-8333-333333333333",
  mid = "44444444-4444-4444-8444-444444444444";
const user = userSchema.parse({
  id: uid,
  email: "memory@example.test",
  displayName: "Personqc",
  workspaceId: wid,
  source: "auth",
  plan: "business",
  avatarUrl: null,
  createdAt: "2026-01-01T00:00:00Z",
});
const memory = {
  id: mid,
  sourceId: mid,
  meetingId: mid,
  title: "Personqa offered to record a demo",
  description: "He can record a video after improving the data.",
  category: "Partnerships",
  personIds: [pid],
  occurredAt: "2026-09-11T17:00:00Z",
};
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
// Happy DOM has no layout. Give preview tests a measurable exposed region;
// the occlusion regression below supplies individual row and banner positions.
beforeEach((t) => {
  if (!("mock" in t)) {
    return;
  }
  // The original method is invoked with each target element as its receiver.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = HTMLElement.prototype.getBoundingClientRect;
  t.mock.method(HTMLElement.prototype, "getBoundingClientRect", function (this: HTMLElement) {
    if (this.matches(".relationship-memory-content")) {
      return new DOMRect(0, 0, MEMORY_TEST_LAYOUT_WIDTH, MEMORY_TEST_LAYOUT_HEIGHT);
    }
    if (this.matches(".relationship-memory-upgrade-preview")) {
      return new DOMRect(0, 0, MEMORY_TEST_LAYOUT_WIDTH, MEMORY_TEST_LAYOUT_HEIGHT);
    }
    if (this.matches(".relationship-memory-upgrade-stage")) {
      return new DOMRect(0, MEMORY_TEST_STAGE_TOP, MEMORY_TEST_LAYOUT_WIDTH, MEMORY_TEST_STAGE_HEIGHT);
    }
    if (this.matches(".relationship-memory-group > .relationship-memory-group-heading")) {
      return new DOMRect(0, MEMORY_TEST_GROUP_HEADING_TOP, MEMORY_TEST_LAYOUT_WIDTH, MEMORY_TEST_GROUP_HEADING_HEIGHT);
    }
    if (this.matches(".relationship-people-list > li")) {
      return new DOMRect(0, MEMORY_TEST_LIST_ROW_TOP, MEMORY_TEST_LAYOUT_WIDTH, MEMORY_TEST_LIST_ROW_HEIGHT);
    }

    return original.call(this);
  });
});
const MEMORY_TEST_QUERY_GC_MINUTES = 5;
const MEMORY_TEST_MS_PER_MINUTE = 60_000;
const MEMORY_TEST_QUERY_GC_MS = MEMORY_TEST_QUERY_GC_MINUTES * MEMORY_TEST_MS_PER_MINUTE;
const MEMORY_TEST_SESSION_EXPIRES = "2099-01-01";

function mount(input: {
  node: React.ReactNode;
  searchParams?: URLSearchParams;
  plan?: typeof user.plan;
  cachedBilling?: typeof paidBilling;
  /** @external session appUser wire field */
  memoryAvailable?: boolean;
}) {
  const {
    node,
    searchParams = new URLSearchParams(),
    plan = user.plan,
    cachedBilling,
    memoryAvailable: isMemoryAvailable = true,
  } = input;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: MEMORY_TEST_POLL_INTERVAL_MS } },
  });
  client.setQueryDefaults(["workspace-trial-offer"], { gcTime: MEMORY_TEST_QUERY_GC_MS });
  if (cachedBilling !== undefined) {
    client.setQueryData(["workspace-trial-offer", user.workspaceId, user.id], cachedBilling);
  }
  const tree = (
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
      <PathnameContext.Provider value="/workspace/memory">
        <SearchParamsContext.Provider value={searchParams}>
          <SessionProvider
            session={{
              expires: MEMORY_TEST_SESSION_EXPIRES,
              apiToken: "test-token",
              appUser: {
                ...user,
                plan,
                /** @external session appUser wire field */
                memoryAvailable: isMemoryAvailable,
              },
            }}
          >
            <AuthProvider>
              <QueryClientProvider client={client}>
                <ToastProvider>{node}</ToastProvider>
              </QueryClientProvider>
            </AuthProvider>
          </SessionProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>
  );

  return { client, screen: render(tree) };
}
const UNRELATED_MENTION_TEXT = "Someone else";

// A message keeps node:assert from re-parsing this large source file on every failed waitFor attempt.
const EXPECTED_TRUTHY = "expected a truthy value";
const INERT_GROUP_HEADING_SELECTOR = ".relationship-memory-group > .relationship-memory-group-heading[inert]";

void test("processing is a text-only shimmer row above memories, with no timestamp or category pill", async (t) => {
  installMockBroadcastChannel(t);
  const processingState = { isProcessingMeetingActive: true, memories: [memory] };
  const endedAt = "2026-09-18T18:45:00Z";
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = resolveFetchUrl(input);
    if (url.endsWith("/billing/me")) {
      return new Response(JSON.stringify({ billing: paidBilling }));
    }
    const body = url.endsWith(WORKSPACE_MEMORY_TEST_COPY.memoryStatusPathSuffix)
      ? buildMemoryTestStatusBody({
          progress: {
            queued: MEMORY_TEST_PROGRESS_QUEUED,
            running: MEMORY_TEST_PROGRESS_RUNNING,
            completed: MEMORY_TEST_PROGRESS_COMPLETED,
            failed: MEMORY_TEST_PROGRESS_FAILED,
            projectionRunning: MEMORY_TEST_PROGRESS_PROJECTION_RUNNING,
          },
          processingMeeting: processingState.isProcessingMeetingActive ? { meetingId: mid, endedAt } : null,
        })
      : urlPath(url).endsWith("/memory/people")
        ? { people: [] }
        : url.includes("/memory?")
          ? { memories: processingState.memories, nextCursor: null }
          : {};

    return new Response(JSON.stringify(body), { status: MEMORY_TEST_HTTP_OK });
  });
  const { client, screen } = mount({ node: <WorkspaceMemoryPage /> });
  t.after(() => {
    cleanup();
    client.clear();
  });
  await waitFor(() => assertTextPresent({ screen, text: memory.title }));
  const title = screen.getByText(WORKSPACE_MEMORY_TEST_COPY.preparingMemoriesTitle);
  assert.ok(title.classList.contains("live-end-meeting-step-shimmer"), EXPECTED_TRUTHY);
  const row = requiredElement({ value: title.closest("li"), label: "processing row" });
  assert.equal(row.querySelector("time") === null, true);
  assert.equal(row.querySelector(".relationship-category") === null, true);
  assert.notEqual(row.compareDocumentPosition(screen.getByText(memory.title)) & MEMORY_TEST_DOCUMENT_POSITION_MASK, 0);
  assert.equal(screen.queryByText(WORKSPACE_MEMORY_TEST_COPY.updatingMemoryPattern) === null, true);
  fireEvent.click(screen.getByRole("button", { name: WORKSPACE_MEMORY_TEST_COPY.cardViewButton }));
  assert.equal(screen.queryByText(WORKSPACE_MEMORY_TEST_COPY.preparingMemoriesTitle) === null, true);
  processingState.memories = [{ ...memory, id: pid, title: "Newly processed decision" }, memory];
  await client.invalidateQueries({ queryKey: ["relationship-memory", uid, wid, "list"] });
  await waitFor(() =>
    assert.equal(
      screen.container.querySelector(".memory-snapshot-card.is-entering")?.getAttribute("data-memory-id"),
      pid,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: WORKSPACE_MEMORY_TEST_COPY.listViewButton }));
  assertTextPresent({ screen, text: WORKSPACE_MEMORY_TEST_COPY.preparingMemoriesTitle });
  processingState.isProcessingMeetingActive = false;
  await client.invalidateQueries({ queryKey: ["relationship-memory", uid, wid, "status"] });
  await waitFor(() =>
    assert.equal(screen.queryByText(WORKSPACE_MEMORY_TEST_COPY.preparingMemoriesTitle) === null, true),
  );
});

void test("memory failures use a dismissible terminal failure toast without reappearing on every status poll", async (t) => {
  installMockBroadcastChannel(t);
  const failureState = { failedCount: 1 };
  const retryUrlCapture = { urls: [] as string[] };
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = resolveFetchUrl(input);
    if (url.endsWith("/billing/me")) {
      return new Response(JSON.stringify({ billing: paidBilling }));
    }
    if (url.endsWith("/memory/retry")) {
      assert.equal(options?.method, "POST");
      retryUrlCapture.urls = [...retryUrlCapture.urls, url];
      failureState.failedCount = MEMORY_TEST_PROGRESS_FAILED;
    }
    const body = url.endsWith(WORKSPACE_MEMORY_TEST_COPY.memoryStatusPathSuffix)
      ? buildMemoryTestStatusBody({
          progress: { ...MEMORY_TEST_PROGRESS_SNAPSHOT_ONE_COMPLETE, failed: failureState.failedCount },
        })
      : urlPath(url).endsWith("/memory/people")
        ? { people: [] }
        : url.includes("/memory?")
          ? { memories: [memory], nextCursor: null }
          : {};

    return new Response(JSON.stringify(body), { status: MEMORY_TEST_HTTP_OK });
  });
  const { client, screen } = mount({ node: <WorkspaceMemoryPage /> });
  t.after(() => {
    cleanup();
    client.clear();
    window.sessionStorage.clear();
  });
  const message = WORKSPACE_MEMORY_TEST_COPY.memoryFailureToastMessage;
  await waitFor(() => assert.equal(Boolean(screen.getByText(message).closest(".workspace-toast")), true));
  assert.equal(screen.getAllByText(message).length, 1);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
  await client.invalidateQueries({ queryKey: ["relationship-memory", uid, wid, "status"] });
  assert.equal(screen.queryByText(message) === null, true);
  failureState.failedCount = MEMORY_TEST_PROGRESS_QUEUED;
  await client.invalidateQueries({ queryKey: ["relationship-memory", uid, wid, "status"] });
  await waitFor(() => assertTextPresent({ screen, text: message }));
  assert.equal(screen.queryByRole("button", { name: "Try again" }) === null, true);
  assert.equal(retryUrlCapture.urls.length, MEMORY_TEST_PROGRESS_FAILED);
  failureState.failedCount = MEMORY_TEST_PROGRESS_FAILED;
  await client.invalidateQueries({ queryKey: ["relationship-memory", uid, wid, "status"] });
  await waitFor(() => assert.equal(screen.queryByText(message) === null, true));
  failureState.failedCount = 1;
  await client.invalidateQueries({ queryKey: ["relationship-memory", uid, wid, "status"] });
  await waitFor(() => assert.equal(Boolean(screen.getByText(message).closest(".workspace-toast")), true));
});

void test("All defaults to list, evidence is linked, and detail Forget actions are scoped", async (t) => {
  installMockBroadcastChannel(t);
  const actionCapture = { values: [] as unknown[] };
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = resolveFetchUrl(input);
    if (url.endsWith("/billing/me")) {
      return new Response(JSON.stringify({ billing: paidBilling }));
    }
    const body: unknown = (() => {
      if (url.endsWith("/memory/status")) {
        return buildMemoryTestStatusBody({ progress: MEMORY_TEST_PROGRESS_SNAPSHOT_ONE_COMPLETE });
      }
      if (urlPath(url).endsWith("/memory/people")) {
        return {
          people: [{ id: pid, name: "Personqa", lastContact: memory.occurredAt, categories: ["Partnerships"] }],
        };
      }
      if (url.includes("/memory?")) {
        return { memories: [memory, { ...memory, id: pid, title: "Another development" }], nextCursor: null };
      }
      if (url.endsWith(`/memory/${mid}`)) {
        return {
          evidence: [
            {
              segmentId: mid,
              quote: "Voin tehdä videon.",
              speakerName: "Personqa",
              startedAt: memory.occurredAt,
              meetingId: mid,
            },
          ],
        };
      }
      if (url.endsWith("/memory/actions")) {
        assert.ok(url.includes(`/workspaces/${wid}/`), EXPECTED_TRUTHY);
        actionCapture.values = [...actionCapture.values, requestJson({ options })];

        return {
          /** @external memory actions wire field */
          ok: true,
        };
      }

      return url.includes("/memory?") ? { memories: [], nextCursor: null } : {};
    })();

    return new Response(JSON.stringify(body), { status: MEMORY_TEST_HTTP_OK });
  });
  const { client, screen } = mount({ node: <WorkspaceMemoryPage /> });
  t.after(() => {
    cleanup();
    client.clear();
  });
  await waitFor(() => assertTextPresent({ screen, text: memory.title }));
  assert.equal(screen.queryByRole("button", { name: "Enable Memory" }) === null, true);
  assert.equal(screen.getByRole("button", { name: "List view" }).getAttribute("aria-pressed"), "true");
  assert.equal(screen.getByRole("button", { name: "Card view" }).getAttribute("aria-pressed"), "false");
  assert.equal(screen.queryByRole("button", { name: "Always remember" }) === null, true);
  assert.equal(screen.queryByRole("checkbox") === null, true);
  fireEvent.click(screen.getByText(memory.title));
  fireEvent.click(screen.getByRole("button", { name: "Forget" }));
  const dialog = screen.getByRole("dialog", { name: "Forget this information?" });
  fireEvent.click(requiredElement({ value: dialog.querySelector("button:last-child"), label: "confirm button" }));
  await waitFor(() => assert.deepEqual(actionCapture.values, [{ ids: [mid], action: "forget" }]));
  fireEvent.click(screen.getByText(memory.title));
  assert.equal(screen.container.querySelector(".relationship-detail-people") === null, true);
  assert.ok(
    screen.getByRole("link", { name: "Open Personqa" }).getAttribute("href")?.includes(`/people/${pid}?return=`) ===
      true,
  );
  const transcriptButton = screen.getByRole("button", { name: "View transcript" });
  fireEvent.click(transcriptButton);
  assert.ok(screen.container.querySelector(".relationship-memory-page.is-focused-memory"), EXPECTED_TRUTHY);
  assert.equal(screen.container.querySelector(".relationship-browser-tools[inert]") === null, true);
  assert.equal(screen.getByRole("button", { name: "Add filter" }).hasAttribute("disabled"), false);
  assert.ok(screen.container.querySelector(".relationship-memory-row:not(.is-expanded)[inert]"), EXPECTED_TRUTHY);
  assert.ok(screen.container.querySelector(INERT_GROUP_HEADING_SELECTOR), EXPECTED_TRUTHY);
  await waitFor(() => assertTextPresent({ screen, text: WORKSPACE_MEMORY_TEST_COPY.finnishEvidenceQuote }));
  assert.equal(screen.container.querySelector(".relationship-evidence a") === null, true);
  assert.ok(screen.container.querySelector(".relationship-evidence footer time"), EXPECTED_TRUTHY);
  fireEvent.keyDown(screen.getByRole("button", { name: "Back to memory" }), { key: "Escape" });
  assert.equal(screen.container.querySelector(".is-focused-memory") === null, true);
  assertRolePresent({ screen, role: "button", name: "Close memory" });
  assert.equal(document.activeElement, transcriptButton);
  assert.equal(screen.container.querySelector(".relationship-memory-row[inert]") === null, true);
  fireEvent.click(transcriptButton);
  fireEvent.click(screen.getByRole("button", { name: "Back to memory" }));
  assert.equal(screen.container.querySelector(".is-focused-memory") === null, true);
  assert.equal(document.activeElement, transcriptButton);
  fireEvent.click(screen.getByText(memory.description));
  assert.ok(screen.container.querySelector(".relationship-memory-detail"), EXPECTED_TRUTHY);
  fireEvent.click(document.body);
  assert.equal(screen.container.querySelector(".relationship-memory-detail") === null, true);
  fireEvent.click(screen.getByText(memory.title));
  fireEvent.click(screen.getByRole("button", { name: "View transcript" }));
  fireEvent.click(screen.getByText("Voin tehdä videon."));
  assert.ok(screen.container.querySelector(".is-focused-memory"), EXPECTED_TRUTHY);
  fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
  assert.equal(screen.container.querySelector(".relationship-memory-detail") === null, true);
  assert.equal(screen.container.querySelector(".is-focused-memory") === null, true);
  assert.equal(screen.getByRole("button", { name: "Add filter" }).getAttribute("aria-expanded"), "true");
});
void test("sensitive setting defaults off and updates only this workspace", async (t) => {
  installMockBroadcastChannel(t);
  const preferenceState = { value: memoryPreferencesSchema.parse({}) };
  const updateCapture = { values: [] as unknown[] };
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = resolveFetchUrl(input);
    if (url.endsWith("/preferences")) {
      preferenceState.value = memoryPreferencesSchema.parse(requestJson({ options }));
      updateCapture.values = [...updateCapture.values, preferenceState.value];

      return new Response("{}");
    }

    return new Response(
      JSON.stringify({
        ...buildMemoryTestStatusBody({ progress: MEMORY_TEST_PROGRESS_SNAPSHOT_ALL_IDLE }),
        preferences: preferenceState.value,
      }),
    );
  });
  const { client, screen } = mount({ node: <MemorySettingsPanel /> });
  t.after(() => {
    cleanup();
    client.clear();
  });
  await waitFor(() => assertRolePresent({ screen, role: "switch", name: "Include sensitive topics in memory" }));
  const toggle = requiredHtmlInputElement({
    value: screen.getByRole("switch", { name: "Include sensitive topics in memory" }),
    label: "sensitive topics switch",
  });
  assert.equal(screen.queryByRole("switch", { name: "Remember your meetings" }) === null, true);
  assert.equal(screen.getAllByRole("switch").length, 1);
  assert.equal(screen.queryByLabelText("Memory language") === null, true);
  assert.equal(screen.queryByLabelText("Fade memories about job candidates after") === null, true);
  assert.equal(screen.getByRole("link", { name: "Learn more" }).getAttribute("href"), "/docs/memory");
  assert.notEqual(
    screen.queryByText(
      /Allow Ready to save details about sensitive topics like health conditions from future meetings to memory/,
    ),
    null,
  );
  assert.equal(toggle.checked, false);
  fireEvent.click(toggle);
  await waitFor(() => assert.equal(updateCapture.values.length, 1));
  assert.equal(preferenceState.value.includeSensitive, true);
});
void test("memory browser lists and transcript evidence stay out of durable browser storage", () => {
  assert.equal(shouldPersistQuery(["relationship-memory", uid, wid, "list"]), false);
  assert.equal(shouldPersistQuery(["relationship-memory", uid, wid, "evidence", mid]), false);
});

void test("a large single-month People group mounts only nearby 50-row chunks", async (t) => {
  const people = Array.from({ length: MEMORY_TEST_PEOPLE_SCALE_COUNT }, (_, index) => ({
    id: `scale-${index}`,
    name: `Scale person ${index}`,
    lastContact: memory.occurredAt,
    categories: [],
  }));
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = resolveFetchUrl(input);

    return Response.json(
      url.includes("/memory/people")
        ? { people }
        : url.endsWith("/memory/status")
          ? buildMemoryTestStatusBody({})
          : url.endsWith("/billing/me")
            ? { billing: paidBilling }
            : { memories: [], nextCursor: null },
    );
  });
  const { client, screen } = mount({ node: <WorkspaceMemoryPage view="people" /> });
  t.after(() => {
    cleanup();
    client.clear();
  });
  await screen.findByRole("link", { name: "Open Scale person 0" });
  assert.ok(
    screen.container.querySelectorAll("[data-person-id]").length <= MEMORY_TEST_PEOPLE_VISIBLE_ROW_CAP,
    EXPECTED_TRUTHY,
  );
  assert.equal(screen.queryByRole("link", { name: "Open Scale person 4999" }) === null, true);
});

async function runMemoryPreloadRestoreTest(input: { view: "all" | "people"; t: TestContext }) {
  const { view, t } = input;
  const requestCapture = { urls: [] as string[] };
  const person = { id: pid, name: "Personqa", lastContact: memory.occurredAt, categories: [] };
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = resolveFetchUrl(input);
    requestCapture.urls = [...requestCapture.urls, url];
    if (url.endsWith("/memory/status")) {
      return new Promise<Response>(() => {});
    }
    if (url.endsWith("/billing/me")) {
      return Response.json({ billing: paidBilling });
    }

    return Response.json(
      urlPath(url).endsWith("/memory/people") ? { people: [person] } : { memories: [memory], nextCursor: null },
    );
  });
  function Harness() {
    useMemoryNavigationCache({
      session: { token: "test-token", userId: uid, workspaceId: wid },
      isEnabled: true,
    });
    const [isMemoryHarnessOpen, setIsMemoryHarnessOpen] = useState(false);

    return (
      <>
        <button type="button" onClick={() => setIsMemoryHarnessOpen(true)}>
          {WORKSPACE_MEMORY_TEST_COPY.openMemoryHarnessLabel}
        </button>
        {isMemoryHarnessOpen ? <WorkspaceMemoryPage view={view} /> : null}
      </>
    );
  }
  const first = mount({
    node: <Harness />,
    searchParams: new URLSearchParams(),
    plan: user.plan,
    cachedBilling: paidBilling,
    memoryAvailable: true,
  });
  await waitFor(() => {
    assert.equal(
      first.client.getQueryData<{ pages: { people: unknown[] }[] }>(["relationship-memory", uid, wid, "people", {}])
        ?.pages[0]?.people.length,
      1,
    );
    assert.equal(
      first.client
        .getQueriesData({ queryKey: ["relationship-memory", uid, wid, "list"] })
        .filter(([, data]) => Boolean(data)).length,
      1,
    );
  });
  const text = view === "all" ? memory.title : person.name;
  fireEvent.click(first.screen.getByRole("button", { name: WORKSPACE_MEMORY_TEST_COPY.openMemoryHarnessLabel }));
  assertTextPresent({ screen: first.screen, text });
  assert.equal(first.screen.queryByText("Loading memory…") === null, true);
  assert.equal(requestCapture.urls.filter((url) => url.includes("/memory?")).length, MEMORY_TEST_SINGLE_FETCH_COUNT);
  assert.equal(
    requestCapture.urls.filter((url) => urlPath(url).endsWith("/memory/people")).length,
    MEMORY_TEST_SINGLE_FETCH_COUNT,
  );
  const saved = dehydrate(first.client, {
    shouldDehydrateQuery: (query) => query.state.status === "success" && shouldPersistQuery(query.queryKey),
  });
  assert.equal(saved.queries.length, 0);
  cleanup();
  first.client.clear();
  await assertMemoryPreloadRefetchesAfterReload({ view, saved, requestCapture, text, t });
}

async function assertMemoryPreloadRefetchesAfterReload(input: {
  view: "all" | "people";
  saved: ReturnType<typeof dehydrate>;
  requestCapture: { urls: string[] };
  text: string;
  t: TestContext;
}) {
  const { view, saved, requestCapture, text, t } = input;
  function RestoredPage({ client }: { client: QueryClient }) {
    const [isRestored] = useState(() => {
      hydrate(client, saved);

      return true;
    });

    return isRestored ? <WorkspaceMemoryPage view={view} /> : null;
  }
  function RestoreHarness() {
    const client = useQueryClient();

    return <RestoredPage client={client} />;
  }
  const restored = mount({
    node: <RestoreHarness />,
    searchParams: new URLSearchParams(),
    plan: user.plan,
    cachedBilling: paidBilling,
    memoryAvailable: true,
  });
  t.after(() => {
    cleanup();
    restored.client.clear();
  });
  await waitFor(() => assertTextPresent({ screen: restored.screen, text }));
  const matching = requestCapture.urls.filter((url) =>
    view === "all" ? url.includes("/memory?") : urlPath(url).endsWith("/memory/people"),
  );
  assert.ok(
    matching.length > MEMORY_TEST_SINGLE_FETCH_COUNT,
    "Reload must fetch authorized content rather than restore a persistent copy.",
  );
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error(WORKSPACE_MEMORY_TEST_COPY.offlineFetchError);
  });
  await act(async () => {
    await restored.client.invalidateQueries({
      queryKey: ["relationship-memory", uid, wid],
      predicate: (query) => query.queryKey[3] === "list" || query.queryKey[3] === "people",
    });
  });
  assertTextPresent({ screen: restored.screen, text });
}

(["all", "people"] as const).forEach((view) => {
  void test(`${view} preloads in memory but refetches after reload without a persistent content copy`, async (t) => {
    await runMemoryPreloadRestoreTest({ view, t });
  });
});

void test("filter menu combines category, person and dates; search applies on submit and chips clear independently", async (t) => {
  const changeCapture = { values: [] as unknown[] };
  const searchCapture = { values: [] as string[] };
  const screen = render(
    <MemoryBrowserToolbar
      view="all"
      people={[{ id: pid, name: "Personqa", lastContact: memory.occurredAt, categories: ["Partnerships"] }]}
      filters={{ category: "Partnerships", person: pid, from: "", to: "" }}
      onChange={(value) => {
        changeCapture.values = [...changeCapture.values, value];
      }}
      query="demo"
      search=""
      setQuery={() => {}}
      onSearch={(value) => {
        searchCapture.values = [...searchCapture.values, value];
      }}
    />,
  );
  t.after(cleanup);
  fireEvent.submit(screen.getByRole("search"));
  assert.deepEqual(searchCapture.values, ["demo"]);
  fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Category" }));
  assert.deepEqual(
    screen.getAllByRole("menuitemcheckbox").map((item) => item.textContent.trim()),
    [
      "Sales",
      "Customers",
      "Recruiting",
      "Team",
      "Projects",
      "Partnerships",
      "Investors",
      "Vendors",
      "Mentoring",
      "Networking",
      "Personal",
      "General",
    ],
  );
  fireEvent.change(screen.getByRole("searchbox", { name: "Search category filters" }), {
    target: { value: "recr" },
  });
  assert.ok(!screen.queryByRole("menuitemcheckbox", { name: "Sales" }), EXPECTED_TRUTHY);
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Recruiting" }));
  assert.deepEqual(changeCapture.values.at(-1), { category: "Recruiting", categoryOperator: "is" });
  assert.equal(screen.queryByRole("menu", { name: "Add memory filter" }) === null, true);
  fireEvent.click(screen.getByRole("button", { name: "Remove Personqa filter" }));
  assert.deepEqual(changeCapture.values.at(-1), { person: "" });
  fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Date" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Custom date or timeframe…" }));
  fireEvent.input(screen.getByLabelText("From date"), { target: { value: "2026-09-01" } });
  fireEvent.input(screen.getByLabelText("Through date"), { target: { value: "2026-09-11" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply date filter" }));
  assert.deepEqual(changeCapture.values.at(-1), {
    from: new Date("2026-09-01T00:00:00").toISOString(),
    to: new Date("2026-09-12T00:00:00").toISOString(),
    dateOperator: "is",
  });
  fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
  fireEvent.keyDown(screen.getByRole("menu", { name: "Add memory filter" }), { key: "Escape" });
  assert.equal(screen.queryByRole("menu", { name: "Add memory filter" }) === null, true);
  assert.ok(document.activeElement === screen.getByRole("button", { name: "Add filter" }), EXPECTED_TRUTHY);
});

void test("filter flyouts open on hover, navigate by keyboard, toggle selections and dismiss outside", async (t) => {
  const changeCapture = { values: [] as unknown[] };
  const screen = render(
    <MemoryBrowserToolbar
      view="all"
      people={[{ id: pid, name: "Personqa", lastContact: memory.occurredAt, categories: ["Partnerships"] }]}
      filters={{ category: "Partnerships", person: "", from: "", to: "" }}
      onChange={(patch) => {
        changeCapture.values = [...changeCapture.values, patch];
      }}
      query=""
      search=""
      setQuery={() => {}}
      onSearch={() => {}}
    />,
  );
  t.after(cleanup);
  const trigger = screen.getByRole("button", { name: "Add filter" });
  fireEvent.click(trigger);
  fireEvent.pointerEnter(screen.getByRole("menuitem", { name: "Category" }), {
    pointerType: "mouse",
  });
  assertRolePresent({ screen, role: "menu", name: "Category filters" });
  const selected = screen.getByRole("menuitemcheckbox", { name: "Partnerships" });
  assert.equal(selected.getAttribute("aria-checked"), "true");
  fireEvent.pointerEnter(screen.getByRole("menuitem", { name: "Person" }), {
    pointerType: "mouse",
  });
  assertRolePresent({ screen, role: "menuitemcheckbox", name: "Personqa" });
  assert.equal(screen.queryByRole("menu", { name: "Category filters" }) === null, true);
  fireEvent.keyDown(trigger, { key: "Escape" });

  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const category = screen.getByRole("menuitem", { name: "Category" });
  await waitFor(() => assert.ok(document.activeElement === category, EXPECTED_TRUTHY));
  fireEvent.keyDown(category, { key: "ArrowRight" });
  const input = screen.getByRole("searchbox", { name: "Search category filters" });
  assert.ok(document.activeElement === input, EXPECTED_TRUTHY);
  fireEvent.keyDown(input, { key: "ArrowUp" });
  assert.ok(document.activeElement === screen.getByRole("menuitemcheckbox", { name: "General" }), EXPECTED_TRUTHY);
  fireEvent.keyDown(document.activeElement, { key: "ArrowLeft" });
  assert.ok(document.activeElement === category, EXPECTED_TRUTHY);
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Partnerships" }));
  assert.deepEqual(changeCapture.values.at(-1), { category: "", categoryOperator: "is" });
  assert.ok(document.activeElement === trigger, EXPECTED_TRUTHY);
  assert.equal(screen.queryByRole("menu", { name: "Add memory filter" }) === null, true);

  fireEvent.click(trigger);
  const mainSearch = screen.getByRole("searchbox", { name: "Search memories" });
  mainSearch.focus();
  fireEvent.pointerDown(mainSearch);
  assert.equal(screen.queryByRole("menu", { name: "Add memory filter" }) === null, true);
  assert.ok(document.activeElement === mainSearch, EXPECTED_TRUTHY);
});

void test("People filters expose last-contact presets and no person submenu", (t) => {
  const changeCapture = { values: [] as unknown[] };
  const screen = render(
    <MemoryBrowserToolbar
      view="people"
      people={[]}
      filters={{ category: "", person: "", from: "", to: "" }}
      onChange={(patch) => {
        changeCapture.values = [...changeCapture.values, patch];
      }}
      query=""
      search=""
      setQuery={() => {}}
      onSearch={() => {}}
    />,
  );
  t.after(cleanup);
  fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
  assert.equal(screen.queryByRole("menuitem", { name: "Person" }) === null, true);
  fireEvent.pointerEnter(screen.getByRole("menuitem", { name: "Last contact" }), {
    pointerType: "mouse",
  });
  fireEvent.change(screen.getByRole("searchbox", { name: "Search date filters" }), {
    target: { value: "1 week" },
  });
  assert.equal(screen.queryByRole("menuitemcheckbox", { name: "Older than 1 day" }) === null, true);
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Older than 1 week" }));
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - MEMORY_TEST_PEOPLE_DATE_PRESET_WEEK_DAYS);
  assert.deepEqual(changeCapture.values, [{ from: "", to: cutoff.toISOString(), dateOperator: "is" }]);
});

void test("date groups collapse without losing rows and arrow keys move between visible people", async (t) => {
  const screen = render(
    <div data-memory-browser-list>
      <MemoryGroup label="September" count={2}>
        <button data-browser-row onKeyDown={moveRowFocus}>
          Personqa
        </button>
        <button data-browser-row onKeyDown={moveRowFocus}>
          Personqx
        </button>
      </MemoryGroup>
    </div>,
  );
  t.after(cleanup);
  const first = screen.getByRole("button", { name: "Personqa" });
  first.focus();
  fireEvent.keyDown(first, { key: "ArrowDown" });
  assert.ok(document.activeElement === screen.getByRole("button", { name: "Personqx" }), EXPECTED_TRUTHY);
  fireEvent.click(screen.getByRole("button", { name: "September 2" }));
  assert.equal(screen.queryByRole("button", { name: "Personqa" }) === null, true);
  fireEvent.click(screen.getByRole("button", { name: "September 2" }));
  assertRolePresent({ screen, role: "button", name: "Personqa" });
});

function installObservedIntersectionObserver(input: {
  t: TestContext;
  observed: Set<Element>;
  intersectionObserverState: {
    callback: IntersectionObserverCallback | undefined;
    instance: IntersectionObserver | undefined;
  };
}) {
  const { t, observed, intersectionObserverState } = input;
  const IntersectionObserverConstructor = globalThis.IntersectionObserver;
  t.mock.method(globalThis, "IntersectionObserver", function (callback: IntersectionObserverCallback) {
    intersectionObserverState.callback = callback;
    const instance = new IntersectionObserverConstructor(callback);
    intersectionObserverState.instance = instance;

    return {
      observe(element: Element) {
        if (element.hasAttribute("data-people-group")) {
          observed.add(element);
        }
        instance.observe(element);
      },
      unobserve: (element: Element) => instance.unobserve(element),
      disconnect: () => instance.disconnect(),
      takeRecords: () => instance.takeRecords(),
      root: instance.root,
      rootMargin: instance.rootMargin,
      thresholds: instance.thresholds,
    };
  });
}

async function runPeopleKeyboardNavigationTest(t: TestContext) {
  installMockBroadcastChannel(t);
  const observed = new Set<Element>();
  const intersectionObserverState: {
    callback: IntersectionObserverCallback | undefined;
    instance: IntersectionObserver | undefined;
  } = { callback: undefined, instance: undefined };
  installObservedIntersectionObserver({ t, observed, intersectionObserverState });
  const people = Array.from({ length: MEMORY_TEST_PEOPLE_KEYBOARD_FIXTURE_COUNT }, (_, index) => ({
    id: `person-${index}`,
    name: `Person ${index}`,
    categories: [],
    lastContact: new Date(
      WORKSPACE_MEMORY_TEST_COPY.personFixtureBaseYear,
      WORKSPACE_MEMORY_TEST_COPY.personFixtureMonthBase -
        Math.floor(index / WORKSPACE_MEMORY_TEST_COPY.personFixtureMonthOffsetDivisor),
      WORKSPACE_MEMORY_TEST_COPY.personFixtureDay,
      WORKSPACE_MEMORY_TEST_COPY.personFixtureHour,
    ).toISOString(),
  }));
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = resolveFetchUrl(input);
    const body = url.endsWith("/billing/me")
      ? { billing: paidBilling }
      : url.endsWith("/memory/status")
        ? buildMemoryTestStatusBody({})
        : urlPath(url).endsWith("/memory/people")
          ? { people }
          : { memories: [], nextCursor: null };

    return new Response(JSON.stringify(body));
  });
  const { client, screen } = mount({ node: <WorkspaceMemoryPage view="people" /> });
  t.after(() => {
    cleanup();
    client.clear();
  });
  const first = await screen.findByRole("link", { name: "Open Person 0" });
  assert.equal(screen.queryByRole("link", { name: "Open Person 89" }) === null, true);
  act(() => first.focus());
  fireEvent.keyDown(first, { key: "End" });
  assert.equal(document.activeElement, screen.getByRole("link", { name: "Open Person 89" }));

  // Simulate observer delivery before it reports the destination as visible.
  act(() => {
    const onIntersection = intersectionObserverState.callback;
    if (onIntersection === undefined || intersectionObserverState.instance === undefined) {
      throw new Error(WORKSPACE_MEMORY_TEST_COPY.missingIntersectionObserver);
    }
    onIntersection(
      [...observed].map((target) => ({
        boundingClientRect: target.getBoundingClientRect(),
        intersectionRatio: 0,
        intersectionRect: new DOMRect(),
        isIntersecting: false,
        isVisible: false,
        rootBounds: null,
        target,
        time: performance.now(),
      })),
      intersectionObserverState.instance,
    );
  });
  assert.equal(screen.queryByRole("link", { name: "Open Person 0" }) === null, true);
  assert.equal(document.activeElement, screen.getByRole("link", { name: "Open Person 89" }));
  fireEvent.keyDown(document.activeElement, { key: "Home" });
  assert.equal(document.activeElement, screen.getByRole("link", { name: "Open Person 0" }));

  const lastInFirstGroup = screen.getByRole("link", { name: "Open Person 29" });
  act(() => lastInFirstGroup.focus());
  fireEvent.keyDown(lastInFirstGroup, { key: "ArrowDown" });
  assert.equal(document.activeElement, screen.getByRole("link", { name: "Open Person 30" }));
  fireEvent.keyDown(document.activeElement, { key: "ArrowUp" });
  assert.equal(document.activeElement, screen.getByRole("link", { name: "Open Person 29" }));

  const groupLabels = [...screen.container.querySelectorAll<HTMLElement>("[data-people-group]")].map((group) => {
    const label = group.dataset.peopleGroup;
    if (label === undefined) {
      throw new Error(WORKSPACE_MEMORY_TEST_COPY.missingPeopleGroup);
    }

    return label;
  });
  const thirdGroupLabel = groupLabels[2];
  const firstGroupLabel = groupLabels[0];
  if (thirdGroupLabel === undefined || firstGroupLabel === undefined) {
    throw new Error(WORKSPACE_MEMORY_TEST_COPY.missingPeopleGroup);
  }
  fireEvent.click(screen.getByRole("button", { name: `${thirdGroupLabel} 30` }));
  fireEvent.keyDown(document.activeElement, { key: "End" });
  assert.equal(document.activeElement, screen.getByRole("link", { name: "Open Person 59" }));
  fireEvent.click(screen.getByRole("button", { name: `${firstGroupLabel} 30` }));
  fireEvent.keyDown(document.activeElement, { key: "Home" });
  assert.equal(document.activeElement, screen.getByRole("link", { name: "Open Person 30" }));
}

void test("People keyboard navigation renders offscreen destinations and skips collapsed groups", async (t) => {
  await runPeopleKeyboardNavigationTest(t);
});

void test("person standing orders by chronology then importance and links unique titles into All", async (t) => {
  installMockBroadcastChannel(t);
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = resolveFetchUrl(input);
    if (url.endsWith("/billing/me")) {
      return new Response(JSON.stringify({ billing: paidBilling }));
    }
    const person = {
      id: pid,
      name: "Personqa",
      lastContact: memory.occurredAt,
      categories: ["Partnerships"],
    };
    const body: unknown = (() => {
      if (url.endsWith("/memory/status")) {
        return buildMemoryTestStatusBody({ progress: MEMORY_TEST_PROGRESS_SNAPSHOT_ONE_COMPLETE });
      }
      if (urlPath(url).endsWith("/memory/people")) {
        return { people: [person] };
      }
      if (url.endsWith(`/memory/people/${pid}`)) {
        return {
          person,
          projection: {
            summary: [{ text: WORKSPACE_MEMORY_TEST_COPY.personProjectionSummary, memoryIds: [mid] }],
            standing: [
              { text: WORKSPACE_MEMORY_TEST_COPY.standingVideoStep, memoryIds: [mid, wid] },
              { text: WORKSPACE_MEMORY_TEST_COPY.standingAnotherSentence, memoryIds: [wid, uid] },
            ],
          },
          memories: [
            memory,
            {
              ...memory,
              id: wid,
              title: "Newer proposal",
              occurredAt: "2026-09-17T17:00:00Z",
              importance: MEMORY_TEST_MEMORY_IMPORTANCE_MEDIUM,
            },
            {
              ...memory,
              id: uid,
              title: "Joining terms unresolved",
              occurredAt: "2026-09-17T17:00:00Z",
              importance: MEMORY_TEST_MEMORY_IMPORTANCE_HIGH,
            },
          ],
          meetings: [{ id: mid, title: "Demo discussion", occurredAt: memory.occurredAt }],
          /** @external person detail wire field */
          processing: false,
        };
      }
      if (url.endsWith(`/memory/${mid}`)) {
        return {
          evidence: [],
          people: [{ id: pid, name: "Personqa", lastContact: memory.occurredAt, categories: ["Partnerships"] }],
        };
      }

      return url.includes("/memory?") ? { memories: [], nextCursor: null } : {};
    })();

    return new Response(JSON.stringify(body));
  });
  const { client, screen } = mount({ node: <WorkspaceMemoryPage view="people" personId={pid} /> });
  t.after(() => {
    cleanup();
    client.clear();
  });
  await waitFor(() => assertTextPresent({ screen, text: WORKSPACE_MEMORY_TEST_COPY.personProjectionSummary }));
  assertRolePresent({ screen, role: "link", name: /Demo discussion/ });
  const links = [...document.querySelectorAll(".relationship-standing-list a")];
  assert.deepEqual(
    links.map((link) => link.querySelector(".relationship-standing-title")?.textContent),
    ["Joining terms unresolved", "Newer proposal", memory.title],
  );
  assert.deepEqual(
    links.map((link) => link.getAttribute("href")),
    [`/workspace/memory?memory=${uid}`, `/workspace/memory?memory=${wid}`, `/workspace/memory?memory=${mid}`],
  );
  assert.equal(screen.queryByText("The last recorded next step was a video.") === null, true);
  assert.equal(screen.queryByText("Another standing sentence.") === null, true);
});

void test("inline person links preserve Unicode names and do not guess ambiguous first names", () => {
  const people = [
    { id: "one", name: "Personqa Personrf" },
    { id: "two", name: "Personqa Personre" },
  ];
  const text = "Personqa met Personqa Personrf, then Personqa Personre.";
  const mentions = memoryPersonMentions({ text, people });
  assert.deepEqual(
    mentions.map((m) => [text.slice(m.start, m.end), m.personId]),
    [
      ["Personqa Personrf", "one"],
      ["Personqa Personre", "two"],
    ],
  );
  const shortText = "Personqa asked Personqa again; Personqala is not a match.";
  assert.deepEqual(
    memoryPersonMentions({
      text: shortText,
      people: [
        (() => {
          const person = people[0];
          if (person === undefined) {
            throw new Error(WORKSPACE_MEMORY_TEST_COPY.missingPerson);
          }

          return person;
        })(),
      ],
    }).map((m) => shortText.slice(m.start, m.end)),
    ["Personqa", "Personqa"],
  );
  assert.deepEqual(memoryPersonMentions({ text: UNRELATED_MENTION_TEXT, people }), []);
});

void test("All follows a memory link through pagination and opens its card in the list", async (t) => {
  const pageCapture = { urls: [] as string[] };
  installMockBroadcastChannel(t);
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = resolveFetchUrl(input);
    if (url.endsWith("/billing/me")) {
      return new Response(JSON.stringify({ billing: paidBilling }));
    }
    const body: unknown = (() => {
      if (url.endsWith(WORKSPACE_MEMORY_TEST_COPY.memoryStatusPathSuffix)) {
        return buildMemoryTestStatusBody({ progress: MEMORY_TEST_PROGRESS_SNAPSHOT_TWO_COMPLETE });
      }
      if (urlPath(url).endsWith("/memory/people")) {
        return { people: [] };
      }
      if (url.includes("/memory?")) {
        pageCapture.urls = [...pageCapture.urls, url];

        return url.includes(`before=${pid}`)
          ? { memories: [memory], nextCursor: null }
          : { memories: [{ ...memory, id: pid, title: "Newer memory" }], nextCursor: pid };
      }
      if (url.endsWith(`/memory/${mid}`)) {
        return {
          evidence: [],
          people: [{ id: pid, name: "Personqa", lastContact: memory.occurredAt, categories: ["Partnerships"] }],
        };
      }

      return url.includes("/memory?") ? { memories: [], nextCursor: null } : {};
    })();

    return new Response(JSON.stringify(body));
  });
  const { client, screen } = mount({
    node: <WorkspaceMemoryPage />,
    searchParams: new URLSearchParams({ memory: mid }),
  });
  t.after(() => {
    cleanup();
    client.clear();
  });
  await waitFor(() => assertRolePresent({ screen, role: "heading", name: memory.title }));
  assert.equal(pageCapture.urls.length, MEMORY_TEST_PAGINATION_FETCH_COUNT);
  assert.ok(document.querySelector(`[data-memory-id="${mid}"] .relationship-memory-detail`), EXPECTED_TRUTHY);
  assertRolePresent({ screen, role: "button", name: "Open memory: Newer memory" });
  fireEvent.click(screen.getByRole("button", { name: "Close memory" }));
  await waitFor(() => assert.equal(screen.queryByRole("heading", { name: memory.title }) === null, true));
  assertRolePresent({ screen, role: "button", name: `Open memory: ${memory.title}` });
});

void test("active filter pill segments edit values and exclusion rules in place", async (t) => {
  function Harness() {
    const [filters, setFilters] = React.useState<BrowserFilters>({
      category: "Sales",
      person: "",
      from: "",
      to: "",
    });

    return (
      <MemoryBrowserToolbar
        view="all"
        people={[{ id: pid, name: "Personqa", lastContact: memory.occurredAt, categories: [] }]}
        filters={filters}
        onChange={(patch) => setFilters((previous) => ({ ...previous, ...patch }))}
        query=""
        search=""
        setQuery={() => {}}
        onSearch={() => {}}
      />
    );
  }
  const screen = render(<Harness />);
  t.after(cleanup);
  fireEvent.click(screen.getByRole("button", { name: "Change filter rule from is" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "is not" }));
  assertRolePresent({ screen, role: "button", name: "Change filter rule from is not" });
  fireEvent.click(screen.getByRole("button", { name: "Change filter value from Sales" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Search category filter values" }), {
    target: { value: "recr" },
  });
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Recruiting" }));
  assertRolePresent({ screen, role: "button", name: "Change filter value from Recruiting" });
  fireEvent.click(screen.getByRole("button", { name: "Change filter type from Category" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Person" }));
  assertRolePresent({ screen, role: "button", name: "Change filter value from Personqa" });
  fireEvent.click(screen.getByRole("button", { name: "Change filter value from Personqa" }));
  fireEvent.keyDown(screen.getByRole("menu", { name: "Change value filter" }), { key: "Escape" });
  assert.equal(document.activeElement, screen.getByRole("button", { name: "Change filter value from Personqa" }));
  fireEvent.pointerDown(screen.getByRole("button", { name: "Remove Personqa filter" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove Personqa filter" }));
  assert.ok(document.querySelector("[data-filter-presence][data-exiting][inert]"), EXPECTED_TRUTHY);
  await waitFor(() => assert.equal(document.querySelector("[data-filter-presence]") === null, true));
});

void test("re-adding a removed negated filter starts with an inclusive rule", async (t) => {
  await (["category", "person", "date-preset", "date-custom"] as const).reduce(async (previous, kind) => {
    await previous;
    await t.test(kind, async (t) => {
      const initial = {
        category: kind === "category" ? "Sales" : "",
        person: kind === "person" ? pid : "",
        from: kind.startsWith("date") ? "2026-09-01T00:00:00.000Z" : "",
        to: "",
        categoryOperator: "is_not",
        personOperator: "is_not",
        dateOperator: "is_not",
      };
      const patchCapture = { values: [] as Partial<BrowserFilters>[] };
      function Harness() {
        const [filters, setFilters] = React.useState(initial);

        return (
          <MemoryBrowserToolbar
            view="all"
            people={[{ id: pid, name: "Personqa", lastContact: memory.occurredAt, categories: [] }]}
            filters={filters}
            onChange={(patch) => {
              patchCapture.values = [...patchCapture.values, patch];
              setFilters((previousFilters) => ({ ...previousFilters, ...patch }));
            }}
            query=""
            search=""
            setQuery={() => {}}
            onSearch={() => {}}
          />
        );
      }
      const screen = render(<Harness />);
      t.after(cleanup);
      assertRolePresent({ screen, role: "button", name: "Change filter rule from is not" });
      fireEvent.click(screen.getByRole("button", { name: /^Remove .* filter$/ }));
      await waitFor(() => assert.equal(document.querySelector("[data-filter-presence]") === null, true));
      fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
      fireEvent.click(
        screen.getByRole("menuitem", {
          name: kind === "category" ? "Category" : kind === "person" ? "Person" : "Date",
        }),
      );
      if (kind === "date-custom") {
        fireEvent.click(screen.getByRole("menuitem", { name: "Custom date or timeframe…" }));
        fireEvent.input(screen.getByLabelText("From date"), { target: { value: "2026-09-01" } });
        fireEvent.click(screen.getByRole("button", { name: "Apply date filter" }));
      } else {
        fireEvent.click(
          screen.getByRole("menuitemcheckbox", {
            name: kind === "category" ? "Sales" : kind === "person" ? "Personqa" : "Older than 1 week",
          }),
        );
      }
      const operator = kind === "category" ? "categoryOperator" : kind === "person" ? "personOperator" : "dateOperator";
      assert.equal(patchCapture.values.at(-1)?.[operator], "is");
      assertRolePresent({
        screen,
        role: "button",
        name: "Change filter rule from is",
      });
    });
  }, Promise.resolve());
});

async function assertUnsubscribedUpgradeBrowser(input: {
  view: "all" | "people";
  hasRecords: boolean;
  screen: ReturnType<typeof mount>["screen"];
}) {
  const { view, hasRecords, screen } = input;
  await waitFor(() => assertRolePresent({ screen, role: "button", name: "Upgrade to Pro" }));
  assertRolePresent({ screen, role: "searchbox", name: /Search/ });
  assertRolePresent({ screen, role: "link", name: "Memory settings" });
  const gate = requiredElement({
    value: document.querySelector(".relationship-memory-upgrade"),
    label: "upgrade gate",
  });
  if (hasRecords) {
    await waitFor(() => assert.equal(Boolean(gate.querySelector(".relationship-memory-upgrade-preview")), true));
    const preview = requiredElement({
      value: gate.querySelector(".relationship-memory-upgrade-preview"),
      label: "upgrade preview",
    });
    assert.equal(preview.getAttribute("aria-hidden"), view === "people" ? null : "true");
    assert.equal(preview.hasAttribute("inert"), view !== "people");
    assert.ok(preview.textContent.includes(view === "people" ? "Personqa" : memory.title), EXPECTED_TRUTHY);
  } else {
    assert.equal(gate.querySelector(".relationship-memory-upgrade-preview") === null, true);
  }
  assert.equal(screen.queryByRole("button", { name: `Open memory: ${memory.title}` }) === null, true);
  if (view === "people" && hasRecords) {
    const personLink = screen.getByRole("link", { name: "Open Personqa" });
    assert.ok(
      personLink.getAttribute("href")?.startsWith(`/workspace/memory/people/${pid}?return=`) === true,
      EXPECTED_TRUTHY,
    );
    assert.equal(personLink.closest('[inert], [aria-hidden="true"]') === null, true);
  } else {
    assert.equal(screen.queryByRole("link", { name: "Open Personqa" }) === null, true);
  }
  if (view === "all") {
    assert.equal(screen.queryByRole("complementary", { name: "Memory dates" }) === null, true);
    fireEvent.click(screen.getByRole("button", { name: "Card view" }));
    assertRolePresent({ screen, role: "button", name: "Upgrade to Pro" });
    assert.equal(Boolean(screen.container.querySelector(".memory-card-stage")), hasRecords);
    assert.equal(screen.queryByRole("button", { name: "View transcript" }) === null, true);
    assert.equal(screen.queryByRole("button", { name: "Forget" }) === null, true);
    if (hasRecords) {
      assertRolePresent({ screen, role: "complementary", name: "Memory dates" });
      assertRolePresent({ screen, role: "button", name: "Go to an older memory" });
      assert.ok(screen.container.querySelector(".relationship-memory-detail[inert]"), EXPECTED_TRUTHY);
    }
    fireEvent.click(screen.getByRole("button", { name: "List view" }));
    assert.ok(!screen.container.querySelector(".memory-card-stage"), EXPECTED_TRUTHY);
    assertRolePresent({ screen, role: "button", name: "Upgrade to Pro" });
  }
}

async function runUpgradeBrowserMatrixTest(options: {
  view: "all" | "people";
  hasRecords: boolean;
  isSubscribed: boolean;
  t: TestContext;
}) {
  const { view, hasRecords, isSubscribed, t } = options;
  t.mock.method(globalThis, "fetch", async (requestInfo: RequestInfo | URL) => {
    const url = resolveFetchUrl(requestInfo);
    const body = url.endsWith("/billing/me")
      ? {
          billing: {
            plan: "free",
            /** @external billing fixture wire field */
            subscriptionActive: isSubscribed,
            allowanceCredits: 0,
            allowanceUsed: 0,
            allowanceRemaining: 0,
            allowanceWindowEnd: null,
            poolBalance: 0,
            /** @external billing fixture wire field */
            trialEligible: !isSubscribed,
            trialCreditsUsed: 0,
            /** @external billing fixture wire field */
            hasTrialCredits: !isSubscribed,
            trialMeetingsRemaining: 0,
          },
        }
      : url.endsWith(WORKSPACE_MEMORY_TEST_COPY.memoryStatusPathSuffix)
        ? buildMemoryTestStatusBody({ progress: MEMORY_TEST_PROGRESS_SNAPSHOT_ONE_COMPLETE })
        : urlPath(url).endsWith("/memory/people")
          ? {
              people: hasRecords
                ? [
                    {
                      id: pid,
                      name: "Personqa",
                      lastContact: memory.occurredAt,
                      categories: ["Partnerships"],
                    },
                  ]
                : [],
            }
          : url.includes("/memory?")
            ? { memories: hasRecords ? [memory] : [], nextCursor: null }
            : {};

    return new Response(JSON.stringify(body), { status: MEMORY_TEST_HTTP_OK });
  });
  const { client, screen } = mount({
    node: <WorkspaceMemoryPage view={view} />,
    searchParams: new URLSearchParams(),
    plan: "business",
  });
  t.after(() => {
    cleanup();
    client.clear();
  });
  if (isSubscribed) {
    await waitFor(() => assert.equal(client.getQueryState(["workspace-trial-offer", wid, uid])?.fetchStatus, "idle"));
    await waitFor(() => assertRolePresent({ screen, role: "searchbox", name: /Search/ }));
    assert.equal(screen.queryByRole("button", { name: "Upgrade to Pro" }) === null, true);
    if (hasRecords) {
      await waitFor(() => assertTextPresent({ screen, text: view === "people" ? "Personqa" : memory.title }));
    }
  } else {
    await assertUnsubscribedUpgradeBrowser({ view, hasRecords, screen });
  }
}

(["all", "people"] as const).forEach((view) => {
  [false, true].forEach((hasRecords) => {
    [false, true].forEach((isSubscribed) => {
      void test(`${view}: ${isSubscribed ? "paid browser" : "upgrade card despite stale paid session"}, ${hasRecords ? "real preview" : "empty account"}`, async (t) => {
        await runUpgradeBrowserMatrixTest({ view, hasRecords, isSubscribed, t });
      });
    });
  });
});

void test("unknown plan verification shares one request, stays visually quiet, and recovers after failure", async (t) => {
  const billingPendingState = { isActive: true };
  const billingGate = { resolve: (_response: Response) => {}, requests: 0 };
  const pendingBilling = new Promise<Response>((resolve) => {
    billingGate.resolve = resolve;
  });
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = resolveFetchUrl(input);
    if (url.endsWith("/billing/me")) {
      billingGate.requests += 1;
      if (billingPendingState.isActive) {
        return pendingBilling;
      }

      return new Response(JSON.stringify({ billing: { ...paidBilling, plan: "free" } }));
    }
    const body = url.endsWith(WORKSPACE_MEMORY_TEST_COPY.memoryStatusPathSuffix)
      ? buildMemoryTestStatusBody({ progress: MEMORY_TEST_PROGRESS_SNAPSHOT_ALL_IDLE })
      : urlPath(url).endsWith("/memory/people")
        ? { people: [] }
        : url.includes("/memory?")
          ? { memories: [memory], nextCursor: null }
          : {};

    return new Response(JSON.stringify(body));
  });
  const { client, screen } = mount({ node: <WorkspaceMemoryPage /> });
  t.after(() => {
    cleanup();
    client.clear();
  });
  await waitFor(() => assertTextPresent({ screen, text: memory.title }));
  assert.equal(screen.queryByText("Checking your plan…") === null, true);
  assert.equal(screen.queryByRole("button", { name: "Upgrade to Pro" }) === null, true);
  assert.equal(billingGate.requests, 1, "the shell must reuse the pending plan check");
  billingGate.resolve(
    new Response(JSON.stringify({ message: WORKSPACE_MEMORY_TEST_COPY.billingUnavailableMessage }), {
      status: MEMORY_TEST_HTTP_UNAVAILABLE,
    }),
  );
  await waitFor(() => assert.match(screen.getByRole("alert").textContent, /Could not check your plan/));
  assertTextPresent({ screen, text: memory.title });
  billingPendingState.isActive = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => assertRolePresent({ screen, role: "button", name: "Upgrade to Pro" }));
});

void test("All card view shares live details, keyboard and ruler navigation, and transcript focus", async (t) => {
  installMockBroadcastChannel(t);
  const matchMedia = window.matchMedia.bind(window);
  t.mock.method(window, "matchMedia", (query: string) => {
    const result = matchMedia(query);
    if (query === "(prefers-reduced-motion: reduce)") {
      Object.defineProperty(result, "matches", { value: true });
    }

    return result;
  });
  const older = {
    ...memory,
    id: pid,
    title: "The pilot is approved",
    description: "The team approved the pilot budget.",
    occurredAt: "2026-09-10T17:00:00Z",
  };
  const oldest = {
    ...memory,
    id: wid,
    title: "Security signed off",
    occurredAt: "2026-09-09T17:00:00Z",
  };
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = resolveFetchUrl(input);
    const body = url.endsWith("/billing/me")
      ? { billing: paidBilling }
      : url.endsWith("/memory/status")
        ? buildMemoryTestStatusBody({})
        : urlPath(url).endsWith("/memory/people")
          ? { people: [] }
          : url.includes("/memory?")
            ? { memories: [memory, older, oldest], nextCursor: null }
            : url.includes("/memory/")
              ? {
                  evidence: [
                    {
                      segmentId: mid,
                      quote: "The budget is approved.",
                      speakerName: "Personrd",
                      startedAt: memory.occurredAt,
                      meetingId: mid,
                    },
                  ],
                }
              : {};

    return new Response(JSON.stringify(body));
  });
  const { client, screen } = mount({ node: <WorkspaceMemoryPage /> });
  t.after(() => {
    cleanup();
    client.clear();
  });
  await waitFor(() => assertTextPresent({ screen, text: memory.title }));
  const toggles = screen.getByRole("group", { name: "Memory layout" }).querySelectorAll("button");
  assert.equal(toggles[0]?.getAttribute("aria-label"), "List view");
  assert.equal(toggles[0].getAttribute("aria-pressed"), "true");
  assert.equal(screen.queryByRole("complementary", { name: "Memory dates" }) === null, true);
  fireEvent.click(screen.getByRole("button", { name: "Card view" }));
  assertRolePresent({ screen, role: "heading", name: memory.title });
  assertTextPresent({ screen, text: memory.description });
  fireEvent.keyDown(window, { key: "ArrowUp" });
  assertRolePresent({ screen, role: "heading", name: older.title });
  fireEvent.keyDown(window, { key: "ArrowLeft" });
  assertRolePresent({ screen, role: "heading", name: oldest.title });
  fireEvent.keyDown(window, { key: "ArrowDown" });
  assertRolePresent({ screen, role: "heading", name: older.title });
  fireEvent.keyDown(screen.getByRole("searchbox"), { key: "ArrowUp" });
  assertRolePresent({ screen, role: "heading", name: older.title });
  fireEvent.click(screen.getByRole("button", { name: "View transcript" }));
  await waitFor(() => assertTextPresent({ screen, text: WORKSPACE_MEMORY_TEST_COPY.transcriptBudgetQuote }));
  assert.ok(screen.container.querySelector(".memory-card-browser.is-focused"), EXPECTED_TRUTHY);
  fireEvent.keyDown(window, { key: "ArrowUp" });
  assertRolePresent({ screen, role: "heading", name: older.title });
  fireEvent.click(screen.getByRole("button", { name: "Back to memory" }));
  fireEvent.click(screen.getByRole("button", { name: /Go to .*Security signed off/ }));
  assertRolePresent({ screen, role: "heading", name: oldest.title });
  fireEvent.click(screen.getByRole("button", { name: "List view" }));
  assert.equal(screen.getByRole("button", { name: "List view" }).getAttribute("aria-pressed"), "true");
  assert.ok(!screen.container.querySelector(".memory-card-stage"), EXPECTED_TRUTHY);
  fireEvent.click(screen.getByRole("button", { name: "Card view" }));
  assertRolePresent({ screen, role: "heading", name: oldest.title });
});

void test("ruler ticks reverse the list order even when memories share a meeting timestamp", () => {
  const rows = [
    memory,
    { ...memory, id: pid },
    { ...memory, id: uid },
    { ...memory, id: wid, occurredAt: "2026-09-10T17:00:00Z" },
  ];
  const moments = buildMemoryRulerItems(rows).filter((item) => item.kind === "moment");
  assert.deepEqual(
    moments.map((item) => item.index),
    [...MEMORY_TEST_RULER_MOMENT_INDICES],
  );
  assert.equal(moments.at(-1)?.id, memory.id);
});

void test("incremental polls update an open memory, add arrivals and remove forgotten rows without reloading history", async (t) => {
  installMockBroadcastChannel(t);
  const polls = { list: 0, sync: 0, evidence: 0 };
  const updated = { ...memory, title: "Updated decision", description: "The revised next step." };
  const added = { ...memory, id: pid, title: "Newly processed memory" };
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = resolveFetchUrl(input);
    const body: unknown = (() => {
      if (url.endsWith("/billing/me")) {
        return { billing: paidBilling };
      }
      if (url.endsWith("/memory/status")) {
        return buildMemoryTestStatusBody({ progress: MEMORY_TEST_PROGRESS_SNAPSHOT_ONE_COMPLETE });
      }
      if (urlPath(url).endsWith("/memory/people")) {
        return { people: [] };
      }
      if (url.includes("/memory?")) {
        polls.list += 1;

        return { memories: [memory], nextCursor: null, syncCursor: "initial" };
      }
      if (url.endsWith("/memory/sync")) {
        polls.sync += 1;

        return {
          memories: polls.sync === 1 ? [updated, added] : [],
          removedIds: polls.sync === MEMORY_TEST_POLL_SYNC_REMOVE_PHASE ? [mid] : [],
          syncCursor: `sync-${polls.sync}`,
          hasMore: false,
        };
      }
      if (url.endsWith(`/memory/${mid}`)) {
        polls.evidence += 1;

        return {
          evidence: [],
          people: [{ id: pid, name: "Personqa", lastContact: memory.occurredAt, categories: ["Partnerships"] }],
        };
      }

      return url.includes("/memory?") ? { memories: [], nextCursor: null } : {};
    })();

    return new Response(JSON.stringify(body));
  });
  const { client, screen } = mount({ node: <WorkspaceMemoryPage /> });
  t.after(() => {
    cleanup();
    client.clear();
  });
  await waitFor(() => assertTextPresent({ screen, text: memory.title }));
  fireEvent.click(screen.getByRole("button", { name: `Open memory: ${memory.title}` }));
  await waitFor(() => assertTextPresent({ screen, text: memory.description }));
  await waitFor(() => assert.equal(polls.evidence, 1));
  await waitFor(() => assertRolePresent({ screen, role: "link", name: "Open Personqa" }), {
    timeout: MEMORY_TEST_WAIT_FOR_LINK_TIMEOUT_MS,
  });
  await client.invalidateQueries({ queryKey: ["relationship-memory", uid, wid, "list"] });
  await waitFor(() => assertTextPresent({ screen, text: updated.description }));
  assertTextPresent({ screen, text: added.title });
  await waitFor(() => assert.equal(polls.evidence, MEMORY_TEST_EVIDENCE_FETCH_COUNT_AFTER_SYNC));
  await client.invalidateQueries({ queryKey: ["relationship-memory", uid, wid, "list"] });
  await waitFor(() => assert.equal(screen.queryByText(updated.description) === null, true));
  assert.equal(screen.queryByText(updated.title) === null, true);
  assert.equal(polls.list, 1);
  assert.equal(polls.sync, MEMORY_TEST_POLL_SYNC_REMOVE_PHASE);
});

void test("Free person pages keep real person content inert beneath the upgrade banner and preserve Back navigation", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = resolveFetchUrl(input);
    const person = {
      id: pid,
      name: "Personqa",
      email: "personqa@example.test",
      lastContact: memory.occurredAt,
      categories: ["Partnerships"],
    };
    const body = url.endsWith("/billing/me")
      ? { billing: { ...paidBilling, plan: "free" } }
      : url.endsWith("/memory/status")
        ? buildMemoryTestStatusBody({})
        : urlPath(url).endsWith("/memory/people")
          ? { people: [person] }
          : url.endsWith(`/memory/people/${pid}`)
            ? {
                person,
                projection: {
                  summary: [{ text: WORKSPACE_MEMORY_TEST_COPY.personProjectionSummary, memoryIds: [mid] }],
                  standing: [{ text: WORKSPACE_MEMORY_TEST_COPY.standingDemoNextStep, memoryIds: [mid] }],
                },
                memories: [memory],
                meetings: [{ id: mid, title: "Demo discussion", occurredAt: memory.occurredAt }],
                /** @external person detail wire field */
                processing: false,
              }
            : { memories: [], nextCursor: null };

    return new Response(JSON.stringify(body));
  });
  const returnTo = "/workspace/memory/people?q=Personqa";
  const { client, screen } = mount({
    node: <WorkspaceMemoryPage view="people" personId={pid} />,
    searchParams: new URLSearchParams({ return: returnTo }),
  });
  t.after(() => {
    cleanup();
    client.clear();
  });
  await waitFor(() => assertRolePresent({ screen, role: "button", name: "Upgrade to Pro" }));
  const gate = requiredElement({
    value: screen.container.querySelector(".relationship-memory-upgrade.is-people-gate"),
    label: "people gate",
  });
  await waitFor(() => assert.equal(Boolean(gate.querySelector(".relationship-person-header")), true));
  const preview = requiredElement({
    value: gate.querySelector(".relationship-memory-upgrade-preview"),
    label: "upgrade preview",
  });
  assert.equal(preview.getAttribute("aria-hidden"), "true");
  assert.ok(preview.hasAttribute("inert"), EXPECTED_TRUTHY);
  assert.match(
    preview.textContent,
    /Summary.*You discussed the demo.*Past meetings.*Demo discussion.*Where things stand/s,
  );
  assert.ok(preview.textContent.includes(memory.title), EXPECTED_TRUTHY);
  assert.ok(gate.querySelector(".relationship-memory-upgrade-stage .meeting-pro-upgrade"), EXPECTED_TRUTHY);
  const back = screen.getByRole("link", { name: "Back" });
  assert.equal(back.getAttribute("href"), returnTo);
  assert.equal(back.closest('[inert], [aria-hidden="true"]') === null, true);
  assert.equal(screen.queryByRole("link", { name: "View all memories" }) === null, true);
  assert.equal(screen.queryByRole("button", { name: "Forget" }) === null, true);
});

void test("People layout preserves the same upgrade card DOM through person navigation and Back", async (t) => {
  const person = {
    id: pid,
    name: "Personqa",
    email: "personqa@example.test",
    lastContact: memory.occurredAt,
    categories: [],
  };
  const billing = { calls: 0 };
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = resolveFetchUrl(input);
    if (url.endsWith("/billing/me")) {
      billing.calls++;

      return new Response(JSON.stringify({ billing: { ...paidBilling, plan: "free" } }));
    }
    const body = url.endsWith("/memory/status")
      ? buildMemoryTestStatusBody({})
      : urlPath(url).endsWith("/memory/people")
        ? { people: [person] }
        : url.endsWith(`/memory/people/${pid}`)
          ? {
              person,
              projection: null,
              memories: [],
              meetings: [],
              /** @external person detail wire field */
              processing: false,
            }
          : {};

    return new Response(JSON.stringify(body));
  });
  function Routes() {
    const [params, setParams] = useState<{ personId?: string }>({});

    return (
      <PathParamsContext.Provider value={params}>
        <button onClick={() => setParams({ personId: pid })}>Visit person route</button>
        <button onClick={() => setParams({})}>Visit people route</button>
        <SearchParamsContext.Provider
          value={new URLSearchParams(params.personId !== undefined && params.personId !== "" ? "" : "q=Personqa")}
        >
          <PeopleLayout>{null}</PeopleLayout>
        </SearchParamsContext.Provider>
      </PathParamsContext.Provider>
    );
  }
  const { client, screen } = mount({ node: <Routes /> });
  t.after(() => {
    cleanup();
    client.clear();
  });
  const card = await screen.findByRole("region", { name: "Ready Pro" });
  const upgrade = screen.getByRole("button", { name: "Upgrade to Pro" });
  const callsBeforeNavigation = billing.calls;
  fireEvent.change(screen.getByRole("searchbox", { name: "Search people" }), {
    target: { value: "Unsubmitted draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Visit person route" }));
  assert.equal(screen.getByRole("region", { name: "Ready Pro" }), card);
  assertRolePresent({ screen, role: "link", name: "Back" });
  await waitFor(() => assert.equal(Boolean(screen.container.querySelector(".relationship-person-header")), true));
  assert.equal(screen.getByRole("button", { name: "Upgrade to Pro" }), upgrade);
  fireEvent.click(screen.getByRole("button", { name: "Visit people route" }));
  await screen.findByRole("link", { name: "Open Personqa" });
  assert.equal(screen.getByRole("region", { name: "Ready Pro" }), card);
  assert.equal(screen.getByRole("button", { name: "Upgrade to Pro" }), upgrade);
  assert.equal(billing.calls, callsBeforeNavigation);
  assert.equal(
    requiredHtmlInputElement({
      value: screen.getByRole("searchbox", { name: "Search people" }),
      label: "people searchbox",
    }).value,
    "Personqa",
  );
  assert.equal(screen.queryByRole("link", { name: "Back" }) === null, true);
});

type PeopleFilterScenario = {
  name: string;
  filters: Record<string, string | undefined>;
  names: string[];
};

const peopleFilterScenarios: PeopleFilterScenario[] = [
  { name: "name search", filters: { q: "personqa" }, names: ["Personqa"] },
  { name: "domain search", filters: { q: "north.example" }, names: ["Personqa", "Personqx"] },
  { name: "category search", filters: { q: "Partnerships" }, names: ["Personqa", "Personrd", "Personqo"] },
  { name: "company search", filters: { q: "north" }, names: ["Personqa", "Personqx"] },
  { name: "category", filters: { category: "Partnerships" }, names: ["Personqa", "Personrd", "Personqo"] },
  {
    name: "excluded category",
    filters: { category: "Partnerships", categoryOperator: "is_not" },
    names: ["Personqx"],
  },
  {
    name: "date boundaries",
    filters: { from: "2026-09-01T00:00:00Z", to: "2026-10-01T00:00:00Z" },
    names: ["Personqa", "Personqx"],
  },
  {
    name: "excluded dates",
    filters: { from: "2026-09-01T00:00:00Z", to: "2026-10-01T00:00:00Z", dateOperator: "is_not" },
    names: ["Personrd", "Personqo"],
  },
  {
    name: "combined filters",
    filters: {
      q: "north",
      category: "Partnerships",
      from: "2026-09-01T00:00:00Z",
      to: "2026-10-01T00:00:00Z",
    },
    names: ["Personqa"],
  },
];

async function runPeopleFilterSearchScenario(options: {
  isSubscribed: boolean;
  scenario: PeopleFilterScenario;
  t: TestContext;
}) {
  const { isSubscribed, scenario, t } = options;
  const people = [
    {
      id: pid,
      name: "Personqa",
      companyName: "North",
      companyDomain: "north.example",
      categories: ["Partnerships"],
      lastContact: "2026-09-01T00:00:00Z",
    },
    {
      id: uid,
      name: "Personqx",
      companyName: "North",
      companyDomain: "north.example",
      categories: ["Sales"],
      lastContact: "2026-09-30T00:00:00Z",
    },
    {
      id: mid,
      name: "Personrd",
      companyName: "South",
      categories: ["Partnerships"],
      lastContact: "2026-08-31T00:00:00Z",
    },
    {
      id: wid,
      name: "Personqo",
      companyName: "South",
      categories: ["Partnerships"],
      lastContact: "2026-10-01T00:00:00Z",
    },
  ];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = resolveFetchUrl(input);
    const body = url.endsWith("/billing/me")
      ? {
          billing: {
            ...paidBilling,
            plan: "free",
            /** @external billing fixture wire field */
            subscriptionActive: isSubscribed,
          },
        }
      : url.endsWith("/memory/status")
        ? buildMemoryTestStatusBody({})
        : urlPath(url).endsWith("/memory/people")
          ? { people }
          : {};

    return new Response(JSON.stringify(body));
  });
  const filters = Object.fromEntries(
    Object.entries(scenario.filters).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const { client, screen } = mount({
    node: <WorkspaceMemoryPage view="people" />,
    searchParams: new URLSearchParams(filters),
  });
  t.after(() => {
    cleanup();
    client.clear();
  });
  const primaryName = scenario.names[0];
  if (primaryName === undefined) {
    throw new Error(WORKSPACE_MEMORY_TEST_COPY.missingPerson);
  }
  await screen.findByRole("link", { name: `Open ${primaryName}` });
  people.forEach((person) => {
    assert.equal(
      Boolean(screen.queryByRole("link", { name: `Open ${person.name}` })),
      scenario.names.includes(person.name),
    );
  });
  const banner = screen.queryByRole("region", { name: "Ready Pro" });
  assert.equal(Boolean(banner), !isSubscribed);
  const input = screen.getByRole("searchbox", { name: "Search people" });
  fireEvent.change(input, { target: { value: "No matching person" } });
  fireEvent.submit(requiredElement({ value: input.closest("form"), label: "search form" }));
  people.forEach((person) => {
    assert.equal(screen.queryByRole("link", { name: `Open ${person.name}` }) === null, true);
  });
  if (!isSubscribed) {
    assert.equal(screen.getByRole("region", { name: "Ready Pro" }), banner);
  }
  fireEvent.change(input, { target: { value: scenario.filters.q ?? "" } });
  fireEvent.submit(requiredElement({ value: input.closest("form"), label: "search form" }));
  await screen.findByRole("link", { name: `Open ${primaryName}` });
}

[false, true].forEach((isSubscribed) => {
  peopleFilterScenarios.forEach((scenario) => {
    void test(`${isSubscribed ? "Paid" : "Free"} People applies ${scenario.name} and submitted search changes`, async (t) => {
      await runPeopleFilterSearchScenario({ isSubscribed, scenario, t });
    });
  });
});

type FreePeopleOcclusionLayout = {
  bannerTop: number;
  outerScroll: number;
  scrollportTop: number;
};

function installFreePeopleOcclusionMocks(input: { t: TestContext; layout: FreePeopleOcclusionLayout }) {
  const { t, layout } = input;
  const computedStyle = globalThis.getComputedStyle;
  t.mock.method(globalThis, "getComputedStyle", (element: Element, pseudo?: string | null) => {
    if (pseudo === "::before" && element.matches(".relationship-memory-content")) {
      return {
        position: "fixed",
        display: "block",
        top: "0px",
        height: "100px",
      };
    }

    return computedStyle(element, pseudo);
  });
  // The original method is invoked with each target element as its receiver.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = HTMLElement.prototype.getBoundingClientRect;
  t.mock.method(HTMLElement.prototype, "getBoundingClientRect", function (this: HTMLElement) {
    if (this.matches(".relationship-memory-content")) {
      return new DOMRect(0, layout.scrollportTop, MEMORY_TEST_LAYOUT_WIDTH, MEMORY_TEST_LAYOUT_HEIGHT);
    }
    if (this.matches(".relationship-memory-upgrade-preview")) {
      return new DOMRect(0, -layout.outerScroll, MEMORY_TEST_LAYOUT_WIDTH, MEMORY_TEST_LAYOUT_HEIGHT);
    }
    if (this.matches(".relationship-memory-upgrade-stage")) {
      return new DOMRect(
        0,
        layout.bannerTop - layout.outerScroll,
        MEMORY_TEST_LAYOUT_WIDTH,
        MEMORY_TEST_OCCLUSION_STAGE_HEIGHT,
      );
    }
    if (this.matches(".relationship-people-list > li")) {
      const name = this.querySelector("a")?.getAttribute("aria-label");
      const top =
        name === "Open Personqa"
          ? MEMORY_TEST_OCCLUSION_PERSON_ROW_JUSSI_TOP
          : name === "Open Personqx"
            ? MEMORY_TEST_OCCLUSION_PERSON_ROW_BOBBY_TOP
            : name === "Open Personrd"
              ? MEMORY_TEST_OCCLUSION_PERSON_ROW_DANIEL_TOP
              : MEMORY_TEST_OCCLUSION_PERSON_ROW_ALEX_TOP;

      return new DOMRect(0, top - layout.outerScroll, MEMORY_TEST_LAYOUT_WIDTH, MEMORY_TEST_LIST_ROW_HEIGHT);
    }
    if (this.matches(".relationship-memory-group > .relationship-memory-group-heading")) {
      return new DOMRect(
        0,
        (this.textContent.includes("August")
          ? MEMORY_TEST_OCCLUSION_GROUP_AUGUST_TOP
          : MEMORY_TEST_OCCLUSION_GROUP_SEPTEMBER_TOP) - layout.outerScroll,
        MEMORY_TEST_LAYOUT_WIDTH,
        MEMORY_TEST_GROUP_HEADING_HEIGHT,
      );
    }

    return original.call(this);
  });
  const people = ["Personqa", "Personqx", "Personrd", "Personqo"].map((name, index) => ({
    id: [pid, uid, mid, wid][index],
    name,
    categories: [],
    lastContact: index === MEMORY_TEST_PEOPLE_FIXTURE_FOURTH_INDEX ? "2026-08-01T00:00:00Z" : memory.occurredAt,
  }));
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = resolveFetchUrl(input);
    const body = url.endsWith("/billing/me")
      ? { billing: { ...paidBilling, plan: "free" } }
      : url.endsWith("/memory/status")
        ? buildMemoryTestStatusBody({})
        : urlPath(url).endsWith("/memory/people")
          ? { people }
          : { memories: [], nextCursor: null };

    return new Response(JSON.stringify(body));
  });
}

async function runFreePeopleOcclusionInteractions(input: {
  layout: FreePeopleOcclusionLayout;
  screen: ReturnType<typeof mount>["screen"];
}) {
  const { layout, screen } = input;
  const first = await screen.findByRole("link", { name: "Open Personqa" });
  const banner = screen.getByRole("region", { name: "Ready Pro" });
  ["Personqx", "Personrd", "Personqo"].forEach((name) => {
    assert.equal(screen.queryByRole("link", { name: `Open ${name}` }) === null, true);
    const link = screen.container.querySelector(`[aria-label="Open ${name}"]`);
    if (link === null) {
      throw new Error(WORKSPACE_MEMORY_TEST_COPY.missingPersonLink);
    }
    const row = link.closest("li");
    if (row === null) {
      throw new Error(WORKSPACE_MEMORY_TEST_COPY.missingPersonRow);
    }
    assert.ok(row.hasAttribute("inert"), EXPECTED_TRUTHY);
    assert.equal(row.getAttribute("aria-hidden"), "true");
  });
  assert.equal(screen.queryByRole("button", { name: /August/ }) === null, true);
  first.focus();
  fireEvent.keyDown(first, { key: "End" });
  assert.equal(document.activeElement, first, "End must skip all covered rows");

  layout.bannerTop = MEMORY_TEST_OCCLUSION_BANNER_EXPANDED_TOP;
  fireEvent(window, new Event("resize"));
  const third = screen.getByRole("link", { name: "Open Personrd" });
  fireEvent.keyDown(first, { key: "End" });
  assert.equal(document.activeElement, third);
  assert.equal(screen.queryByRole("link", { name: "Open Personqo" }) === null, true);
  assert.equal(screen.getByRole("region", { name: "Ready Pro" }), banner);

  const scrollport = requiredElement({
    value: screen.container.querySelector(".relationship-memory-content"),
    label: "scrollport",
  });
  first.focus();
  layout.outerScroll = MEMORY_TEST_OCCLUSION_OUTER_SCROLL;
  fireEvent.scroll(scrollport);
  assert.equal(screen.queryByRole("link", { name: "Open Personqa" }) === null, true);
  assert.ok(
    requiredElement({ value: first.closest("li"), label: "person row" }).hasAttribute("inert"),
    EXPECTED_TRUTHY,
  );
  assert.equal(
    requiredElement({ value: first.closest("li"), label: "person row" }).getAttribute("aria-hidden"),
    "true",
  );
  assert.equal(screen.queryByRole("button", { name: /September/ }) === null, true);
  assert.equal(document.activeElement, screen.getByRole("button", { name: "Upgrade to Pro" }));
  const second = screen.getByRole("link", { name: "Open Personqx" });
  third.focus();
  fireEvent.keyDown(third, { key: "Home" });
  assert.equal(document.activeElement, second, "Home skips rows underneath the toolbar");

  layout.scrollportTop = MEMORY_TEST_OCCLUSION_SCROLLPORT_TOP;
  fireEvent(window, new Event("resize"));
  assert.equal(screen.queryByRole("link", { name: "Open Personqx" }) === null, true);
  assertRolePresent({ screen, role: "link", name: "Open Personrd" });
  layout.scrollportTop = MEMORY_TEST_PROGRESS_FAILED;
  layout.outerScroll = MEMORY_TEST_PROGRESS_FAILED;
  fireEvent.scroll(scrollport);
  assert.equal(screen.getByRole("link", { name: "Open Personqa" }), first);
  third.focus();

  layout.bannerTop = MEMORY_TEST_OCCLUSION_BANNER_MID_TOP;
  fireEvent(window, new Event("resize"));
  assert.equal(screen.queryByRole("link", { name: "Open Personqa" }) === null, true);
  assert.equal(document.activeElement, screen.getByRole("button", { name: "Upgrade to Pro" }));

  layout.bannerTop = MEMORY_TEST_OCCLUSION_BANNER_EXPANDED_TOP;
  fireEvent(window, new Event("resize"));
  const group = screen.getByRole("button", { name: /September/ });
  fireEvent.click(group);
  await waitFor(() =>
    assert.ok(
      requiredElement({ value: first.closest("li"), label: "person row" }).hasAttribute("inert"),
      EXPECTED_TRUTHY,
    ),
  );
  assert.equal(screen.queryByRole("link", { name: "Open Personqa" }) === null, true);
  fireEvent.click(group);
  await waitFor(() =>
    assert.equal(requiredElement({ value: first.closest("li"), label: "person row" }).hasAttribute("inert"), false),
  );
  assertRolePresent({ screen, role: "link", name: "Open Personqa" });
}

void test("Free People excludes covered rows after resizing, outer scrolling, and group collapse", async (t) => {
  const layout: FreePeopleOcclusionLayout = {
    bannerTop: MEMORY_TEST_OCCLUSION_BANNER_INITIAL_TOP,
    outerScroll: MEMORY_TEST_PROGRESS_FAILED,
    scrollportTop: MEMORY_TEST_PROGRESS_FAILED,
  };
  installFreePeopleOcclusionMocks({ t, layout });
  const { client, screen } = mount({ node: <WorkspaceMemoryPage view="people" /> });
  t.after(() => {
    cleanup();
    client.clear();
  });
  await runFreePeopleOcclusionInteractions({ layout, screen });
});

function CachedPlanToggleHarness({ view }: { view: "all" | "people" | "person" }) {
  const [isPageVisible, setIsPageVisible] = useState(true);

  return (
    <>
      <button type="button" onClick={() => setIsPageVisible((isCurrentlyVisible) => !isCurrentlyVisible)}>
        Toggle page
      </button>
      {isPageVisible ? (
        <WorkspaceMemoryPage view={view === "all" ? "all" : "people"} personId={view === "person" ? pid : undefined} />
      ) : null}
    </>
  );
}

function installReducedMotionMatchMedia(t: TestContext) {
  const matchMedia = window.matchMedia.bind(window);
  t.mock.method(window, "matchMedia", (query: string) => {
    const media = matchMedia(query);
    if (query === "(prefers-reduced-motion: reduce)") {
      Object.defineProperty(media, "matches", { value: true });
    }

    return media;
  });
}

async function runCachedPlanMemoryRevisitTest(options: {
  isCachedFreePlan: boolean;
  view: "all" | "people" | "person";
  t: TestContext;
}) {
  const { isCachedFreePlan, view, t } = options;
  installMockBroadcastChannel(t);
  installReducedMotionMatchMedia(t);
  const person = {
    id: pid,
    name: "Personqa",
    email: "personqa@example.test",
    lastContact: memory.occurredAt,
    categories: [],
  };
  const visit = {
    isRevisiting: false,
    releaseRequests: (): void => {
      throw new Error(WORKSPACE_MEMORY_TEST_COPY.backgroundRequestsNotHeld);
    },
    resolveBilling: (_response: Response) => {},
    backgroundChecks: 0,
  };
  const pendingRequests = new Promise<void>((resolve) => {
    visit.releaseRequests = resolve;
  });
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = resolveFetchUrl(input);
    if (visit.isRevisiting) {
      if (url.endsWith("/billing/me")) {
        visit.backgroundChecks += 1;

        return new Promise<Response>((resolve) => {
          visit.resolveBilling = resolve;
        });
      }
      await pendingRequests;
    }
    const body = url.endsWith("/billing/me")
      ? { billing: { ...paidBilling, plan: isCachedFreePlan ? "free" : paidBilling.plan } }
      : url.endsWith("/memory/status")
        ? buildMemoryTestStatusBody({})
        : urlPath(url).endsWith("/memory/people")
          ? { people: [person] }
          : url.endsWith(`/memory/people/${pid}`)
            ? {
                person,
                projection: {
                  summary: [{ text: WORKSPACE_MEMORY_TEST_COPY.cachedPersonSummary, memoryIds: [mid] }],
                  standing: [],
                },
                memories: [memory],
                meetings: [],
                /** @external person detail wire field */
                processing: false,
              }
            : url.includes("/memory?")
              ? { memories: [memory], nextCursor: null }
              : {};

    return new Response(JSON.stringify(body));
  });
  const { client, screen } = mount({ node: <CachedPlanToggleHarness view={view} /> });
  t.after(() => {
    cleanup();
    client.clear();
  });
  const text =
    view === "all"
      ? memory.title
      : view === "person"
        ? WORKSPACE_MEMORY_TEST_COPY.cachedPersonSummary
        : WORKSPACE_MEMORY_TEST_COPY.memoryBrowserJussiLabel;
  await waitFor(() => assertTextPresent({ screen, text }));
  await waitFor(() => assert.equal(client.getQueryState(["workspace-trial-offer", wid, uid])?.fetchStatus, "idle"));
  await assertCachedPlanBackgroundRevisit({
    visit,
    view,
    screen,
    text,
    isCachedFreePlan,
  });
}

async function assertCachedPlanBackgroundRevisit(input: {
  visit: {
    isRevisiting: boolean;
    releaseRequests: () => void;
    resolveBilling: (response: Response) => void;
    backgroundChecks: number;
  };
  view: "all" | "people" | "person";
  screen: ReturnType<typeof mount>["screen"];
  text: string;
  isCachedFreePlan: boolean;
}) {
  const { visit, view, screen, text, isCachedFreePlan } = input;
  fireEvent.click(screen.getByRole("button", { name: "Toggle page" }));
  await new Promise((resolve) => {
    setTimeout(resolve, MEMORY_TEST_TOGGLE_REMOUNT_DEFER_MS);
  });
  visit.isRevisiting = true;
  fireEvent.click(screen.getByRole("button", { name: "Toggle page" }));
  assert.notEqual(screen.queryByText(text), null, "cached content is present synchronously after navigation");
  assert.equal(screen.queryByText("Checking your plan…") === null, true);
  assert.equal(Boolean(screen.queryByRole("button", { name: "Upgrade to Pro" })), isCachedFreePlan);
  assert.equal(visit.backgroundChecks, 1);
  if (view === "all") {
    fireEvent.click(screen.getByRole("button", { name: "Card view" }));
    assert.equal(screen.getByRole("button", { name: "Card view" }).getAttribute("aria-pressed"), "true");
    assert.ok(screen.container.querySelector(".memory-snapshot-card"), "view controls react before plan verification");
  }
  visit.releaseRequests();
  visit.resolveBilling(
    new Response(JSON.stringify({ billing: { ...paidBilling, plan: isCachedFreePlan ? paidBilling.plan : "free" } })),
  );
  if (isCachedFreePlan) {
    await waitFor(() => assert.equal(screen.queryByRole("button", { name: "Upgrade to Pro" }) === null, true));

    return;
  }
  await waitFor(() => assertRolePresent({ screen, role: "button", name: "Upgrade to Pro" }));
  assert.ok(screen.container.querySelector(".relationship-memory-upgrade.has-preview"), EXPECTED_TRUTHY);
  if (view === "all") {
    assert.ok(screen.container.querySelector(".relationship-memory-upgrade.is-card-preview"), EXPECTED_TRUTHY);
  }
}

[false, true].forEach((isCachedFreePlan) => {
  (["all", "people", "person"] as const).forEach((view) => {
    void test(`${view} with cached ${isCachedFreePlan ? "Free" : "paid"} plan returns from its in-memory cache while background requests are pending`, async (t) => {
      await runCachedPlanMemoryRevisitTest({ isCachedFreePlan, view, t });
    });
  });
});

[true, false].forEach((isMemoryPresent) => {
  void test(`memory links search evicted newer pages once (${isMemoryPresent ? "found" : `missing after ${MEMORY_TEST_MEMORY_SEARCH_CURSOR_TOTAL} pages`})`, async (t) => {
    const cursorCapture = { values: [] as string[] };
    const older = {
      ...memory,
      id: uid,
      title: "Older cached memory",
      category: "Partnerships" as const,
      candidateSubjectId: null,
      candidateSubjectKey: null,
      /** @external memory wire field */
      sensitive: false,
      confidence: "high" as const,
      evidence: [],
      importance: 0,
    };
    const cursor = encodeMemoryPosition(older);
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      const url = resolveFetchUrl(input);
      const body: unknown = (() => {
        if (url.endsWith("/billing/me")) {
          return { billing: paidBilling };
        }
        if (url.endsWith(WORKSPACE_MEMORY_TEST_COPY.memoryStatusPathSuffix)) {
          return buildMemoryTestStatusBody({ progress: MEMORY_TEST_PROGRESS_SNAPSHOT_ONE_COMPLETE });
        }
        if (urlPath(url).endsWith("/memory/people")) {
          return { people: [] };
        }
        if (url.includes("/memory?")) {
          const before = new URL(url).searchParams.get("before") ?? "";
          cursorCapture.values = [...cursorCapture.values, before];
          const page = before !== "" ? Number(before) : MEMORY_TEST_PROGRESS_FAILED;

          return {
            memories: isMemoryPresent ? [memory] : [{ ...older, id: `${uid}-${page}` }],
            nextCursor:
              isMemoryPresent || page === MEMORY_TEST_MEMORY_SEARCH_MAX_PAGE_INDEX
                ? null
                : String(page + MEMORY_TEST_SINGLE_FETCH_COUNT),
          };
        }
        if (url.endsWith(`/memory/${mid}`)) {
          return { evidence: [] };
        }

        return {};
      })();

      return new Response(JSON.stringify(body));
    });
    function Seed() {
      const client = useQueryClient();
      useState(() => {
        client.setQueryData(
          memoryListOptions({ client, session: { token: "test-token", userId: uid, workspaceId: wid } }).queryKey,
          {
            pages: [{ memories: [older], nextCursor: null, previousCursor: cursor }],
            pageParams: [cursor],
          },
        );

        return true;
      });

      return <WorkspaceMemoryPage />;
    }
    const { client, screen } = mount({
      node: <Seed />,
      searchParams: new URLSearchParams({ memory: mid }),
      plan: user.plan,
      cachedBilling: paidBilling,
      memoryAvailable: true,
    });
    t.after(() => {
      cleanup();
      client.clear();
    });
    if (isMemoryPresent) {
      await waitFor(() => assertTextPresent({ screen, text: memory.description }));
      assert.equal(screen.queryByText(WORKSPACE_MEMORY_TEST_COPY.memoryNoLongerAvailable) === null, true);
      assert.deepEqual(cursorCapture.values, [""]);
    } else {
      await waitFor(() => assertTextPresent({ screen, text: WORKSPACE_MEMORY_TEST_COPY.memoryNoLongerAvailable }));
      assert.equal(cursorCapture.values.length, MEMORY_TEST_MEMORY_SEARCH_CURSOR_TOTAL);
      assert.equal(cursorCapture.values.filter((value) => value === "").length, MEMORY_TEST_SINGLE_FETCH_COUNT);
    }
  });
});
