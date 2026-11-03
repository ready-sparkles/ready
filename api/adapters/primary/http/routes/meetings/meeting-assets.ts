import {
  meetingAssetsResponseSchema,
  updateMeetingAssetRequestSchema,
  updateMeetingAssetResponseSchema,
} from "@readymeet/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  listMeetingAssets,
  readMeetingAsset,
  updateMeetingAsset,
} from "../../../../../application/meeting-asset-service";
import { getMeetingAccess, requireMeetingAccess } from "../../support/meeting-access";

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const MESSAGE_MEETING_ASSET_NOT_FOUND = "Meeting asset not found";

const meetingAssetParamsSchema = z.object({ assetId: z.string() });

const requireParticipant = requireMeetingAccess("participant", {
  forbiddenMessage: "Meeting evidence is available only to meeting participants.",
});

export async function meetingAssetRoutes(app: FastifyInstance): Promise<void> {
  app.get("/meetings/:meetingId/assets", { preHandler: requireParticipant }, async (request) => {
    const { meeting } = getMeetingAccess(request);

    return meetingAssetsResponseSchema.parse({
      assets: await listMeetingAssets(meeting.id),
    });
  });

  app.get(
    "/meetings/:meetingId/assets/:assetId/content",
    { preHandler: requireParticipant },
    async (request, reply) => {
      const { meeting } = getMeetingAccess(request);
      const { assetId } = meetingAssetParamsSchema.parse(request.params);
      const record = await readMeetingAsset({ assetId, meetingId: meeting.id });
      if (!record || record.asset.meetingId !== meeting.id) {
        return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_MEETING_ASSET_NOT_FOUND });
      }
      reply.header("content-type", record.asset.mimeType);
      reply.header("cache-control", "no-store");

      return reply.send(record.content);
    },
  );

  app.patch("/meetings/:meetingId/assets/:assetId", { preHandler: requireParticipant }, async (request, reply) => {
    const { meeting } = getMeetingAccess(request);
    const { assetId } = meetingAssetParamsSchema.parse(request.params);
    const parsed = updateMeetingAssetRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
    }
    const asset = await updateMeetingAsset({
      assetId,
      meetingId: meeting.id,
      ...parsed.data,
    });
    if (!asset) {
      return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_MEETING_ASSET_NOT_FOUND });
    }

    return updateMeetingAssetResponseSchema.parse({ asset });
  });
}
