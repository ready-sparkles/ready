import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import {
  googleAddonConferenceIdempotencyKey,
  outlookAddonConferenceIdempotencyKey,
} from "../adapters/secondary/calendar-addon/idempotency-key";
import { closeDbPool, db } from "../adapters/secondary/postgres/client";
import {
  createOrReuseCalendarAddonConference,
  upsertUserFromAuthentication,
} from "../adapters/secondary/postgres/repositories";
import { getWorkspaceMembership } from "../adapters/secondary/postgres/workspace-admin";

const MISSING_REQUIRED_VALUE = "Expected a value.";
const required = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) {
    throw new Error(MISSING_REQUIRED_VALUE);
  }

  return value;
};

const GOOGLE_AUTH_ACCOUNT_COUNT = 1;
const CONCURRENT_ATTEMPT_COUNT = 4;
const IDEMPOTENCY_KEY_LENGTH = 64;

after(async () => {
  await closeDbPool();
});

void test("authenticated signup resolves provider identity before normalized email and creates an owner workspace", async () => {
  const providerAccountId = `google-${randomUUID()}`;
  const originalEmail = `${randomUUID()}@Example.COM`;
  const created = await upsertUserFromAuthentication({
    provider: "google",
    providerAccountId,
    email: originalEmail,
    displayName: "Calendar Add-on User",
    metadata: { via: "google-workspace-addon" },
  });

  assert.equal(created.accountCreated, true);
  assert.equal(created.user.email, originalEmail.toLowerCase());
  const membership = await getWorkspaceMembership({
    workspaceId: created.user.workspaceId,
    userId: created.user.id,
  });
  assert.equal(membership?.role, "owner");
  assert.equal(membership.status, "active");

  const renamedEmail = `${randomUUID()}@renamed.example`;
  const renamed = await upsertUserFromAuthentication({
    provider: "google",
    providerAccountId,
    email: renamedEmail,
    displayName: "Renamed Calendar User",
    metadata: { via: "google-workspace-addon" },
  });
  assert.equal(renamed.accountCreated, false);
  assert.equal(renamed.user.id, created.user.id);
  assert.equal(renamed.user.workspaceId, created.user.workspaceId);
  assert.equal(renamed.user.email, renamedEmail);

  await assert.rejects(
    upsertUserFromAuthentication({
      provider: "google",
      providerAccountId: `google-${randomUUID()}`,
      email: renamedEmail.toUpperCase(),
      displayName: "Different identity",
    }),
    /original provider account/,
  );
  await assert.rejects(
    upsertUserFromAuthentication({
      provider: "microsoft-entra-id",
      providerAccountId: randomUUID(),
      email: renamedEmail,
      displayName: "Unverified Microsoft email",
    }),
    /original provider account/,
  );

  const authRows = await db.userAuthAccounts.findMany({
    where: { userId: created.user.id, provider: "google" },
    select: { /** @external Prisma field */ providerAccountId: true, /** @external Prisma field */ metadata: true },
    orderBy: { createdAt: "asc" },
  });
  assert.equal(authRows.length, GOOGLE_AUTH_ACCOUNT_COUNT);
  const metadata = authRows.find((row) => row.providerAccountId === providerAccountId)?.metadata;
  const firstLinkedVia =
    metadata !== null &&
    metadata !== undefined &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    "firstLinkedVia" in metadata
      ? metadata.firstLinkedVia
      : undefined;
  assert.equal(firstLinkedVia, "google-workspace-addon");
});

void test("concurrent first-use authentication creates exactly one Ready account", async () => {
  const providerAccountId = `google-${randomUUID()}`;
  const email = `${randomUUID()}@concurrent.readymeet.test`;
  const results = await Promise.all(
    Array.from({ length: CONCURRENT_ATTEMPT_COUNT }, () =>
      upsertUserFromAuthentication({
        provider: "google",
        providerAccountId,
        email,
        displayName: "Concurrent Add-on User",
        metadata: { via: "google-workspace-addon" },
      }),
    ),
  );

  assert.equal(new Set(results.map((result) => result.user.id)).size, 1);
  assert.equal(results.filter((result) => result.accountCreated).length, 1);
  assert.equal(new Set(results.map((result) => result.user.workspaceId)).size, 1);
});

void test("Google Calendar conference retries reuse one meeting link", async () => {
  const authenticated = await upsertUserFromAuthentication({
    provider: "google",
    providerAccountId: `google-${randomUUID()}`,
    email: `${randomUUID()}@addon-conference.readymeet.test`,
    displayName: "Add-on Conference User",
    metadata: { via: "google-workspace-addon" },
  });
  const idempotencyKey = randomUUID().replaceAll("-", "").padEnd(IDEMPOTENCY_KEY_LENGTH, "0");
  const firstCode = `addon-${randomUUID()}`;

  const first = await createOrReuseCalendarAddonConference({
    title: "Calendar add-on meeting",
    code: firstCode,
    createdByUserId: authenticated.user.id,
    workspaceId: authenticated.user.workspaceId,
    idempotencyKey,
  });
  const secondCode = `addon-${randomUUID()}`;
  const second = await createOrReuseCalendarAddonConference({
    title: "Calendar add-on meeting retry",
    code: secondCode,
    createdByUserId: authenticated.user.id,
    workspaceId: authenticated.user.workspaceId,
    idempotencyKey,
  });

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.meetingLink.id, first.meetingLink.id);
  assert.equal(second.meeting?.id, first.meeting?.id);

  const mappingRows = await db.googleAddonConferences.findMany({
    where: { userId: authenticated.user.id, idempotencyKey },
    select: { /** @external Prisma field */ id: true },
  });
  assert.equal(mappingRows.length, 1);
});

void test("Outlook concurrent retries are durable and isolated from Google and other users", async () => {
  const signup = () =>
    upsertUserFromAuthentication({
      provider: "microsoft-entra-id",
      providerAccountId: randomUUID(),
      email: `${randomUUID()}@outlook.readymeet.test`,
      displayName: "Outlook User",
    });
  const firstUser = (await signup()).user;
  const secondUser = (await signup()).user;
  const requestId = randomUUID();
  const key = outlookAddonConferenceIdempotencyKey(requestId);
  const create = ({ user, idempotencyKey = key }: { user: typeof firstUser; idempotencyKey?: string }) => {
    const meetingCode = `outlook-${randomUUID()}`;

    return createOrReuseCalendarAddonConference({
      title: "Outlook meeting",
      code: meetingCode,
      createdByUserId: user.id,
      workspaceId: user.workspaceId,
      idempotencyKey,
    });
  };
  const concurrent = await Promise.all(
    Array.from({ length: CONCURRENT_ATTEMPT_COUNT }, () => create({ user: firstUser })),
  );
  assert.equal(new Set(concurrent.map((result) => result.meetingLink.id)).size, 1);
  assert.equal(concurrent.filter((result) => !result.reused).length, 1);
  assert.equal((await create({ user: firstUser })).meetingLink.id, required(concurrent[0]).meetingLink.id);
  assert.notEqual((await create({ user: secondUser })).meetingLink.id, required(concurrent[0]).meetingLink.id);
  const googleKey = googleAddonConferenceIdempotencyKey({ calendarId: "calendar", eventId: requestId });
  assert.notEqual(
    (await create({ user: firstUser, idempotencyKey: googleKey })).meetingLink.id,
    required(concurrent[0]).meetingLink.id,
  );
});

void test("concurrent Outlook retries replace a disabled room once without reviving it", async () => {
  const { user } = await upsertUserFromAuthentication({
    provider: "microsoft-entra-id",
    providerAccountId: randomUUID(),
    email: `${randomUUID()}@outlook.readymeet.test`,
    displayName: "Replacement User",
  });
  const key = outlookAddonConferenceIdempotencyKey(randomUUID());
  const create = ({ shouldReplaceInactive = true }: { shouldReplaceInactive?: boolean } = {}) => {
    const meetingCode = `outlook-${randomUUID()}`;

    return createOrReuseCalendarAddonConference({
      title: "Replacement",
      code: meetingCode,
      createdByUserId: user.id,
      workspaceId: user.workspaceId,
      idempotencyKey: key,
      /** @external existing conference option */
      replaceInactive: shouldReplaceInactive,
    });
  };
  const original = await create();
  await db.meetingLinks.updateMany({ where: { id: original.meetingLink.id }, data: { status: "disabled" } });
  // Other providers retain their prior retry behavior.
  assert.equal((await create({ shouldReplaceInactive: false })).meetingLink.id, original.meetingLink.id);
  const replacement = await Promise.all(Array.from({ length: CONCURRENT_ATTEMPT_COUNT }, () => create()));
  assert.equal(new Set(replacement.map((x) => x.meetingLink.id)).size, 1);
  assert.equal(replacement.filter((x) => !x.reused).length, 1);
  assert.notEqual(required(replacement[0]).meetingLink.id, original.meetingLink.id);
  assert.equal((await create()).meetingLink.id, required(replacement[0]).meetingLink.id);
  const old = await db.meetingLinks.findMany({
    where: { id: original.meetingLink.id },
    select: { /** @external Prisma field */ status: true },
  });
  assert.equal(required(old[0]).status, "disabled");
  const mappings = await db.googleAddonConferences.findMany({
    where: { userId: user.id, idempotencyKey: key },
    select: { /** @external Prisma field */ meetingLinkId: true },
  });
  assert.equal(mappings.length, 1);
  assert.equal(required(mappings[0]).meetingLinkId, required(replacement[0]).meetingLink.id);
});
