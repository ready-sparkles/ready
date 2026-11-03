import "fastify";

import type { UserPlan } from "@readymeet/shared";

declare module "fastify" {
  interface FastifyRequest {
    user?: {
      id: string;
      email: string;
      displayName: string;
      avatarUrl?: string | null;
      plan: UserPlan;
      workspaceId: string;
      source: "auth" | "dev_login" | "debug_import" | "guest";
      tokenKind: "full" | "guest";
      guestSessionId?: string;
      meetingId?: string | null;
      meetingLinkId?: string | null;
      joinRequestId?: string | null;
    };
  }
}
