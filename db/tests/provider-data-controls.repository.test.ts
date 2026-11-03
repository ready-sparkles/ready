import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { closeDbPool } from "../adapters/secondary/postgres/client";
import {
  createDataDeletionRequest,
  disconnectCalendarAccount,
  ensureDefaultAgentProfileForUser,
  getLatestAgentConnectorSecret,
  getPendingAgentConnectorSecret,
  listCalendarAccountsForUser,
  softDeleteCalendarAccount,
  stageGoogleAddonCalendarCredentials,
  updateCalendarAccountKind,
  updateDataDeletionRequest,
  upsertAgentConnector,
  upsertUser,
} from "../adapters/secondary/postgres/repositories";

after(async () => {
  await closeDbPool();
});

const STAGE_GOOGLE_CREDENTIALS_ATTEMPT_COUNT = 4;
const CALENDAR_ACCOUNT_MISSING_MESSAGE = "Expected a connected calendar account.";
const DATA_DELETION_PROVIDER_REVOCATION_STATUS = {
  /** @external data deletion provider status */
  attempted: true,
  /** @external data deletion provider status */
  ok: false,
} as const;

void test("pending add-on credentials remain disconnected and never replace connected secrets", async () => {
  const user = await upsertUser({
    email: `${randomUUID()}@pending-addon.readymeet.test`,
    displayName: "Pending Add-on",
  });
  const profile = await ensureDefaultAgentProfileForUser({
    userId: user.id,
    displayName: user.displayName,
    voiceId: null,
    llmModel: null,
  });
  const input = {
    userId: user.id,
    agentProfileId: profile.id,
    googleSubject: `google-${randomUUID()}`,
    googleEmail: user.email,
    secretRef: "encrypted-pending-secret",
  };
  assert.equal(await stageGoogleAddonCalendarCredentials(input), true);
  const [pending] = await listCalendarAccountsForUser(user.id);
  assert.ok(pending);
  assert.equal(pending.status, "error");
  assert.equal(pending.providerAccountId, input.googleSubject);
  assert.equal(pending.providerEmail, user.email);
  assert.equal(pending.connectedAt, null);
  assert.equal(await getLatestAgentConnectorSecret(pending.id), null);
  assert.equal((await getPendingAgentConnectorSecret(pending.id))?.secretRef, input.secretRef);
  // PostgreSQL rejects NUL text. A failed secret insert must roll back promotion.
  await assert.rejects(
    upsertAgentConnector({
      userId: user.id,
      agentProfileId: profile.id,
      provider: "google_calendar",
      providerAccountId: input.googleSubject,
      status: "connected",
      secretRef: "invalid\u0000secret",
    }),
  );
  assert.equal((await listCalendarAccountsForUser(user.id))[0]?.status, "error");
  assert.equal(await getLatestAgentConnectorSecret(pending.id), null);
  assert.equal((await getPendingAgentConnectorSecret(pending.id))?.secretRef, input.secretRef);
  await upsertAgentConnector({
    userId: user.id,
    agentProfileId: profile.id,
    provider: "google_calendar",
    providerAccountId: input.googleSubject,
    status: "connected",
    secretRef: "validated-connected-secret",
  });
  assert.equal(await getPendingAgentConnectorSecret(pending.id), null);
  assert.deepEqual(
    await Promise.all(
      Array.from({ length: STAGE_GOOGLE_CREDENTIALS_ATTEMPT_COUNT }, () =>
        stageGoogleAddonCalendarCredentials({ ...input, secretRef: "fresh-pending-grant" }),
      ),
    ),
    [true, true, true, true],
  );
  assert.equal((await getPendingAgentConnectorSecret(pending.id))?.secretRef, "fresh-pending-grant");
  assert.equal((await listCalendarAccountsForUser(user.id))[0]?.status, "connected");
  assert.equal((await getLatestAgentConnectorSecret(pending.id))?.secretRef, "validated-connected-secret");
  const [connectedVersion] = await listCalendarAccountsForUser(user.id);
  if (connectedVersion === undefined) {
    throw new Error(CALENDAR_ACCOUNT_MISSING_MESSAGE);
  }
  assert.equal(
    await disconnectCalendarAccount({
      userId: user.id,
      accountId: pending.id,
      preservePending: true,
      expectedUpdatedAt: new Date(new Date(connectedVersion.updatedAt).getTime() - 1),
    }),
    null,
  );
  assert.equal((await getLatestAgentConnectorSecret(pending.id))?.secretRef, "validated-connected-secret");
  // An automatic invalid_grant cleanup must leave a fresh pending grant recoverable.
  await disconnectCalendarAccount({
    userId: user.id,
    accountId: pending.id,
    preservePending: true,
    expectedUpdatedAt: new Date(connectedVersion.updatedAt),
  });
  assert.equal((await listCalendarAccountsForUser(user.id))[0]?.status, "error");
  assert.equal(await getLatestAgentConnectorSecret(pending.id), null);
  assert.equal((await getPendingAgentConnectorSecret(pending.id))?.secretRef, "fresh-pending-grant");
  // Explicit user disconnect still removes both credential stores.
  await disconnectCalendarAccount({ userId: user.id, accountId: pending.id });
  assert.equal(await getLatestAgentConnectorSecret(pending.id), null);
  assert.equal(await getPendingAgentConnectorSecret(pending.id), null);
  await stageGoogleAddonCalendarCredentials(input);
  await softDeleteCalendarAccount({ userId: user.id, accountId: pending.id });
  assert.equal(await getPendingAgentConnectorSecret(pending.id), null);
});

void test("calendar accounts support multiple accounts per provider and soft-deleted reconnects", async () => {
  const user = await upsertUser({
    email: `${randomUUID()}@provider-controls.readymeet.test`,
    displayName: "Provider Controls User",
  });
  const profile = await ensureDefaultAgentProfileForUser({
    userId: user.id,
    displayName: user.displayName,
    voiceId: null,
    llmModel: null,
  });

  const first = await upsertAgentConnector({
    userId: user.id,
    agentProfileId: profile.id,
    provider: "google_calendar",
    providerAccountId: `google-${randomUUID()}`,
    providerEmail: `${randomUUID()}@example.com`,
    status: "connected",
    scope: "private",
    accountKind: "work",
    secretRef: "secret-one",
  });
  const second = await upsertAgentConnector({
    userId: user.id,
    agentProfileId: profile.id,
    provider: "google_calendar",
    providerAccountId: `google-${randomUUID()}`,
    providerEmail: `${randomUUID()}@example.com`,
    status: "connected",
    scope: "private",
    accountKind: "personal",
    secretRef: "secret-two",
  });

  const accounts = await listCalendarAccountsForUser(user.id);
  assert.deepEqual(new Set(accounts.map((account) => account.id)), new Set([first.id, second.id]));

  const updated = await updateCalendarAccountKind({
    userId: user.id,
    accountId: first.id,
    accountKind: "personal",
  });
  assert.equal(updated?.accountKind, "personal");

  const disconnected = await disconnectCalendarAccount({ userId: user.id, accountId: first.id });
  assert.equal(disconnected?.status, "disconnected");

  await softDeleteCalendarAccount({ userId: user.id, accountId: first.id });
  const reconnected = await upsertAgentConnector({
    userId: user.id,
    agentProfileId: profile.id,
    provider: "google_calendar",
    providerAccountId: first.providerAccountId,
    providerEmail: "reconnected@example.com",
    status: "connected",
    scope: "private",
    accountKind: "work",
    secretRef: "secret-three",
  });
  assert.notEqual(reconnected.id, first.id);
});

void test("data deletion ledger records provider and completion status", async () => {
  const user = await upsertUser({
    email: `${randomUUID()}@deletion-ledger.readymeet.test`,
    displayName: "Deletion Ledger User",
  });

  const request = await createDataDeletionRequest({
    userId: user.id,
    targetKind: "calendar_account",
    targetProvider: "google_calendar",
    targetAccountId: randomUUID(),
  });
  const completedAt = new Date();
  const updated = await updateDataDeletionRequest({
    id: request.id,
    status: "completed",
    providerRevocationStatus: DATA_DELETION_PROVIDER_REVOCATION_STATUS,
    calendarDeletedAt: completedAt,
    completedAt,
  });

  assert.equal(updated?.status, "completed");
  assert.deepEqual(updated.providerRevocationStatus, DATA_DELETION_PROVIDER_REVOCATION_STATUS);
  assert.ok(updated.completedAt);
});
