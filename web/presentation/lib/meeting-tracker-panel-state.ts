import type { MeetingTrackerState } from "@readymeet/shared";

export function meetingTrackerPanelVisibility(input: {
  state: Pick<MeetingTrackerState, "status"> | null;
  hasJoinedMeeting: boolean;
  isTrackerOpen: boolean;
  shouldShowLiveMeetingChrome: boolean;
  isAvatarRevealed: boolean;
}): { isOpen: boolean; isTriggerVisible: boolean } {
  return {
    isOpen: input.hasJoinedMeeting && input.isTrackerOpen && input.state !== null,
    isTriggerVisible: Boolean(
      input.shouldShowLiveMeetingChrome &&
      input.isAvatarRevealed &&
      input.state &&
      input.state.status !== "unavailable",
    ),
  };
}

export type RoomPanelOpenState = {
  isPresencePanelOpen: boolean;
  isToolApprovalPanelOpen: boolean;
  isLinearActionPanelOpen: boolean;
  isMeetingDetailsPanelOpen: boolean;
  isMeetingSettingsPanelOpen: boolean;
  isJoinRequestsOpen: boolean;
  isAmbientContextPanelOpen: boolean;
};

function isAnyOtherRoomPanelOpen(state: RoomPanelOpenState): boolean {
  return Object.values(state).some(Boolean);
}

/** Summary is exclusive: any other room panel opening dismisses it, and it stays dismissed afterwards. */
export function shouldDismissMeetingTracker(input: { isTrackerOpen: boolean; panels: RoomPanelOpenState }): boolean {
  return input.isTrackerOpen && isAnyOtherRoomPanelOpen(input.panels);
}
