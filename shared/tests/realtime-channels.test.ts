import assert from "node:assert/strict";
import test from "node:test";

import {
  isLegacyJoinRequestRealtimeChannel,
  joinRequestRealtimeChannel,
  joinRequestRealtimeChannels,
  meetingJoinRequestsRealtimeChannel,
  meetingJoinRequestsRealtimeChannels,
} from "../domain/realtime-channels";

const workspaceId = "5c3a88a4-b9d8-4efe-8f81-e00f4cf519fc";

void test("join-request realtime channels stay inside the workspace capability namespace", () => {
  assert.equal(
    joinRequestRealtimeChannel({
      workspaceId,
      requestId: "fb749c05-244b-459a-af7b-d6423a0469cb",
    }),
    `workspace:${workspaceId}:join-request:fb749c05-244b-459a-af7b-d6423a0469cb`,
  );

  assert.equal(
    meetingJoinRequestsRealtimeChannel({
      workspaceId,
      meetingId: "d08fe578-1b04-43d9-a4ba-69040245b497",
    }),
    `workspace:${workspaceId}:meeting:d08fe578-1b04-43d9-a4ba-69040245b497:join-requests`,
  );
});

void test("join-request channel sets include scoped and legacy names during rollout", () => {
  assert.deepEqual(
    joinRequestRealtimeChannels({
      workspaceId,
      requestId: "fb749c05-244b-459a-af7b-d6423a0469cb",
    }),
    [
      `workspace:${workspaceId}:join-request:fb749c05-244b-459a-af7b-d6423a0469cb`,
      "join-request:fb749c05-244b-459a-af7b-d6423a0469cb",
    ],
  );
  assert.deepEqual(
    meetingJoinRequestsRealtimeChannels({
      workspaceId,
      meetingId: "d08fe578-1b04-43d9-a4ba-69040245b497",
    }),
    [
      `workspace:${workspaceId}:meeting:d08fe578-1b04-43d9-a4ba-69040245b497:join-requests`,
      "meeting:d08fe578-1b04-43d9-a4ba-69040245b497:join-requests",
    ],
  );
});

void test("legacy join-request channel detection excludes scoped channels", () => {
  assert.equal(isLegacyJoinRequestRealtimeChannel("join-request:request-id"), true);
  assert.equal(isLegacyJoinRequestRealtimeChannel("meeting:meeting-id:join-requests"), true);
  assert.equal(isLegacyJoinRequestRealtimeChannel(`workspace:${workspaceId}:join-request:request-id`), false);
});
