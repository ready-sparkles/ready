import { getValidatedCapabilityCatalogSeed } from "../../../domain/capability-catalog-seed";

import { pool } from "./client";
import { appendTranscriptSegment, createMeeting, upsertCapability, upsertUser } from "./repositories";

export async function seedDemo(): Promise<void> {
  const capabilities = getValidatedCapabilityCatalogSeed();

  await capabilities.reduce<Promise<void>>(async (previous, capability) => {
    await previous;
    await upsertCapability(capability);
  }, Promise.resolve());

  const user = await upsertUser({
    email: "demo@readymeet.local",
    displayName: "Demo User",
  });

  const meeting = await createMeeting({
    title: "Weekly Product Standup",
    roomName: `weekly-product-standup-${Date.now()}`,
    createdByUserId: user.id,
  });

  await appendTranscriptSegment({
    meetingId: meeting.id,
    speakerIdentity: user.id,
    speakerName: user.displayName,
    speakerUserId: user.id,
    speakerRole: "human",
    source: "manual-note",
    content: "Kickoff: shipped room creation and token minting.",
    startedAt: new Date(),
  });

  await pool.end();
}
