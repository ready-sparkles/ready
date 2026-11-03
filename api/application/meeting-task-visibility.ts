import type { MeetingViewerRole } from "./meeting-dto";

export function filterMeetingTaskStatusForViewer<T extends { tasks: { status: string } | null }>(params: {
  payload: T;
  viewerRole: MeetingViewerRole;
}): T {
  const { payload, viewerRole } = params;
  if (viewerRole !== "workspace" || payload.tasks?.status === "completed") {
    return payload;
  }

  return {
    ...payload,
    tasks: null,
  };
}
