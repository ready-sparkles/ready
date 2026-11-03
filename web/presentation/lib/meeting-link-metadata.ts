import type { Metadata } from "next";

/**
 * Unfurl metadata for a shared meeting link.
 *
 * Deliberately static. The room-code route is public and unauthenticated, so
 * anything put here is read by every link scanner that touches the URL and is
 * cached by Slack, Teams and iMessage. Interpolating the meeting title or host
 * would leak a name like "Q3 restructure" into every channel the link is
 * pasted into — including for meetings marked confidential, where the product
 * otherwise restricts even the title to participants.
 *
 * If richer unfurls are wanted later, add branding (an image, a site name),
 * not meeting-specific detail.
 */
export const MEETING_LINK_TITLE = "Meet";

export const MEETING_LINK_DESCRIPTION =
  "Real-time meetings by Ready. AI agents can answer questions, use your tools, and move work forward as you talk.";

export const meetingLinkMetadata: Metadata = {
  title: MEETING_LINK_TITLE,
  description: MEETING_LINK_DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: "Ready",
    title: MEETING_LINK_TITLE,
    description: MEETING_LINK_DESCRIPTION,
  },
  twitter: {
    card: "summary",
    title: MEETING_LINK_TITLE,
    description: MEETING_LINK_DESCRIPTION,
  },
};
