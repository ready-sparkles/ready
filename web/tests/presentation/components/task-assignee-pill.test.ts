import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  calculateTaskAssigneeMenuPosition,
  mergeTaskAssigneeParticipants,
  trackTaskAssigneeMenuPosition,
} from "../../../presentation/components/task-assignee-pill";

const DESKTOP_MENU_WIDTH = 224;
const DESKTOP_MENU_HEIGHT = 200;
const DESKTOP_VIEWPORT_WIDTH = 800;
const DESKTOP_VIEWPORT_HEIGHT = 600;

const ANCHOR_TOP_BELOW_TRIGGER = 70;
const ANCHOR_LEFT_WIDE = 400;
const ANCHOR_RIGHT_WIDE = 500;
const ANCHOR_BOTTOM_STANDARD = 100;

const EXPECTED_MENU_TOP_BELOW_TRIGGER = 106;
const EXPECTED_MENU_LEFT_ALIGN_END = 276;

const ANCHOR_LEFT_NEAR_EDGE = 20;
const ANCHOR_RIGHT_NEAR_EDGE = 100;
const EXPECTED_MENU_LEFT_VIEWPORT_GUTTER = 8;

const ANCHOR_TOP_NEAR_BOTTOM = 520;
const ANCHOR_BOTTOM_NEAR_BOTTOM = 550;
const EXPECTED_MENU_TOP_ABOVE_TRIGGER = 314;

const MOBILE_ANCHOR_TOP = 100;
const MOBILE_ANCHOR_LEFT_START = 56;
const MOBILE_ANCHOR_RIGHT_START = 180;
const MOBILE_ANCHOR_BOTTOM = 132;
const MOBILE_MENU_WIDTH = 280;
const MOBILE_MENU_HEIGHT = 160;
const MOBILE_VIEWPORT_WIDTH = 390;
const MOBILE_VIEWPORT_HEIGHT = 844;
const EXPECTED_MOBILE_MENU_TOP = 138;
const EXPECTED_MOBILE_MENU_LEFT_START = 56;
const MOBILE_ANCHOR_LEFT_CLAMPED = 300;
const MOBILE_ANCHOR_RIGHT_CLAMPED = 332;
const EXPECTED_MOBILE_MENU_LEFT_CLAMPED = 102;

const FIRST_FRAME_TIMESTAMP_MS = 16;
const SECOND_FRAME_TIMESTAMP_MS = 32;
const EXPECTED_MEASURE_COUNT_AFTER_FIRST_FRAME = 2;
const EXPECTED_MEASURE_COUNT_AFTER_SECOND_FRAME = 3;
const SECOND_FRAME_ID = 2;
const THIRD_FRAME_ID = 3;

void test("assignee menu width stays inside narrow viewport gutters", () => {
  const css = readFileSync(new URL("../../../presentation/styles/globals.css", import.meta.url), "utf8");
  const menuRule = css.match(/\.task-assignee-menu\s*\{([^}]*)\}/)?.[1];

  assert.notEqual(menuRule, undefined);
  assert.ok(menuRule !== undefined);
  assert.match(menuRule, /min-width:\s*min\(14rem, calc\(100vw - 1rem\)\)/);
  assert.match(menuRule, /max-width:\s*min\(18rem, calc\(100vw - 1rem\)\)/);
});

void test("assignee options list meeting participants first and add workspace members", () => {
  const options = mergeTaskAssigneeParticipants(
    [
      {
        userId: "meeting-user",
        displayName: "Meeting Name",
        email: null,
        avatarUrl: null,
      },
    ],
    [
      {
        userId: "meeting-user",
        displayName: "Workspace Name",
        email: "meeting@example.com",
        avatarUrl: "https://example.com/avatar.png",
      },
      {
        userId: "workspace-user",
        displayName: "Workspace Only",
        email: "workspace@example.com",
        avatarUrl: null,
      },
    ],
  );

  assert.deepEqual(options, [
    {
      userId: "meeting-user",
      displayName: "Meeting Name",
      email: "meeting@example.com",
      avatarUrl: "https://example.com/avatar.png",
    },
    {
      userId: "workspace-user",
      displayName: "Workspace Only",
      email: "workspace@example.com",
      avatarUrl: null,
    },
  ]);
});

void test("assignee menu aligns below the trigger and stays inside the viewport", () => {
  assert.deepEqual(
    calculateTaskAssigneeMenuPosition({
      anchor: {
        top: ANCHOR_TOP_BELOW_TRIGGER,
        left: ANCHOR_LEFT_WIDE,
        right: ANCHOR_RIGHT_WIDE,
        bottom: ANCHOR_BOTTOM_STANDARD,
      },
      menuWidth: DESKTOP_MENU_WIDTH,
      menuHeight: DESKTOP_MENU_HEIGHT,
      viewportWidth: DESKTOP_VIEWPORT_WIDTH,
      viewportHeight: DESKTOP_VIEWPORT_HEIGHT,
    }),
    {
      top: EXPECTED_MENU_TOP_BELOW_TRIGGER,
      left: EXPECTED_MENU_LEFT_ALIGN_END,
    },
  );

  assert.deepEqual(
    calculateTaskAssigneeMenuPosition({
      anchor: {
        top: ANCHOR_TOP_BELOW_TRIGGER,
        left: ANCHOR_LEFT_NEAR_EDGE,
        right: ANCHOR_RIGHT_NEAR_EDGE,
        bottom: ANCHOR_BOTTOM_STANDARD,
      },
      menuWidth: DESKTOP_MENU_WIDTH,
      menuHeight: DESKTOP_MENU_HEIGHT,
      viewportWidth: DESKTOP_VIEWPORT_WIDTH,
      viewportHeight: DESKTOP_VIEWPORT_HEIGHT,
    }),
    {
      top: EXPECTED_MENU_TOP_BELOW_TRIGGER,
      left: EXPECTED_MENU_LEFT_VIEWPORT_GUTTER,
    },
  );
});

void test("assignee menu opens above the trigger when there is not enough room below", () => {
  assert.deepEqual(
    calculateTaskAssigneeMenuPosition({
      anchor: {
        top: ANCHOR_TOP_NEAR_BOTTOM,
        left: ANCHOR_LEFT_WIDE,
        right: ANCHOR_RIGHT_WIDE,
        bottom: ANCHOR_BOTTOM_NEAR_BOTTOM,
      },
      menuWidth: DESKTOP_MENU_WIDTH,
      menuHeight: DESKTOP_MENU_HEIGHT,
      viewportWidth: DESKTOP_VIEWPORT_WIDTH,
      viewportHeight: DESKTOP_VIEWPORT_HEIGHT,
    }),
    {
      top: EXPECTED_MENU_TOP_ABOVE_TRIGGER,
      left: EXPECTED_MENU_LEFT_ALIGN_END,
    },
  );
});

void test("mobile assignee menu aligns to the pill left edge and clamps near the screen edge", () => {
  const input = {
    anchor: {
      top: MOBILE_ANCHOR_TOP,
      left: MOBILE_ANCHOR_LEFT_START,
      right: MOBILE_ANCHOR_RIGHT_START,
      bottom: MOBILE_ANCHOR_BOTTOM,
    },
    align: "start" as const,
    menuWidth: MOBILE_MENU_WIDTH,
    menuHeight: MOBILE_MENU_HEIGHT,
    viewportWidth: MOBILE_VIEWPORT_WIDTH,
    viewportHeight: MOBILE_VIEWPORT_HEIGHT,
  };
  assert.deepEqual(calculateTaskAssigneeMenuPosition(input), {
    top: EXPECTED_MOBILE_MENU_TOP,
    left: EXPECTED_MOBILE_MENU_LEFT_START,
  });
  assert.deepEqual(
    calculateTaskAssigneeMenuPosition({
      ...input,
      anchor: { ...input.anchor, left: MOBILE_ANCHOR_LEFT_CLAMPED, right: MOBILE_ANCHOR_RIGHT_CLAMPED },
    }),
    { top: EXPECTED_MOBILE_MENU_TOP, left: EXPECTED_MOBILE_MENU_LEFT_CLAMPED },
  );
});

void test("assignee menu keeps measuring while its animated trigger is moving", () => {
  const tracking = { measureCount: 0, nextFrameId: 0 };
  const callbacks = new Map<number, FrameRequestCallback>();
  const cancelledFrameIdsHolder: { frameIds: number[] } = { frameIds: [] };
  const stopTracking = trackTaskAssigneeMenuPosition({
    measure: () => {
      tracking.measureCount += 1;
    },
    requestFrame: (callback) => {
      tracking.nextFrameId += 1;
      callbacks.set(tracking.nextFrameId, callback);

      return tracking.nextFrameId;
    },
    cancelFrame: (frameId) => {
      cancelledFrameIdsHolder.frameIds = [...cancelledFrameIdsHolder.frameIds, frameId];
      callbacks.delete(frameId);
    },
  });

  assert.equal(tracking.measureCount, 1);
  assert.equal(callbacks.size, 1);

  const firstFrame = callbacks.get(1);
  callbacks.delete(1);
  firstFrame?.(FIRST_FRAME_TIMESTAMP_MS);
  assert.equal(tracking.measureCount, EXPECTED_MEASURE_COUNT_AFTER_FIRST_FRAME);
  assert.equal(callbacks.size, 1);

  const secondFrame = callbacks.get(SECOND_FRAME_ID);
  callbacks.delete(SECOND_FRAME_ID);
  secondFrame?.(SECOND_FRAME_TIMESTAMP_MS);
  assert.equal(tracking.measureCount, EXPECTED_MEASURE_COUNT_AFTER_SECOND_FRAME);
  assert.equal(callbacks.size, 1);

  stopTracking();
  assert.deepEqual(cancelledFrameIdsHolder.frameIds, [THIRD_FRAME_ID]);
  assert.equal(callbacks.size, 0);
});
