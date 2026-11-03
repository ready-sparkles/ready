import { GuestMeetingNotesPage } from "../../../../../presentation/components/guest-meeting-notes-page";

export default async function GuestMeetingNotesRoute({ params }: { params: Promise<{ meetingId: string }> }) {
  const { meetingId } = await params;

  return <GuestMeetingNotesPage meetingId={meetingId} />;
}
