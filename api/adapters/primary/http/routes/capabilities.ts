import type { RepositoryPort } from "@readymeet/db/ports/repository";
import {
  capabilityListResponseSchema,
  updateCapabilityPreferenceRequestSchema,
  updateCapabilityPreferenceResponseSchema,
} from "@readymeet/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { repositories } from "../../../../ports/repository-runtime";
import { requireAuth } from "../plugins/auth";

type UserCapability = Awaited<ReturnType<RepositoryPort["listCapabilitiesForUser"]>>[number];

const capabilityPreferenceParamsSchema = z.object({ capabilityKey: z.string() });

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const MESSAGE_UNAUTHORIZED = "Unauthorized";
const MESSAGE_CAPABILITY_NOT_FOUND = "Capability not found";

const REMOVED_CAPABILITY_KEYS = new Set([
  "create_task_list",
  "draft_decision_brief",
  "draft_spec_outline",
  "prepare_briefing_for_next_meeting",
]);

function toUserCapabilityDTO(capability: UserCapability) {
  return {
    id: capability.id,
    key: capability.key,
    name: capability.name,
    description: capability.description,
    category: capability.category,
    applicableMeetingTypes: capability.applicableMeetingTypes,
    requiredSignals: capability.requiredSignals,
    exclusionSignals: capability.exclusionSignals,
    exampleTriggers: capability.exampleTriggers,
    sideEffectScope: capability.sideEffectScope,
    defaultPriority: capability.defaultPriority,
    isActive: capability.isActive,
    isEnabled: capability.isEnabled,
    metadata: capability.metadata,
    createdAt: capability.createdAt.toISOString(),
    updatedAt: capability.updatedAt.toISOString(),
  };
}

export async function capabilityRoutes(app: FastifyInstance): Promise<void> {
  app.get("/capabilities", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }

    const capabilities = (await repositories().listCapabilitiesForUser(user.id)).filter(
      (capability) => !REMOVED_CAPABILITY_KEYS.has(capability.key),
    );

    return capabilityListResponseSchema.parse({
      capabilities: capabilities.map(toUserCapabilityDTO),
    });
  });

  app.patch("/capabilities/:capabilityKey/preference", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (!user) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }

    const { capabilityKey } = capabilityPreferenceParamsSchema.parse(request.params);
    if (REMOVED_CAPABILITY_KEYS.has(capabilityKey)) {
      return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_CAPABILITY_NOT_FOUND });
    }

    const parsed = updateCapabilityPreferenceRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
    }

    const capability = await repositories().upsertUserCapabilityPreference({
      userId: user.id,
      capabilityKey,
      isEnabled: parsed.data.isEnabled,
    });

    if (!capability) {
      return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_CAPABILITY_NOT_FOUND });
    }

    return updateCapabilityPreferenceResponseSchema.parse({
      capability: toUserCapabilityDTO(capability),
    });
  });
}
