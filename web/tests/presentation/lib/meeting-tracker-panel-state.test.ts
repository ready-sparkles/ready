import assert from "node:assert/strict";
import test from "node:test";

import {
  meetingTrackerPanelVisibility,
  type RoomPanelOpenState,
  shouldDismissMeetingTracker,
} from "../../../presentation/lib/meeting-tracker-panel-state";

const VISIBLE_TRACKER = {
  hasJoinedMeeting: true,
  isTrackerOpen: true,
  shouldShowLiveMeetingChrome: true,
  isAvatarRevealed: true,
};

void test("idle, failed and recovered summaries keep their open panel and trigger", () => {
  (["idle", "failed", "idle"] as const).forEach((status) => {
    assert.deepEqual(meetingTrackerPanelVisibility({ ...VISIBLE_TRACKER, state: { status } }), {
      isOpen: true,
      isTriggerVisible: true,
    });
  });
});

void test("missing data and denied access hide the panel and trigger", () => {
  assert.deepEqual(meetingTrackerPanelVisibility({ ...VISIBLE_TRACKER, state: null }), {
    isOpen: false,
    isTriggerVisible: false,
  });
});

void test("unavailable tracking stays untriggerable and call/chrome boundaries remain", () => {
  const available = { ...VISIBLE_TRACKER, state: { status: "failed" as const } };
  assert.equal(meetingTrackerPanelVisibility({ ...available, hasJoinedMeeting: false }).isOpen, false);
  assert.equal(meetingTrackerPanelVisibility({ ...available, isTrackerOpen: false }).isOpen, false);
  assert.equal(
    meetingTrackerPanelVisibility({ ...available, shouldShowLiveMeetingChrome: false }).isTriggerVisible,
    false,
  );
  assert.equal(meetingTrackerPanelVisibility({ ...available, isAvatarRevealed: false }).isTriggerVisible, false);
  assert.equal(
    meetingTrackerPanelVisibility({ ...available, state: { status: "unavailable" } }).isTriggerVisible,
    false,
  );
});

const CLOSED: RoomPanelOpenState = {
  isPresencePanelOpen: false,
  isToolApprovalPanelOpen: false,
  isLinearActionPanelOpen: false,
  isMeetingDetailsPanelOpen: false,
  isMeetingSettingsPanelOpen: false,
  isJoinRequestsOpen: false,
  isAmbientContextPanelOpen: false,
};

void test("Summary stays open while no other room panel is open", () => {
  assert.equal(shouldDismissMeetingTracker({ isTrackerOpen: true, panels: CLOSED }), false);
});

void test("any other room panel opening dismisses Summary, including person memory and the waiting room", () => {
  Object.keys(CLOSED).forEach((key) => {
    assert.equal(shouldDismissMeetingTracker({ isTrackerOpen: true, panels: { ...CLOSED, [key]: true } }), true, key);
  });
});

void test("a closed Summary is never re-dismissed", () => {
  assert.equal(
    shouldDismissMeetingTracker({ isTrackerOpen: false, panels: { ...CLOSED, isPresencePanelOpen: true } }),
    false,
  );
});
