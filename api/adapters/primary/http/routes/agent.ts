import type { RepositoryPort } from "@readymeet/db/ports/repository";
import {
  addAgentMemoryRequestSchema,
  addAgentMemoryResponseSchema,
  agentSettingsResponseSchema,
  updateAgentProfileRequestSchema,
  updateAgentProfileResponseSchema,
  upsertAgentConnectorRequestSchema,
  upsertAgentConnectorResponseSchema,
  upsertAgentToolPolicyRequestSchema,
  upsertAgentToolPolicyResponseSchema,
} from "@readymeet/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { repositories } from "../../../../ports/repository-runtime";
import { requireAuth } from "../plugins/auth";

const HTTP_UNAUTHORIZED = 401;
const HTTP_BAD_REQUEST = 400;

const MESSAGE_UNAUTHORIZED = "Unauthorized";

type AuthenticatedUser = NonNullable<FastifyRequest["user"]>;
type AgentProfile = Awaited<ReturnType<RepositoryPort["ensureDefaultAgentProfileForUser"]>>;
type AgentMemory = Awaited<ReturnType<RepositoryPort["listAgentMemoriesForUser"]>>[number];
type AgentConnector = Awaited<ReturnType<RepositoryPort["listAgentConnectorsForUser"]>>[number];
type AgentToolPolicy = Awaited<ReturnType<RepositoryPort["listAgentToolPolicies"]>>[number];

function toAgentProfileDTO(profile: AgentProfile) {
  return {
    id: profile.id,
    userId: profile.userId,
    name: profile.name,
    displayName: profile.displayName,
    systemPrompt: profile.systemPrompt ?? null,
    voiceProvider: profile.voiceProvider,
    voiceId: null,
    llmModel: profile.llmModel ?? null,
    isDefault: profile.isDefault,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

function toAgentMemoryDTO(memory: AgentMemory) {
  return {
    id: memory.id,
    userId: memory.userId,
    agentProfileId: memory.agentProfileId,
    memoryType: memory.memoryType,
    content: memory.content,
    source: memory.source,
    createdAt: memory.createdAt.toISOString(),
    updatedAt: memory.updatedAt.toISOString(),
  };
}

function toAgentConnectorDTO(connector: AgentConnector) {
  return {
    id: connector.id,
    userId: connector.userId,
    agentProfileId: connector.agentProfileId,
    provider: connector.provider,
    status: connector.status,
    scope: connector.scope,
    providerAccountId: connector.providerAccountId ?? null,
    providerEmail: connector.providerEmail ?? null,
    providerTenantId: connector.providerTenantId ?? null,
    externalAccountEmail: connector.externalAccountEmail ?? null,
    scopes: connector.scopes,
    syncStatus: connector.syncStatus,
    accountKind: connector.accountKind ?? null,
    lastSyncedAt: connector.lastSyncedAt?.toISOString() ?? null,
    connectedAt: connector.connectedAt?.toISOString() ?? null,
    disconnectedAt: connector.disconnectedAt?.toISOString() ?? null,
    deletedAt: connector.deletedAt?.toISOString() ?? null,
    createdAt: connector.createdAt.toISOString(),
    updatedAt: connector.updatedAt.toISOString(),
  };
}

function toAgentToolPolicyDTO(policy: AgentToolPolicy) {
  return {
    id: policy.id,
    agentProfileId: policy.agentProfileId,
    toolName: policy.toolName,
    mode: policy.mode,
    config: policy.config,
    createdAt: policy.createdAt.toISOString(),
    updatedAt: policy.updatedAt.toISOString(),
  };
}

function sendUnauthorized(reply: FastifyReply) {
  return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
}

function sendBadRequest(input: { reply: FastifyReply; message: string }) {
  return input.reply.code(HTTP_BAD_REQUEST).send({ message: input.message });
}

async function ensureProfileForUser(user: AuthenticatedUser) {
  return repositories().ensureDefaultAgentProfileForUser({
    userId: user.id,
    displayName: user.displayName,
    voiceId: null,
    llmModel: null,
  });
}

async function handleGetAgentSettings(request: FastifyRequest, reply: FastifyReply) {
  const user = request.user;
  if (user === undefined) {
    return sendUnauthorized(reply);
  }

  const profile = await ensureProfileForUser(user);

  const [memories, connectors, toolPolicies] = await Promise.all([
    repositories().listAgentMemoriesForUser(user.id, profile.id),
    repositories().listAgentConnectorsForUser(user.id, profile.id),
    repositories().listAgentToolPolicies(profile.id),
  ]);

  return agentSettingsResponseSchema.parse({
    profile: toAgentProfileDTO(profile),
    memories: memories.map(toAgentMemoryDTO),
    connectors: connectors.map(toAgentConnectorDTO),
    toolPolicies: toolPolicies.map(toAgentToolPolicyDTO),
  });
}

async function handlePutAgentProfile(request: FastifyRequest, reply: FastifyReply) {
  const user = request.user;
  if (user === undefined) {
    return sendUnauthorized(reply);
  }

  const parsed = updateAgentProfileRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return sendBadRequest({ reply, message: parsed.error.message });
  }

  const profile = await repositories().updateDefaultAgentProfileForUser({
    userId: user.id,
    displayName: parsed.data.displayName ?? user.displayName,
    voiceId: null,
    llmModel: parsed.data.llmModel,
    systemPrompt: parsed.data.systemPrompt,
  });

  return updateAgentProfileResponseSchema.parse({
    profile: toAgentProfileDTO(profile),
  });
}

async function handlePostAgentMemory(request: FastifyRequest, reply: FastifyReply) {
  const user = request.user;
  if (user === undefined) {
    return sendUnauthorized(reply);
  }

  const parsed = addAgentMemoryRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return sendBadRequest({ reply, message: parsed.error.message });
  }

  const profile = await ensureProfileForUser(user);

  const memory = await repositories().addAgentMemory({
    userId: user.id,
    agentProfileId: profile.id,
    memoryType: parsed.data.memoryType,
    content: parsed.data.content,
    source: parsed.data.source,
  });

  return addAgentMemoryResponseSchema.parse({
    memory: toAgentMemoryDTO(memory),
  });
}

async function handlePostAgentConnector(request: FastifyRequest, reply: FastifyReply) {
  const user = request.user;
  if (user === undefined) {
    return sendUnauthorized(reply);
  }

  const parsed = upsertAgentConnectorRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return sendBadRequest({ reply, message: parsed.error.message });
  }

  const profile = await ensureProfileForUser(user);

  const connector = await repositories().upsertAgentConnector({
    userId: user.id,
    agentProfileId: profile.id,
    provider: parsed.data.provider,
    status: parsed.data.status,
    scope: parsed.data.scope,
    externalAccountEmail: parsed.data.externalAccountEmail,
    secretRef: parsed.data.secretRef,
  });

  return upsertAgentConnectorResponseSchema.parse({
    connector: toAgentConnectorDTO(connector),
  });
}

async function handlePostAgentToolPolicy(request: FastifyRequest, reply: FastifyReply) {
  const user = request.user;
  if (user === undefined) {
    return sendUnauthorized(reply);
  }

  const parsed = upsertAgentToolPolicyRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return sendBadRequest({ reply, message: parsed.error.message });
  }

  const profile = await ensureProfileForUser(user);

  const toolPolicy = await repositories().upsertAgentToolPolicy({
    agentProfileId: profile.id,
    toolName: parsed.data.toolName,
    mode: parsed.data.mode,
    config: parsed.data.config,
  });

  return upsertAgentToolPolicyResponseSchema.parse({
    toolPolicy: toAgentToolPolicyDTO(toolPolicy),
  });
}

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me/agent", { preHandler: requireAuth }, handleGetAgentSettings);
  app.put("/me/agent", { preHandler: requireAuth }, handlePutAgentProfile);
  app.post("/me/agent/memories", { preHandler: requireAuth }, handlePostAgentMemory);
  app.post("/me/agent/connectors", { preHandler: requireAuth }, handlePostAgentConnector);
  app.post("/me/agent/tool-policies", { preHandler: requireAuth }, handlePostAgentToolPolicy);
}
