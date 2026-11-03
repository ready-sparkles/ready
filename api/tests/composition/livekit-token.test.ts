import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { createLiveKitToken } from "../../adapters/secondary/livekit/livekit";

const JWT_PAYLOAD_SEGMENT_INDEX = 1;

const liveKitJwtPayloadSchema = z.object({
  sub: z.string(),
  video: z.object({
    canUpdateOwnMetadata: z.boolean(),
    canPublishData: z.boolean(),
  }),
});

const MISSING_JWT_PAYLOAD_SEGMENT_MESSAGE = "Expected LiveKit token to include a JWT payload segment.";

const identityCases = [
  { identity: "11111111-1111-4111-8111-111111111111:browser", canUpdate: true },
  { identity: "guest:join-request", canUpdate: false },
  { identity: "22222222-2222-4222-8222-222222222222:browser", canUpdate: false },
] as const;

void test("signed-in tokens preserve legacy presentation attributes while guest metadata remains server-owned", async () => {
  await Promise.all(
    identityCases.map(async ({ identity, canUpdate }) => {
      const token = await createLiveKitToken({
        roomName: "test",
        participantIdentity: identity,
        participantUserId: "11111111-1111-4111-8111-111111111111",
        participantName: "Test",
      });
      const payloadSegment = token.split(".")[JWT_PAYLOAD_SEGMENT_INDEX];
      if (payloadSegment === undefined || payloadSegment.length === 0) {
        throw new Error(MISSING_JWT_PAYLOAD_SEGMENT_MESSAGE);
      }
      const payload = liveKitJwtPayloadSchema.parse(JSON.parse(Buffer.from(payloadSegment, "base64url").toString()));
      assert.equal(payload.sub, identity);
      assert.equal(payload.video.canUpdateOwnMetadata, canUpdate);
      assert.equal(payload.video.canPublishData, true);
    }),
  );
});
