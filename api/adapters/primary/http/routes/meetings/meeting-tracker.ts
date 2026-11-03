import type { FastifyInstance } from "fastify";

import { meetingTrackerEnabled } from "../../../../../application/meeting-tracker";
import { repositories } from "../../../../../ports/repository-runtime";
import { getMeetingAccess } from "../../support/meeting-access";
import { requireMeetingNotesAccess } from "../../support/meeting-notes-guard";

export async function meetingTrackerRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/meetings/:meetingId/tracker",
    { preHandler: requireMeetingNotesAccess({ level: "joined-guest" }) },
    async (request, reply) => {
      reply.header("cache-control", "private, no-store");
      if (!meetingTrackerEnabled()) {
        return { revision: 0, items: [], updatedAt: null, status: "unavailable" };
      }

      return repositories().readMeetingTracker(getMeetingAccess(request).meeting.id);
    },
  );
}
