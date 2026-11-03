import assert from "node:assert/strict";
import test from "node:test";

import { buildWorkspaceInviteEmail } from "../../domain/workspace-invite-email";

void test("invitation email carries inviter, workspace, status, accept link, and expiry", () => {
  const message = buildWorkspaceInviteEmail({
    inviterName: "Personbs",
    workspaceName: "Ready HQ",
    role: "admin",
    acceptUrl: "https://ready.app/invite/token123",
    expiresAt: new Date("2026-07-24T00:00:00.000Z"),
  });

  assert.match(message.subject, /Personbs invited you to Ready HQ/);
  assert.match(message.html, /<img src="https:\/\/ready\.app\/icon-128\.png\?v=2"/);
  assert.doesNotMatch(message.html, /Ready is where your team's meetings, notes, and tasks live/);
  [message.html, message.text].forEach((body) => {
    assert.match(body, /Personbs/);
    assert.match(body, /Ready HQ/);
    assert.match(body, /Admin/);
    assert.match(body, /https:\/\/ready\.app\/invite\/token123/);
    assert.match(body, /July 24, 2026/);
  });
});

void test("invitation email escapes HTML in user-controlled fields", () => {
  const message = buildWorkspaceInviteEmail({
    inviterName: "<script>alert(1)</script>",
    workspaceName: "A & B <Workspace>",
    role: "member",
    acceptUrl: "https://ready.app/invite/token",
    expiresAt: new Date("2026-07-24T00:00:00.000Z"),
  });

  assert.equal(message.html.includes("<script>"), false);
  assert.match(message.html, /&lt;script&gt;/);
  assert.match(message.html, /A &amp; B &lt;Workspace&gt;/);
});

void test("invitation email does not append a duplicate workspace noun", () => {
  const message = buildWorkspaceInviteEmail({
    inviterName: "Personbs",
    workspaceName: "ready.app workspace",
    role: "member",
    acceptUrl: "https://ready.app/invite/token",
    expiresAt: new Date("2026-07-24T00:00:00.000Z"),
  });

  assert.doesNotMatch(message.html, /ready\.app workspace<\/strong> workspace/);
  assert.doesNotMatch(message.text, /ready\.app workspace workspace/);
});
