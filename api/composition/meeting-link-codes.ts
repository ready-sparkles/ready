import { meetingLinkCodeStore } from "@readymeet/db";

import {
  generateUniqueMeetingLinkCode as generateUniqueMeetingLinkCodeWithStore,
  normalizeMeetingLinkCode,
} from "../application/meeting-link-codes";

export { normalizeMeetingLinkCode };

export async function generateUniqueMeetingLinkCode(): Promise<string> {
  return generateUniqueMeetingLinkCodeWithStore({ store: meetingLinkCodeStore });
}
