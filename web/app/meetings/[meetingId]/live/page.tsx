import { LiveMeetingPage } from "../../../../presentation/components/live-meeting-page";
import { RequireAuth } from "../../../../presentation/components/require-auth";

export default async function MeetingLivePage({ params }: { params: Promise<{ meetingId: string }> }) {
  const { meetingId } = await params;

  return (
    <RequireAuth isGuestAllowed>
      <LiveMeetingPage meetingId={meetingId} />
    </RequireAuth>
  );
}
