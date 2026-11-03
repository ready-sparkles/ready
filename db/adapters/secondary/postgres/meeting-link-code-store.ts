import type { MeetingLinkCodeStore } from "../../../ports/meeting-link-code-store";

import { getMeetingByRoomName, getMeetingLinkByCode } from "./repositories";

export const meetingLinkCodeStore: MeetingLinkCodeStore = {
  getMeetingByRoomName,
  getMeetingLinkByCode,
};
