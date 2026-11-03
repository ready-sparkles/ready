"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import {
  PathnameContext,
  PathParamsContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { WorkspaceDemoRuntime } from "../../../composition/workspace-demo/demo-runtime";
import type { AssignedTaskView } from "../../../domain/assigned-task-filters";
import { WORKSPACE_DEMO_READY_MESSAGE } from "../../../domain/workspace-demo/demo-path";
import { StaticAuthProvider } from "../auth-provider";
import { RealtimeClientProvider } from "../realtime-provider";
import { ToastProvider } from "../toast-provider";
import { WorkspaceAssignedTasksPage } from "../workspace-assigned-tasks-page";
import { WorkspaceHome } from "../workspace-home";
import { WorkspaceMemoryPage, WorkspaceMemoryPeoplePage } from "../workspace-memory";

const MISSING_DEMO_HISTORY_ENTRY = "Demo history entry is missing";

type DemoRoute =
  | { kind: "home"; view: "past" | "upcoming" }
  | { kind: "meeting"; meetingId: string }
  | { kind: "tasks"; view: AssignedTaskView }
  | { kind: "memory" }
  | { kind: "people"; personId?: string };

function matchDemoRoute({
  pathname,
  searchParams,
}: {
  pathname: string;
  searchParams: URLSearchParams;
}): DemoRoute | null {
  if (pathname === "/workspace") {
    return { kind: "home", view: searchParams.get("view") === "upcoming" ? "upcoming" : "past" };
  }
  if (pathname === "/workspace/memory") {
    return { kind: "memory" };
  }
  const people = pathname.match(/^\/workspace\/memory\/people(?:\/([^/]+))?$/);
  if (people) {
    return { kind: "people", personId: people[1] };
  }
  const tasks = pathname.match(/^\/workspace\/tasks\/(mine|others|done)$/);
  if (tasks) {
    const taskView = tasks[1];
    if (taskView === "mine" || taskView === "others" || taskView === "done") {
      return { kind: "tasks", view: taskView };
    }
  }
  const meeting = pathname.match(/^\/workspace\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
  const meetingId = meeting?.[1];
  if (meetingId !== undefined) {
    return { kind: "meeting", meetingId };
  }

  return null;
}

function routeParams(route: DemoRoute) {
  if (route.kind === "people" && Boolean(route.personId)) {
    return { personId: route.personId };
  }
  if (route.kind === "meeting") {
    return { meetingId: route.meetingId };
  }
  if (route.kind === "tasks") {
    return { taskView: route.view };
  }

  return {};
}

function DemoRouteView({ route, pathname }: { route: DemoRoute; pathname: string }) {
  // Keys mirror the App Router: people keeps its shared layout mounted, while
  // other segments remount when their path changes.
  switch (route.kind) {
    case "home":
      return <WorkspaceHome key="home" view={route.view} />;
    case "meeting":
      return <WorkspaceHome key={pathname} view="past" initialMeetingId={route.meetingId} />;
    case "tasks":
      return <WorkspaceAssignedTasksPage key={pathname} view={route.view} />;
    case "memory":
      return <WorkspaceMemoryPage key="memory" />;
    case "people":
      return <WorkspaceMemoryPeoplePage key="people" />;
  }
}

type Entry = { pathname: string; search: string };

function toEntry({ href, from }: { href: string; from: Entry }) {
  const url = new URL(href, `${window.location.origin}${from.pathname}${from.search}`);

  return { url, entry: { pathname: url.pathname, search: url.search } };
}

/** The real workspace, driven by in-memory routing and data. Links and router
 * calls that would leave the workspace (a new meeting, settings, sign-out) stay
 * put, so the demo never starts devices or reaches the visitor's account. */
function DemoWorkspace({ runtime }: { runtime: WorkspaceDemoRuntime }) {
  const [history, setHistory] = useState<{ entries: Entry[]; index: number }>(() => ({
    entries: [{ pathname: runtime.initialPath, search: "" }],
    index: 0,
  }));
  const location = history.entries[history.index];
  if (location === undefined) {
    throw new Error(MISSING_DEMO_HISTORY_ENTRY);
  }

  const navigate = useCallback((href: string, mode: "push" | "replace") => {
    setHistory((current) => {
      const active = current.entries[current.index];
      if (active === undefined) {
        throw new Error(MISSING_DEMO_HISTORY_ENTRY);
      }
      const { url, entry } = toEntry({ href, from: active });
      if (
        url.origin !== window.location.origin ||
        !matchDemoRoute({ pathname: entry.pathname, searchParams: url.searchParams })
      ) {
        return current;
      }
      if (active.pathname === entry.pathname && active.search === entry.search) {
        return current;
      }
      if (mode === "replace") {
        const entries = current.entries.map((item, index) => (index === current.index ? entry : item));

        return { entries, index: current.index };
      }

      return { entries: [...current.entries.slice(0, current.index + 1), entry], index: current.index + 1 };
    });
  }, []);

  const router = useMemo<AppRouterInstance>(
    () => ({
      push: (href) => navigate(href, "push"),
      replace: (href) => navigate(href, "replace"),
      back: () => setHistory((current) => ({ ...current, index: Math.max(0, current.index - 1) })),
      forward: () =>
        setHistory((current) => ({ ...current, index: Math.min(current.entries.length - 1, current.index + 1) })),
      refresh: () => {},
      prefetch: () => {},
    }),
    [navigate],
  );

  useEffect(() => {
    // Capture runs before React's root listeners: a prevented click makes
    // next/link stand down, so the in-memory router owns navigation.
    const handleClick = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!anchor) {
        return;
      }
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) {
        // Let the add-on banner open Ready's public Marketplace listing.
        if (
          url.href === "https://workspace.google.com/marketplace/app/ready/1011295591976" &&
          anchor.target === "_blank"
        ) {
          return;
        }
        // Demo sources (Gmail, Slack, LinkedIn) are illustrative; stay put.
        event.preventDefault();

        return;
      }
      event.preventDefault();
      if (!matchDemoRoute({ pathname: url.pathname, searchParams: url.searchParams })) {
        // Leaving the workspace (new meeting, settings) must not run the
        // link's own handlers either, such as starting camera capture.
        event.stopPropagation();

        return;
      }
      if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
        router.push(`${url.pathname}${url.search}`);
      }
    };
    document.addEventListener("click", handleClick, true);

    return () => document.removeEventListener("click", handleClick, true);
  }, [router]);

  const searchParams = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const route = useMemo(
    () => matchDemoRoute({ pathname: location.pathname, searchParams }),
    [location.pathname, searchParams],
  );
  const params = useMemo(() => (route ? routeParams(route) : {}), [route]);

  return (
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value={location.pathname}>
        <SearchParamsContext.Provider value={searchParams}>
          <PathParamsContext.Provider value={params}>
            {route ? <DemoRouteView route={route} pathname={location.pathname} /> : null}
          </PathParamsContext.Provider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>
  );
}

export function WorkspaceDemoApp({
  initialScreen = "people",
}: {
  initialScreen?: "people" | "notes" | "memory" | "tasks";
}) {
  const [runtime, setRuntime] = useState<WorkspaceDemoRuntime | null>(null);

  useEffect(() => {
    // Scoped styles for the framed window, such as hidden scrollbars.
    document.documentElement.classList.add("workspace-demo-document");

    return () => document.documentElement.classList.remove("workspace-demo-document");
  }, []);

  useEffect(() => {
    const lifecycle = { isCancelled: false };
    void (async () => {
      const { createWorkspaceDemoRuntime } = await import("../../../composition/workspace-demo/demo-runtime");
      if (!lifecycle.isCancelled) {
        setRuntime(createWorkspaceDemoRuntime(initialScreen));
      }
    })();

    return () => {
      lifecycle.isCancelled = true;
    };
  }, [initialScreen]);

  useEffect(() => {
    if (!runtime || window.parent === window) {
      return;
    }
    // The parent keeps this frame transparent until readiness. Notify after
    // React commits the workspace, without waiting for painting: browsers may
    // suspend animation frames in hidden iframes, leaving both sides waiting.
    window.parent.postMessage({ type: WORKSPACE_DEMO_READY_MESSAGE }, window.location.origin);
  }, [runtime]);

  if (!runtime) {
    return <main className="workspace-demo-loading" aria-label="Loading demo workspace" />;
  }

  return (
    <StaticAuthProvider session={runtime.session}>
      <QueryClientProvider client={runtime.queryClient}>
        <RealtimeClientProvider session={null} refreshSession={async () => null}>
          <ToastProvider>
            <DemoWorkspace runtime={runtime} />
          </ToastProvider>
        </RealtimeClientProvider>
      </QueryClientProvider>
    </StaticAuthProvider>
  );
}
