import { RequireAuth } from "../../../presentation/components/require-auth";
import { WorkspaceHome } from "../../../presentation/components/workspace-home";

export default async function WorkspaceMeetingPage({ params }: { params: Promise<{ meetingId: string }> }) {
  const { meetingId } = await params;

  return (
    <RequireAuth>
      <WorkspaceHome view="past" initialMeetingId={meetingId} />
    </RequireAuth>
  );
}
