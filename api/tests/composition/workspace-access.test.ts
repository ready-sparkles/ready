import assert from "node:assert/strict";
import test from "node:test";

import {
  canChangeMeetingConfidentiality,
  isWorkspaceManagerRole,
  isWorkspaceOwnerRole,
} from "../../adapters/primary/http/support/workspace-access";

void test("workspace role helpers distinguish managers and owners", () => {
  assert.equal(isWorkspaceManagerRole("owner"), true);
  assert.equal(isWorkspaceManagerRole("admin"), true);
  assert.equal(isWorkspaceManagerRole("member"), false);
  assert.equal(isWorkspaceOwnerRole("owner"), true);
  assert.equal(isWorkspaceOwnerRole("admin"), false);
  assert.equal(isWorkspaceOwnerRole("member"), false);
});

const meeting = (overrides: Partial<{ createdByUserId: string | null; status: string }> = {}) => ({
  createdByUserId: "organizer",
  status: "active",
  workspaceId: "workspace",
  ...overrides,
});

void test("the organizer can change confidentiality during and after the meeting", () => {
  ["scheduled", "active", "ended"].forEach((status) => {
    assert.equal(
      canChangeMeetingConfidentiality({
        meeting: meeting({ status }),
        userId: "organizer",
        isParticipant: true,
        isWorkspaceAdmin: false,
      }),
      true,
      `organizer allowed while ${status}`,
    );
  });
});

void test("a participating workspace admin can change confidentiality only while the meeting is live", () => {
  assert.equal(
    canChangeMeetingConfidentiality({
      meeting: meeting(),
      userId: "admin",
      isParticipant: true,
      isWorkspaceAdmin: true,
    }),
    true,
  );
  assert.equal(
    canChangeMeetingConfidentiality({
      meeting: meeting({ status: "ended" }),
      userId: "admin",
      isParticipant: true,
      isWorkspaceAdmin: true,
    }),
    false,
    "after the meeting ends only the organizer may change it",
  );
});

void test("non-participant admins and plain participants cannot change confidentiality", () => {
  assert.equal(
    canChangeMeetingConfidentiality({
      meeting: meeting(),
      userId: "admin",
      isParticipant: false,
      isWorkspaceAdmin: true,
    }),
    false,
    "admins get no bypass without participating",
  );
  assert.equal(
    canChangeMeetingConfidentiality({
      meeting: meeting(),
      userId: "participant",
      isParticipant: true,
      isWorkspaceAdmin: false,
    }),
    false,
  );
});
