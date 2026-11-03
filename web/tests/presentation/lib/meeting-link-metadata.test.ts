import assert from "node:assert/strict";
import test from "node:test";

import {
  MEETING_LINK_DESCRIPTION,
  MEETING_LINK_TITLE,
  meetingLinkMetadata,
} from "../../../presentation/lib/meeting-link-metadata";

void test("a shared meeting link unfurls with the meeting copy", () => {
  assert.ok(meetingLinkMetadata.openGraph);
  assert.ok(meetingLinkMetadata.twitter);
  assert.equal(meetingLinkMetadata.title, MEETING_LINK_TITLE);
  assert.equal(meetingLinkMetadata.description, MEETING_LINK_DESCRIPTION);

  // Slack and Teams prefer Open Graph over the plain title/description pair,
  // so both have to carry the same copy or the unfurl silently falls back to
  // the root layout's generic app description.
  assert.equal(meetingLinkMetadata.openGraph.title, MEETING_LINK_TITLE);
  assert.equal(meetingLinkMetadata.openGraph.description, MEETING_LINK_DESCRIPTION);
  assert.equal(meetingLinkMetadata.twitter.title, MEETING_LINK_TITLE);
  assert.equal(meetingLinkMetadata.twitter.description, MEETING_LINK_DESCRIPTION);
});

void test("unfurl copy carries no meeting-specific detail", () => {
  // The room-code route is public and unauthenticated, and meetings can be
  // confidential. Interpolating a title or host here would leak it into every
  // channel the link is pasted into, and into Slack's link cache. This test
  // exists to make that a deliberate decision rather than an oversight.
  assert.ok(meetingLinkMetadata.openGraph);
  const values = [
    meetingLinkMetadata.title,
    meetingLinkMetadata.description,
    meetingLinkMetadata.openGraph.title,
    meetingLinkMetadata.openGraph.description,
  ];

  values.forEach((value) => {
    assert.ok(typeof value === "string");
    assert.doesNotMatch(value, /\$\{|\{\{|%s/);
  });
});
