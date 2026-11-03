import {
  GUEST_RECOGNITION_NOTICE_VERSION,
  GUEST_RECOGNITION_PURPOSE,
  GUEST_RECOGNITION_TTL_SECONDS,
} from "@readymeet/shared";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { GuestRecognitionConsentRequired } from "../../../domain/persistence-errors";

import { db } from "./client";

export { GuestRecognitionConsentRequired };

const GUEST_RECOGNITION_TOKEN_BYTES = 32;
const MS_PER_SECOND = 1000;
const GUEST_RECOGNITION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const GUEST_RECOGNITION_CONSENT_MESSAGE = "Please opt in again to enable browser recognition.";
const GUEST_RECOGNITION_IDENTITY_INSERT_ERROR = "Guest recognition identity insert returned no row.";
const GUEST_RECOGNITION_EXISTING_TOKEN_ERROR = "Guest recognition token is required for an existing identity.";
const GUEST_DISPLAY_NAME_FALLBACK = "guest";

function tokenHash(token: string | undefined): string | null {
  if (token === undefined || token === "") {
    return null;
  }

  return GUEST_RECOGNITION_TOKEN_PATTERN.test(token) ? createHash("sha256").update(token).digest("hex") : null;
}

type GuestRecognitionRow = {
  id: string;
  expiresAt: Date;
  lastDisplayName: string | null;
};

type GuestIdentityRow = { id: string; expiresAt: Date };

const findActiveGuestIdentity = async (token: string | undefined): Promise<GuestIdentityRow | null> => {
  const hash = tokenHash(token);
  if (hash === null) {
    return null;
  }
  const row = await db.guestBrowserIdentities.findFirst({
    where: {
      tokenHash: hash,
      revokedAt: null,
      expiresAt: { gt: new Date() },
      noticeVersion: GUEST_RECOGNITION_NOTICE_VERSION,
    },
  });

  return row === null ? null : { id: row.id, expiresAt: row.expiresAt };
};

const createGuestIdentity = async (token: string): Promise<{ identity: GuestIdentityRow; token: string }> => {
  const hash = tokenHash(token);
  if (hash === null) {
    throw new Error(GUEST_RECOGNITION_IDENTITY_INSERT_ERROR);
  }
  const consentedAt = new Date();
  const expiresAt = new Date(consentedAt.getTime() + GUEST_RECOGNITION_TTL_SECONDS * MS_PER_SECOND);
  const identity = await db.guestBrowserIdentities.create({
    data: {
      id: randomUUID(),
      tokenHash: hash,
      noticeVersion: GUEST_RECOGNITION_NOTICE_VERSION,
      purpose: GUEST_RECOGNITION_PURPOSE,
      consentedAt,
      expiresAt,
    },
  });

  return { identity: { id: identity.id, expiresAt: identity.expiresAt }, token };
};

const resolveGuestIdentity = async (input: {
  token?: string;
  /** @external existing guest recognition API field */
  explicitOptIn: boolean;
}): Promise<{ identity: GuestIdentityRow; token: string }> => {
  const existing = await findActiveGuestIdentity(input.token);
  if (existing !== null) {
    return { identity: existing, token: input.token ?? "" };
  }
  if (!input.explicitOptIn) {
    throw new GuestRecognitionConsentRequired(GUEST_RECOGNITION_CONSENT_MESSAGE);
  }

  return createGuestIdentity(randomBytes(GUEST_RECOGNITION_TOKEN_BYTES).toString("base64url"));
};

const associateGuestBrowser = async (input: { guestUserId: string; browserId: string }): Promise<void> => {
  const guest = await db.users.findFirst({
    where: { id: input.guestUserId, source: "guest" },
  });
  if (guest === null) {
    return;
  }
  await db.$executeRaw`
    INSERT INTO guest_browser_users (guest_user_id, browser_id)
    VALUES (CAST(${input.guestUserId} AS uuid), CAST(${input.browserId} AS uuid))
    ON CONFLICT (guest_user_id) DO NOTHING
  `;
};

const lastGuestDisplayName = async (browserId: string): Promise<string | null> => {
  const row = await db.guestBrowserUsers.findFirst({
    where: {
      browserId,
      users: { source: "guest", deletedAt: null },
    },
    include: { users: {} },
    orderBy: [{ associatedAt: "desc" }, { guestUserId: "desc" }],
  });

  return row?.users.displayName ?? null;
};

export async function getGuestRecognition(token: string | undefined): Promise<GuestRecognitionRow | null> {
  const identity = await findActiveGuestIdentity(token);
  if (identity === null) {
    return null;
  }

  return { ...identity, lastDisplayName: await lastGuestDisplayName(identity.id) };
}

export async function revokeGuestRecognition(token: string | undefined): Promise<void> {
  const hash = tokenHash(token);
  if (hash === null) {
    return;
  }
  await db.guestBrowserIdentities.updateMany({
    where: { tokenHash: hash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function recognizeGuest(input: {
  token?: string;
  guestUserId: string;
  /** @external existing guest recognition API field */
  explicitOptIn: boolean;
}): Promise<{ token: string; expiresAt: Date }> {
  const resolved = await resolveGuestIdentity(input);
  if (resolved.token === "") {
    throw new Error(GUEST_RECOGNITION_EXISTING_TOKEN_ERROR);
  }
  await associateGuestBrowser({ guestUserId: input.guestUserId, browserId: resolved.identity.id });

  return { token: resolved.token, expiresAt: resolved.identity.expiresAt };
}

export function normalizeGuestName(name: string): { display: string; normalized: string; wordCount: number } {
  const display = name.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const normalized = display.toLocaleLowerCase("en-US");
  const hasDisplayName = display !== "" && normalized !== GUEST_DISPLAY_NAME_FALLBACK;

  return {
    display,
    normalized,
    wordCount: hasDisplayName ? display.split(" ").length : 0,
  };
}
