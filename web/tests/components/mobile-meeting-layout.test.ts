import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../../presentation/styles/globals.css", import.meta.url), "utf8");
const mobileMeetingCss = css.slice(css.lastIndexOf("@media (max-width: 1000px) {"));
void test("mobile meeting controls respect narrow screens and safe areas", () => {
  const mobileControlsRule = mobileMeetingCss.match(/\.live-controls-bar\s*\{([\s\S]*?)\}/)?.[1];

  assert.ok(mobileControlsRule !== undefined);
  assert.match(mobileControlsRule, /env\(safe-area-inset-left\)/);
  assert.match(mobileControlsRule, /env\(safe-area-inset-right\)/);
  assert.match(mobileControlsRule, /bottom:\s*calc\(0\.65rem \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(mobileControlsRule, /gap:\s*clamp\(0\.4rem, 2\.25vw, 0\.6rem\)/);

  assert.match(
    mobileMeetingCss,
    /\.live-controls-bar button\s*\{[\s\S]*?width:\s*clamp\(2\.75rem, 13vw, 3\.15rem\);[\s\S]*?height:\s*clamp\(2\.75rem, 13vw, 3\.15rem\);/,
  );
});

void test("mobile meeting and prejoin videos preserve the full camera frame", () => {
  assert.match(
    mobileMeetingCss,
    /\.live-grid-video-tile video\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?object-fit:\s*contain;[\s\S]*?object-position:\s*center;/,
  );
  assert.match(
    css,
    /@media \(max-width: 860px\)[\s\S]*?\.meeting-join-video,[\s\S]*?\.meeting-join-waiting-video\s*\{[\s\S]*?object-fit:\s*contain;/,
  );
});

void test("narrow mobile call bar stays centered as voice controls collapse", () => {
  const narrowCss = css.slice(css.lastIndexOf("@media (max-width: 600px) {"));
  const controls = narrowCss.match(/\.live-controls-bar\s*\{([^}]+)\}/)?.[1];
  assert.ok(controls !== undefined && controls.length > 0);
  assert.match(controls, /left:\s*50%;/);
  assert.match(controls, /transform:\s*translateX\(-50%\);/);
});
