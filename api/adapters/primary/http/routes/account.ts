import { AccountDeletionBillingError } from "@readymeet/db/domain/persistence-errors";
import {
  type CalendarProvider,
  deleteAccountRequestSchema,
  deleteAccountResponseSchema,
  logoutAllDevicesResponseSchema,
  mediaPreferencesResponseSchema,
  updateMediaPreferencesRequestSchema,
  updateUserProfileRequestSchema,
  updateUserProfileResponseSchema,
} from "@readymeet/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { CalendarTokenSet } from "../../../../application/calendar-client";
import {
  type PendingGoogleAddonCalendarCredentials,
  revokeStoredGoogleCalendarCredentials,
} from "../../../../application/calendar-oauth-credentials";
import { apiEnv } from "../../../../composition/env";
import { repositories } from "../../../../ports/repository-runtime";
import { decryptStoredJsonSecret, isStoredJsonObject } from "../../../secondary/node/secret-crypto";
import { requireAuth } from "../plugins/auth";

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const MESSAGE_UNAUTHORIZED = "Unauthorized";
const MESSAGE_USER_NOT_FOUND = "User not found";
const MESSAGE_CONFIRMATION_EMAIL_MISMATCH = "Confirmation email does not match your Ready account.";
const WORKSPACE_OWNER_TRANSFER_REQUIRED_CODE = "workspace_owner_transfer_required";

async function revokeCalendarAccount(input: {
  userId: string;
  accountId: string;
  providerAccountId: string | null;
  provider: CalendarProvider;
}) {
  const secret = await repositories().getLatestAgentConnectorSecret(input.accountId);
  const pendingSecret =
    input.provider === "google_calendar" ? await repositories().getPendingAgentConnectorSecret(input.accountId) : null;
  if (secret === null && pendingSecret === null) {
    return {
      provider: input.provider,
      /** @external provider revocation attempted wire field */
      attempted: false,
      reason: "missing_local_secret",
    };
  }
  try {
    if (input.provider === "google_calendar") {
      return await revokeStoredGoogleCalendarCredentials({
        active: secret
          ? decryptStoredJsonSecret({
              secretRef: secret.secretRef,
              schema: z.custom<CalendarTokenSet>(isStoredJsonObject),
            })
          : null,
        pending: pendingSecret
          ? decryptStoredJsonSecret({
              secretRef: pendingSecret.secretRef,
              schema: z.custom<PendingGoogleAddonCalendarCredentials>(isStoredJsonObject),
            })
          : null,
        userId: input.userId,
        googleSubject: input.providerAccountId,
      });
    }

    return {
      provider: input.provider,
      /** @external provider revocation attempted wire field */
      attempted: false,
      reason: "microsoft_revocation_requires_additional_graph_permission",
    };
  } catch (error) {
    return {
      provider: input.provider,
      /** @external provider revocation attempted wire field */
      attempted: true,
      /** @external provider revocation ok wire field */
      ok: false,
      error: error instanceof Error ? error.message : "Provider revocation failed",
    };
  }
}

async function deleteRemainingAccountData(input: { userId: string }) {
  await repositories().deleteRemainingUserAccountRows({ userId: input.userId });
}

function accountDeletionAdminBlockMessage(blocks: { workspaceName: string }[]) {
  const firstWorkspaceName = blocks[0]?.workspaceName ?? "this workspace";
  if (blocks.length <= 1) {
    return `Transfer ownership of ${firstWorkspaceName} before deleting your account.`;
  }

  return `Transfer ownership of ${firstWorkspaceName} and ${blocks.length - 1} other workspaces before deleting your account.`;
}

function registerAccountProfileRoute(app: FastifyInstance): void {
  app.patch("/me/profile", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (user === undefined) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }
    const parsed = updateUserProfileRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
    }

    const updatedUser = await repositories().updateUserProfile({
      userId: user.id,
      displayName: parsed.data.displayName,
    });
    if (updatedUser === null) {
      return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_USER_NOT_FOUND });
    }

    return updateUserProfileResponseSchema.parse({
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        displayName: updatedUser.displayName,
        avatarUrl: updatedUser.avatarUrl,
        source: updatedUser.source,
        authProvider: null,
        plan: updatedUser.plan,
        hasCompletedFirstMeeting: updatedUser.hasCompletedFirstMeeting,
        hasCompletedAgentIntro: Boolean(updatedUser.agentIntroCompletedAt),
        /** @external auth user memory availability wire field */
        memoryAvailable: apiEnv.MEMORY_ENABLED,
        workspaceId: updatedUser.workspaceId,
        sessionVersion: updatedUser.sessionVersion,
        deletedAt: updatedUser.deletedAt?.toISOString() ?? null,
        createdAt: updatedUser.createdAt.toISOString(),
      },
    });
  });
}

function registerAccountMediaPreferencesRoutes(app: FastifyInstance): void {
  app.get("/me/media-preferences", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (user === undefined) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }

    const preferences = await repositories().getUserMediaPreferences(user.id);

    return mediaPreferencesResponseSchema.parse({ preferences });
  });

  app.patch("/me/media-preferences", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (user === undefined) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }
    const parsed = updateMediaPreferencesRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
    }

    const preferences = await repositories().upsertUserMediaPreferences({
      userId: user.id,
      backgroundBlurEnabled: parsed.data.backgroundBlurEnabled,
    });

    return mediaPreferencesResponseSchema.parse({ preferences });
  });
}

function registerAccountLogoutAllDevicesRoute(app: FastifyInstance): void {
  app.post("/me/logout-all-devices", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (user === undefined) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }
    await repositories().incrementUserSessionVersion(user.id);

    return logoutAllDevicesResponseSchema.parse({
      /** @external logout all devices ok wire field */
      ok: true,
    });
  });
}

async function executeReadyAccountDeletion(input: { userId: string; reply: FastifyReply }) {
  // The committed deletion reservation prevents new ownership and checkout claims.
  const adminBlocks = await repositories().listAccountDeletionAdminBlocks(input.userId);
  if (adminBlocks.length !== 0) {
    return input.reply.code(HTTP_CONFLICT).send({
      code: WORKSPACE_OWNER_TRANSFER_REQUIRED_CODE,
      message: accountDeletionAdminBlockMessage(adminBlocks),
    });
  }

  const deletion = await repositories().createDataDeletionRequest({
    userId: input.userId,
    targetKind: "ready_account",
  });

  const calendarAccounts = await repositories().listCalendarAccountsForUser(input.userId);
  const calendarDeletion = await calendarAccounts.reduce<
    Promise<{ providerRevocations: Record<string, unknown>; calendarDeletedAt: Date | null }>
  >(
    async (previous, account) => {
      const state = await previous;
      const revocation = await revokeCalendarAccount({
        userId: input.userId,
        accountId: account.id,
        providerAccountId: account.providerAccountId,
        provider: account.provider,
      });
      await repositories().markCalendarSyncSubscriptionsInactiveForConnector(account.id);
      await repositories().deleteCalendarPrepDataForAccount({ userId: input.userId, accountId: account.id });
      await repositories().disconnectCalendarAccount({ userId: input.userId, accountId: account.id });
      await repositories().softDeleteCalendarAccount({ userId: input.userId, accountId: account.id });

      return {
        providerRevocations: { ...state.providerRevocations, [`calendar:${account.id}`]: revocation },
        calendarDeletedAt: new Date(),
      };
    },
    Promise.resolve({ providerRevocations: {}, calendarDeletedAt: null }),
  );

  await deleteRemainingAccountData({ userId: input.userId });

  await repositories().anonymizeUserAccount(input.userId);
  await repositories().updateDataDeletionRequest({
    id: deletion.id,
    providerRevocationStatus: calendarDeletion.providerRevocations,
    calendarDeletedAt: calendarDeletion.calendarDeletedAt,
  });
  await repositories().finishDataDeletionRequest(deletion.id);

  return deleteAccountResponseSchema.parse({
    /** @external delete account ok wire field */
    ok: true,
    deletionId: deletion.id,
  });
}

function registerDeleteMeAccountRoute(app: FastifyInstance): void {
  app.delete("/me/account", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (user === undefined) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }
    const parsed = deleteAccountRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
    }
    if (parsed.data.confirmationEmail.toLowerCase() !== user.email.toLowerCase()) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_CONFIRMATION_EMAIL_MISMATCH });
    }

    try {
      return await repositories().withAccountDeletionBillingGuard({
        userId: user.id,
        run: async () => executeReadyAccountDeletion({ userId: user.id, reply }),
      });
    } catch (error) {
      if (error instanceof AccountDeletionBillingError) {
        return reply.code(HTTP_CONFLICT).send({ code: error.code, message: error.message });
      }
      throw error;
    }
  });
}

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  registerAccountProfileRoute(app);
  registerAccountMediaPreferencesRoutes(app);
  registerAccountLogoutAllDevicesRoute(app);
  registerDeleteMeAccountRoute(app);
}
