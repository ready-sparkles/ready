import { createHash } from "node:crypto";

import { MeetingContentKeyConfigError } from "../../../domain/content-key-errors";

import { contentLookupMac } from "./content-key-config";

const FAILURE = "Meeting content lookup failed.";
type FingerprintService = (message: Uint8Array) => Promise<Uint8Array>;
const state: { override?: FingerprintService } = {};

/** Test preload only. Production ignores this override. */
export function setContentFingerprintServiceForTests(service: FingerprintService): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(FAILURE);
  }
  state.override = service;
}

export function resetContentFingerprintForTests(): void {
  state.override = undefined;
}

function fingerprintGenerator(): FingerprintService {
  if (process.env.NODE_ENV !== "production" && state.override !== undefined) {
    return state.override;
  }

  return async (message) => contentLookupMac(message);
}

export async function contentFingerprint(input: { domain: string; value: string }): Promise<string> {
  const { domain, value } = input;
  try {
    const message = createHash("sha256")
      .update(JSON.stringify(["readymeet", "meeting-content-lookup:v1", domain, value]))
      .digest();

    return Buffer.from(await fingerprintGenerator()(message)).toString("hex");
  } catch (error) {
    if (error instanceof MeetingContentKeyConfigError) {
      throw error;
    }
    throw new Error(FAILURE);
  }
}

export const lookupFields: Record<string, Record<string, string>> = {
  meetingAmbientContextItems: { canonicalKey: "canonicalKeyFingerprint", error: "errorFingerprint" },
  voiceWebResearchRuns: { queryKey: "queryKeyFingerprint", query: "queryFingerprint" },
  workspaceTaskSections: { title: "titleFingerprint" },
};
