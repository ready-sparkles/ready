import { redirect } from "next/navigation";

export default async function MeetingPage({ params }: { params: Promise<{ meetingId: string }> }) {
  const { meetingId } = await params;
  redirect(`/meetings/${meetingId}/live`);
}
