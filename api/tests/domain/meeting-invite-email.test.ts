import assert from "node:assert/strict";
import test from "node:test";

import { buildMeetingInviteEmail } from "../../domain/meeting-invite-email";

void test("meeting invite email uses Ready branding and happening-now copy", () => {
  const email = buildMeetingInviteEmail({
    inviterName: "Personbs",
    inviterEmail: "personbr@example.com",
    meetingTitle: "Product review",
    joinUrl: "https://ready.app/abc-def-ghi",
    callIn: { phoneNumber: "+14132334083", pin: "981503738" },
  });

  assert.equal(email.subject, "Happening now: Personbs is inviting you to a video call");
  assert.match(email.html, /alt="Ready"/);
  assert.match(email.html, />Join call</);
  assert.match(email.html, /Product review/);
  assert.match(email.html, /PIN: 981503738#/);
  assert.match(email.text, /personbr@example\.com/);
});

void test("meeting invite email escapes user-controlled copy", () => {
  const email = buildMeetingInviteEmail({
    inviterName: "<script>Personbr</script>",
    inviterEmail: "personbr@example.com",
    meetingTitle: "<b>Review</b>",
    joinUrl: "https://ready.app/abc-def-ghi",
  });

  assert.doesNotMatch(email.html, /<script>/);
  assert.doesNotMatch(email.html, /<b>Review<\/b>/);
  assert.match(email.html, /&lt;script&gt;Personbr&lt;\/script&gt;/);
});
