import { notFound, redirect } from "next/navigation";

import { RequireAuth } from "../../../../presentation/components/require-auth";
import { WorkspaceAssignedTasksPage } from "../../../../presentation/components/workspace-assigned-tasks-page";

export default async function WorkspaceTasksPage({ params }: { params: Promise<{ taskView: string }> }) {
  const { taskView } = await params;
  if (taskView === "activity" || taskView === "logbook") {
    redirect("/workspace/tasks/done");
  }
  // Legacy due-date-based views map onto the ownership-based ones.
  if (taskView === "today") {
    redirect("/workspace/tasks/mine");
  }
  if (taskView === "anytime") {
    redirect("/workspace/tasks/others");
  }
  if (taskView !== "mine" && taskView !== "others" && taskView !== "done") {
    notFound();
  }

  return (
    <RequireAuth>
      <WorkspaceAssignedTasksPage view={taskView} />
    </RequireAuth>
  );
}
