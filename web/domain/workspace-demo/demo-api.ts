import { createWorkspaceDemoHandlers } from "./demo-api-handlers";
import type { WorkspaceDemoRequestHandler, WorkspaceDemoRuntime } from "./demo-api-shared";
import type { WorkspaceDemoDataset } from "./demo-dataset";

/** In-memory API for the homepage workspace demo. Reads come from the fixture
 * dataset; edits (task status, forgetting memories) last for the page session. */
export function createWorkspaceDemoApi(dataset: WorkspaceDemoDataset): WorkspaceDemoRequestHandler {
  const { user, workspaceId } = dataset;
  const session: WorkspaceDemoRuntime["session"] = {
    memories: dataset.memories,
    tasks: dataset.tasks,
    memoryVersion: 1,
    searchIndex: null,
    forgotten: [],
    recentMeetings: dataset.meetings,
  };
  const memoryPreferences: WorkspaceDemoRuntime["memoryPreferences"] = {
    /** @external demo memory preference wire field */
    includeSensitive: false,
    language: "English",
  };

  const runtime: WorkspaceDemoRuntime = {
    dataset,
    user,
    workspaceId,
    session,
    memoryPreferences,
  };

  return createWorkspaceDemoHandlers(runtime);
}
