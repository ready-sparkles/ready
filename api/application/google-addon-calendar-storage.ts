import { z } from "zod";

import { decryptStoredJsonSecret, encryptJsonSecret, isStoredJsonObject } from "../ports/gate-secret-crypto";
import { repositories } from "../ports/repository-runtime";

import type { PendingGoogleAddonCalendarCredentials } from "./calendar-oauth-credentials";

type GoogleAddonCalendarCredentialStorage = {
  userId: string;
  stage: (credentials: PendingGoogleAddonCalendarCredentials) => Promise<void>;
  read: () => Promise<PendingGoogleAddonCalendarCredentials | null>;
};

// Call only after the Ready user and Google subject have been authenticated.
export function googleAddonCalendarCredentialStorage(input: {
  user: { id: string; displayName: string; email: string };
  googleSubject: string;
}): GoogleAddonCalendarCredentialStorage {
  const { user, googleSubject } = input;

  return {
    userId: user.id,
    stage: async (credentials: PendingGoogleAddonCalendarCredentials) => {
      const profile = await repositories().ensureDefaultAgentProfileForUser({
        userId: user.id,
        displayName: user.displayName,
        voiceId: null,
        llmModel: null,
      });
      await repositories().stageGoogleAddonCalendarCredentials({
        userId: user.id,
        agentProfileId: profile.id,
        googleSubject,
        googleEmail: user.email,
        secretRef: encryptJsonSecret(credentials),
      });
    },
    read: async () => {
      const connector = await repositories().getAgentConnectorForUser({
        userId: user.id,
        provider: "google_calendar",
        providerAccountId: googleSubject,
      });
      if (connector === null || (connector.status !== "connected" && connector.status !== "error")) {
        return null;
      }
      const secret = await repositories().getPendingAgentConnectorSecret(connector.id);

      return secret === null
        ? null
        : decryptStoredJsonSecret({
            secretRef: secret.secretRef,
            schema: z.custom<PendingGoogleAddonCalendarCredentials>(isStoredJsonObject),
          });
    },
  };
}
