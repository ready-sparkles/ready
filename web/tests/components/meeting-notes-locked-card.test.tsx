import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MeetingNotesLockedCard } from "../../presentation/components/post-meeting-workspace";

void test("guest notes placeholder links to signup with its return path", () => {
  const signupHref = "/signup?callbackUrl=%2Fguest%2Fmeetings%2Fmeeting-123%2Fnotes";
  const markup = renderToStaticMarkup(<MeetingNotesLockedCard reason="signup_required" signupHref={signupHref} />);

  assert.match(markup, /Sign up/);
  assert.ok(markup.includes(`href="${signupHref}"`));
  assert.doesNotMatch(markup, /href="\/login"/);
});

void test("the out-of-credits card sizes its logo like the other meeting cards", () => {
  const markup = renderToStaticMarkup(<MeetingNotesLockedCard reason="credits_required" />);

  assert.match(markup, /workspace-ready-meeting-logo-tile[^>]*>\s*<span class="[^"]*workspace-ready-meeting-mark/);
  assert.match(markup, /<img class="meeting-pro-art-logo"/);
});
