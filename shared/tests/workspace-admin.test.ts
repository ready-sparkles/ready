import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkspaceRequestSchema,
  emailDomain,
  inviteWorkspaceMembersRequestSchema,
  isPublicEmailDomain,
  meetingConfidentialityRealtimeEventSchema,
  shouldAutoMarkMeetingConfidential,
  updateWorkspaceMemberRequestSchema,
  workspaceMemberRoleSchema,
} from "../domain/workspace-admin";

const OVERSIZED_WORKSPACE_NAME_LENGTH = 256;

function participant(input: { email: string; isWorkspaceMember: boolean; userId?: string }) {
  return {
    userId: input.userId ?? crypto.randomUUID(),
    email: input.email,
    isWorkspaceMember: input.isWorkspaceMember,
  };
}

void test("two workspace members in a one-to-one trigger automatic confidentiality", () => {
  assert.equal(
    shouldAutoMarkMeetingConfidential({
      humanParticipants: [
        participant({ email: "personbr@example.com", isWorkspaceMember: true }),
        participant({ email: "personaz@example.com", isWorkspaceMember: true }),
      ],
    }),
    true,
  );
});

void test("participant counts other than two never qualify", () => {
  const member = () => participant({ email: "personbr@example.com", isWorkspaceMember: true });
  assert.equal(shouldAutoMarkMeetingConfidential({ humanParticipants: [member()] }), false);
  assert.equal(shouldAutoMarkMeetingConfidential({ humanParticipants: [member(), member(), member()] }), false);
  assert.equal(shouldAutoMarkMeetingConfidential({ humanParticipants: [] }), false);
});

void test("a duplicated participant row does not count as a one-to-one", () => {
  const same = participant({ email: "personbr@example.com", isWorkspaceMember: true });
  assert.equal(shouldAutoMarkMeetingConfidential({ humanParticipants: [same, same] }), false);
});

void test("membership is required when no verified domains are configured", () => {
  assert.equal(
    shouldAutoMarkMeetingConfidential({
      humanParticipants: [
        participant({ email: "personbr@acme.com", isWorkspaceMember: true }),
        participant({ email: "guest@acme.com", isWorkspaceMember: false }),
      ],
    }),
    false,
    "shared corporate domain alone is never enough without verification",
  );
});

void test("verified company domain fallback applies only before membership is known", () => {
  const verified = new Set(["acme.com"]);
  assert.equal(
    shouldAutoMarkMeetingConfidential({
      humanParticipants: [
        participant({ email: "a@acme.com", isWorkspaceMember: false }),
        participant({ email: "b@acme.com", isWorkspaceMember: false }),
      ],
      verifiedCompanyDomains: verified,
    }),
    true,
  );
  assert.equal(
    shouldAutoMarkMeetingConfidential({
      humanParticipants: [
        participant({ email: "a@acme.com", isWorkspaceMember: false }),
        participant({ email: "b@other.com", isWorkspaceMember: false }),
      ],
      verifiedCompanyDomains: verified,
    }),
    false,
  );
});

void test("public email domains are never treated as company membership", () => {
  ["gmail.com", "outlook.com", "yahoo.com", "icloud.com"].forEach((domain) => {
    assert.equal(isPublicEmailDomain(domain), true);
    assert.equal(
      shouldAutoMarkMeetingConfidential({
        humanParticipants: [
          participant({ email: `a@${domain}`, isWorkspaceMember: false }),
          participant({ email: `b@${domain}`, isWorkspaceMember: false }),
        ],
        // Even a misconfigured verification list must not bless public domains.
        verifiedCompanyDomains: new Set([domain]),
      }),
      false,
      `${domain} must never imply a shared company`,
    );
  });
});

void test("emailDomain extracts and normalizes the domain part", () => {
  assert.equal(emailDomain("Personbr@Example.Com"), "example.com");
  assert.equal(emailDomain("not-an-email"), null);
});

void test("confidentiality realtime event schema accepts the published payload", () => {
  const parsed = meetingConfidentialityRealtimeEventSchema.parse({
    version: 1,
    eventId: "550e8400-e29b-41d4-a716-446655440000",
    eventName: "meeting.confidentiality.changed",
    workspaceId: "660e8400-e29b-41d4-a716-446655440000",
    meetingId: "770e8400-e29b-41d4-a716-446655440000",
    isConfidential: true,
    confidentialitySource: "manual",
    occurredAt: "2026-07-10T10:00:00.000Z",
    actorUserId: null,
  });
  assert.equal(parsed.isConfidential, true);
  assert.equal(parsed.confidentialitySource, "manual");
});

void test("createWorkspaceRequestSchema trims the name and rejects empty or oversized values", () => {
  assert.deepEqual(createWorkspaceRequestSchema.parse({ name: "  Acme HQ  " }), { name: "Acme HQ" });
  assert.equal(createWorkspaceRequestSchema.safeParse({ name: "   " }).success, false);
  assert.equal(createWorkspaceRequestSchema.safeParse({ name: "" }).success, false);
  assert.equal(
    createWorkspaceRequestSchema.safeParse({ name: "x".repeat(OVERSIZED_WORKSPACE_NAME_LENGTH) }).success,
    false,
  );
  assert.equal(createWorkspaceRequestSchema.safeParse({}).success, false);
});

void test("Owner is a membership role but cannot be granted by invitations or normal role changes", () => {
  assert.equal(workspaceMemberRoleSchema.parse("owner"), "owner");
  assert.equal(
    inviteWorkspaceMembersRequestSchema.safeParse({ emails: ["owner@example.com"], role: "owner" }).success,
    false,
  );
  assert.equal(updateWorkspaceMemberRequestSchema.safeParse({ role: "owner" }).success, false);
});
