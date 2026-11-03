export type MeetingLinkCodeStore = {
  getMeetingLinkByCode: (code: string) => Promise<unknown>;
  getMeetingByRoomName: (roomName: string) => Promise<unknown>;
};
