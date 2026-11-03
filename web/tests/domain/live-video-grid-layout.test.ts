import assert from "node:assert/strict";
import test from "node:test";

import { getLiveVideoGridLayout } from "../../domain/live-video-grid-layout";

const TEST_VALUE_16 = 16;
const TEST_VALUE_9 = 9;
const GAP = 10.4;
const ASPECT_RATIO = TEST_VALUE_16 / TEST_VALUE_9;

function layoutFor(...args: [count: number, width: number, height: number]) {
  const [count, width, height] = args;
  const layout = getLiveVideoGridLayout({ count, width, height, gap: GAP, aspectRatio: ASPECT_RATIO });
  assert.ok(layout);

  return layout;
}

const TEST_VALUE_1440 = 1440;
const TEST_VALUE_1600 = 1600;
const TEST_VALUE_2 = 2;
const TEST_VALUE_3 = 3;
const TEST_VALUE_370 = 370;
const TEST_VALUE_390 = 390;
const TEST_VALUE_4 = 4;
const TEST_VALUE_400 = 400;
const TEST_VALUE_5 = 5;
const TEST_VALUE_520 = 520;
const TEST_VALUE_600 = 600;
const TEST_VALUE_650 = 650;
const TEST_VALUE_800 = 800;
void test("waits for a measured stage and at least one participant", () => {
  assert.equal(
    getLiveVideoGridLayout({
      count: 0,
      width: TEST_VALUE_1440,
      height: TEST_VALUE_800,
      gap: GAP,
      aspectRatio: ASPECT_RATIO,
    }),
    null,
  );
  assert.equal(
    getLiveVideoGridLayout({ count: TEST_VALUE_3, width: 0, height: 0, gap: GAP, aspectRatio: ASPECT_RATIO }),
    null,
  );
});

void test("three people on a desktop stage use two columns and center the third tile", () => {
  const layout = layoutFor(TEST_VALUE_3, TEST_VALUE_1440, TEST_VALUE_800);

  assert.equal(layout.columns, TEST_VALUE_2);
  assert.equal(layout.isLastTileCentered, true);
  const layoutTolerance = 0.001;
  assert.ok(Math.abs(layout.tileWidth - ((TEST_VALUE_800 - GAP) / TEST_VALUE_2) * ASPECT_RATIO) < layoutTolerance);
  assert.ok(Math.abs(layout.tileHeight - layout.tileWidth / ASPECT_RATIO) < layoutTolerance);
});

void test("three people on a portrait phone stage stack in one column at full width", () => {
  const layout = layoutFor(TEST_VALUE_3, TEST_VALUE_390, TEST_VALUE_650);

  assert.equal(layout.columns, 1);
  assert.equal(layout.isLastTileCentered, false);
  assert.ok(layout.tileWidth > TEST_VALUE_370, `expected a near full-width tile, got ${layout.tileWidth}`);
});

void test("three people on a wide, short stage sit in a single row", () => {
  const layout = layoutFor(TEST_VALUE_3, TEST_VALUE_1600, TEST_VALUE_400);

  assert.equal(layout.columns, TEST_VALUE_3);
  assert.equal(layout.isLastTileCentered, false);
  assert.ok(layout.tileWidth > TEST_VALUE_520, `expected row-sized tiles, got ${layout.tileWidth}`);
});

void test("only three-person layouts center the last tile", () => {
  [1, TEST_VALUE_2, TEST_VALUE_4, TEST_VALUE_5].forEach((count) => {
    assert.equal(layoutFor(count, TEST_VALUE_1440, TEST_VALUE_800).isLastTileCentered, false, `count ${count}`);
  });
});

void test("two people prefer side by side unless stacking is much larger", () => {
  assert.equal(layoutFor(TEST_VALUE_2, TEST_VALUE_1440, TEST_VALUE_800).columns, TEST_VALUE_2);
  assert.equal(layoutFor(TEST_VALUE_2, TEST_VALUE_390, TEST_VALUE_650).columns, 1);
});

void test("a solo participant fills the stage at the tile aspect ratio", () => {
  const layout = layoutFor(1, TEST_VALUE_1440, TEST_VALUE_600);

  assert.equal(layout.columns, 1);
  assert.equal(layout.tileWidth, TEST_VALUE_600 * ASPECT_RATIO);
});
