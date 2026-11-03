import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  canStartTaskPaintPointer,
  isPointWithinTaskPaintSelectionBounds,
  shouldSuppressClickAfterTaskPaint,
  taskPaintActivationDistance,
  taskPaintGestureIntent,
  taskPaintStartBounds,
} from "../../../presentation/components/use-task-paint-selection";

const css = readFileSync(new URL("../../../presentation/styles/globals.css", import.meta.url), "utf8");

const ROOT_BOUNDS_LEFT = 550;
const ROOT_BOUNDS_RIGHT = 1450;
const ROOT_BOUNDS_TOP = 80;
const ROOT_BOUNDS_BOTTOM = 600;

const CONTENT_BOUNDS_LEFT = 268;
const CONTENT_BOUNDS_RIGHT = 1720;
const CONTENT_BOUNDS_TOP = 0;
const CONTENT_BOUNDS_BOTTOM = 900;

const INSIDE_POINT_X = 300;
const INSIDE_POINT_Y = 300;
const LEFT_OUTSIDE_POINT_X = 267;
const RIGHT_OUTSIDE_POINT_X = 1721;
const TOP_OUTSIDE_POINT_Y = 79;
const BOTTOM_OUTSIDE_POINT_Y = 601;

const NON_PRIMARY_MOUSE_BUTTON = 2;

const MOUSE_ACTIVATION_DISTANCE = 6;
const TOUCH_ACTIVATION_DISTANCE = 10;
const PEN_ACTIVATION_DISTANCE = 10;

const TOUCH_PENDING_DELTA_X = 5;
const TOUCH_PENDING_DELTA_Y = 4;
const TOUCH_PAN_DELTA_X = 4;
const TOUCH_PAN_DELTA_Y = 12;
const TOUCH_PAINT_DELTA_X = 12;
const TOUCH_PAINT_DELTA_Y = 4;
const MOUSE_PAINT_DELTA_Y = 7;
const PEN_PAINT_DELTA_Y = 11;

void test("paint selection spans the content panel but keeps the task list vertical bounds", () => {
  const rootBounds = {
    left: ROOT_BOUNDS_LEFT,
    right: ROOT_BOUNDS_RIGHT,
    top: ROOT_BOUNDS_TOP,
    bottom: ROOT_BOUNDS_BOTTOM,
  };
  const contentBounds = {
    left: CONTENT_BOUNDS_LEFT,
    right: CONTENT_BOUNDS_RIGHT,
    top: CONTENT_BOUNDS_TOP,
    bottom: CONTENT_BOUNDS_BOTTOM,
  };
  const bounds = taskPaintStartBounds(rootBounds, contentBounds);

  assert.equal(isPointWithinTaskPaintSelectionBounds({ x: INSIDE_POINT_X, y: INSIDE_POINT_Y }, bounds), true);
  assert.equal(isPointWithinTaskPaintSelectionBounds({ x: LEFT_OUTSIDE_POINT_X, y: INSIDE_POINT_Y }, bounds), false);
  assert.equal(isPointWithinTaskPaintSelectionBounds({ x: RIGHT_OUTSIDE_POINT_X, y: INSIDE_POINT_Y }, bounds), false);
  assert.equal(isPointWithinTaskPaintSelectionBounds({ x: INSIDE_POINT_X, y: TOP_OUTSIDE_POINT_Y }, bounds), false);
  assert.equal(isPointWithinTaskPaintSelectionBounds({ x: INSIDE_POINT_X, y: BOTTOM_OUTSIDE_POINT_Y }, bounds), false);
});

void test("paint selection accepts primary mouse, touch, and pen input", () => {
  ["mouse", "touch", "pen"].forEach((pointerType) => {
    assert.equal(canStartTaskPaintPointer({ pointerType, button: 0, isPrimary: true }), true, pointerType);
  });
  assert.equal(canStartTaskPaintPointer({ pointerType: "touch", button: 0, isPrimary: false }), false);
  assert.equal(
    canStartTaskPaintPointer({ pointerType: "mouse", button: NON_PRIMARY_MOUSE_BUTTON, isPrimary: true }),
    false,
  );
  assert.equal(canStartTaskPaintPointer({ pointerType: "unknown", button: 0, isPrimary: true }), false);
});

void test("cancelled paint gestures do not swallow the next click", () => {
  assert.equal(shouldSuppressClickAfterTaskPaint(true, false), true);
  assert.equal(shouldSuppressClickAfterTaskPaint(true, true), false);
  assert.equal(shouldSuppressClickAfterTaskPaint(false, true), false);
});

void test("touch and pen require more movement before paint selection activates", () => {
  assert.equal(taskPaintActivationDistance("mouse"), MOUSE_ACTIVATION_DISTANCE);
  assert.equal(taskPaintActivationDistance("touch"), TOUCH_ACTIVATION_DISTANCE);
  assert.equal(taskPaintActivationDistance("pen"), PEN_ACTIVATION_DISTANCE);
});

void test("touch intent preserves vertical panning and reserves horizontal motion for painting", () => {
  assert.match(css, /\.workspace-content\.workspace-content-tasks\s*\{[^}]*touch-action:\s*pan-y pinch-zoom;/s);
  assert.equal(taskPaintGestureIntent("touch", TOUCH_PENDING_DELTA_X, TOUCH_PENDING_DELTA_Y), "pending");
  assert.equal(taskPaintGestureIntent("touch", TOUCH_PAN_DELTA_X, TOUCH_PAN_DELTA_Y), "pan");
  assert.equal(taskPaintGestureIntent("touch", TOUCH_PAINT_DELTA_X, TOUCH_PAINT_DELTA_Y), "paint");
  assert.equal(taskPaintGestureIntent("mouse", 0, MOUSE_PAINT_DELTA_Y), "paint");
  assert.equal(taskPaintGestureIntent("pen", 0, PEN_PAINT_DELTA_Y), "paint");
});
