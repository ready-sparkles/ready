import assert from "node:assert/strict";
import test from "node:test";

import {
  formatJoinedDate,
  formatLastSeen,
  memberRoleOptionState,
  parseInviteEmails,
} from "../../../presentation/components/workspace-admin-settings";

void test("last seen renders the spec examples", () => {
  const now = new Date("2026-07-10T12:00:00.000Z");
  assert.equal(formatLastSeen(null, now), "Never");
  assert.equal(formatLastSeen("2026-07-10T11:59:40.000Z", now), "Just now");
  assert.equal(formatLastSeen("2026-07-10T09:00:00.000Z", now), "3 hours ago");
  assert.equal(formatLastSeen("2026-07-09T10:00:00.000Z", now), "Yesterday");
  assert.equal(formatLastSeen("2026-06-25T12:00:00.000Z", now), "15 days ago");
  assert.equal(formatLastSeen("2025-11-01T12:00:00.000Z", now), "Nov 2025");
});

void test("joined date renders month and year", () => {
  assert.equal(formatJoinedDate("2018-11-05T00:00:00.000Z"), "Nov 2018");
  assert.equal(formatJoinedDate("invalid"), "—");
});

void test("invite emails parse from commas, whitespace, and newlines with dedupe", () => {
  assert.deepEqual(parseInviteEmails("a@x.com, B@x.com;\n a@x.com  c@y.io"), ["a@x.com", "b@x.com", "c@y.io"]);
  assert.deepEqual(parseInviteEmails("   "), []);
});

void test("member role menu checks the current role and reserves ownership transfer for owners", () => {
  assert.deepEqual(
    memberRoleOptionState({
      viewerRole: "owner",
      /** @external existing role menu wire field */
      canTransferOwnership: true,
      targetRole: "member",
      targetStatus: "active",
      /** @external existing role menu wire field */
      targetIsSelf: false,
      optionRole: "owner",
    }),
    {
      /** @external existing role menu wire field */
      checked: false,
      /** @external existing role menu wire field */
      disabled: false,
    },
  );
  assert.deepEqual(
    memberRoleOptionState({
      viewerRole: "admin",
      /** @external existing role menu wire field */
      canTransferOwnership: false,
      targetRole: "member",
      targetStatus: "active",
      /** @external existing role menu wire field */
      targetIsSelf: false,
      optionRole: "owner",
    }),
    {
      /** @external existing role menu wire field */
      checked: false,
      /** @external existing role menu wire field */
      disabled: true,
    },
  );
  assert.deepEqual(
    memberRoleOptionState({
      viewerRole: "owner",
      /** @external existing role menu wire field */
      canTransferOwnership: true,
      targetRole: "admin",
      targetStatus: "active",
      /** @external existing role menu wire field */
      targetIsSelf: false,
      optionRole: "admin",
    }),
    {
      /** @external existing role menu wire field */
      checked: true,
      /** @external existing role menu wire field */
      disabled: true,
    },
  );
  assert.deepEqual(
    memberRoleOptionState({
      viewerRole: "owner",
      /** @external existing role menu wire field */
      canTransferOwnership: false,
      targetRole: "member",
      targetStatus: "active",
      /** @external existing role menu wire field */
      targetIsSelf: false,
      optionRole: "owner",
    }),
    {
      /** @external existing role menu wire field */
      checked: false,
      /** @external existing role menu wire field */
      disabled: true,
    },
  );
});
