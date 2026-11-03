import { notFound } from "next/navigation";

import { RoomCodeEntry } from "../../presentation/components/room-code-entry";
import { meetingLinkMetadata } from "../../presentation/lib/meeting-link-metadata";

// A shared meeting link resolves here, so this is the metadata Slack, Teams
// and iMessage unfurl. Without it the route inherited the root layout's
// generic app description.
export const metadata = meetingLinkMetadata;

export default async function RoomCodePage({ params }: { params: Promise<{ roomName: string }> }) {
  const { roomName } = await params;

  if (roomName === "marketplace-preview.html") {
    notFound();
  }

  return <RoomCodeEntry roomName={roomName} />;
}
