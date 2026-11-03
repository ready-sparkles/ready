import type { FastifyInstance } from "fastify";

import { meetingAmbientContextRoutes } from "./ambient-context";
import { ashbyReviewRoutes } from "./ashby-review";
import { linearTaskReviewRoutes } from "./linear-task-review";
import { meetingAgentToolRoutes } from "./meeting-agent-tools";
import { meetingAssetRoutes } from "./meeting-assets";
import { meetingDebugRoutes } from "./meeting-debug";
import { meetingInviteRoutes } from "./meeting-invites";
import { meetingLifecycleRoutes } from "./meeting-lifecycle";
import { meetingLinkRoutes } from "./meeting-links";
import { meetingPipelineRoutes } from "./meeting-pipelines";
import { meetingResearchRoutes } from "./meeting-research";
import { meetingTaskRoutes } from "./meeting-tasks";
import { meetingTrackerRoutes } from "./meeting-tracker";
import { slackReviewRoutes } from "./slack-review";
import { workspaceTaskRoutes } from "./workspace-tasks";

export async function meetingRoutes(app: FastifyInstance): Promise<void> {
  await app.register(workspaceTaskRoutes);
  await app.register(meetingLinkRoutes);
  await app.register(meetingLifecycleRoutes);
  await app.register(meetingPipelineRoutes);
  await app.register(meetingTaskRoutes);
  await app.register(meetingResearchRoutes);
  await app.register(meetingAgentToolRoutes);
  await app.register(meetingDebugRoutes);
  await app.register(linearTaskReviewRoutes);
  await app.register(slackReviewRoutes);
  await app.register(ashbyReviewRoutes);
  await app.register(meetingInviteRoutes);
  await app.register(meetingAssetRoutes);
  await app.register(meetingAmbientContextRoutes);
  await app.register(meetingTrackerRoutes);
}
