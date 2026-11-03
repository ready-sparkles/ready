import { notifyManager, QueryClient } from "@tanstack/react-query";

import { setApiTransport } from "../../application/api";
import { createWorkspaceDemoApi } from "../../domain/workspace-demo/demo-api";
import { buildWorkspaceDemoDataset, type WorkspaceDemoDataset } from "../../domain/workspace-demo/demo-dataset";

const DEMO_QUERY_STALE_TIME_MS = 30_000;

export type WorkspaceDemoRuntime = {
  dataset: WorkspaceDemoDataset;
  queryClient: QueryClient;
  session: { token: string; user: WorkspaceDemoDataset["user"] };
  initialPath: string;
};

/** Builds the fixture dataset and routes this window's API calls to it. Only
 * the isolated demo frame loads this module. */
export function createWorkspaceDemoRuntime(
  initialScreen: "people" | "notes" | "memory" | "tasks" = "people",
): WorkspaceDemoRuntime {
  const isWorkExamplesOnly = initialScreen === "memory";
  const dataset = buildWorkspaceDemoDataset({
    now: Date.now(),
    options: { workExamplesOnly: isWorkExamplesOnly },
  });
  setApiTransport(createWorkspaceDemoApi(dataset));
  // Local responses resolve within the same task. Deliver them before the next
  // paint so views never flash a loading state between navigations.
  notifyManager.setScheduler((callback) => queueMicrotask(callback));
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: DEMO_QUERY_STALE_TIME_MS,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    },
  });

  const firstMeeting = dataset.meetings[0];
  const notesPath = firstMeeting === undefined ? "/workspace" : `/workspace/${firstMeeting.id}`;

  return {
    dataset,
    queryClient,
    session: { token: "ready-demo", user: dataset.user },
    initialPath:
      initialScreen === "tasks"
        ? "/workspace/tasks/mine"
        : initialScreen === "memory"
          ? "/workspace/memory"
          : initialScreen === "notes"
            ? notesPath
            : `/workspace/memory/people/${dataset.featuredPersonId}`,
  };
}
