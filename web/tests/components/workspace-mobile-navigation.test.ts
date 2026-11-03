import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../../presentation/styles/globals.css", import.meta.url), "utf8");
void test("mobile workspace menu trigger stays backgroundless in every interaction state", () => {
  assert.match(
    css,
    /\.workspace-mobile-menu-trigger:hover,\s*\.workspace-mobile-menu-trigger\.is-open\s*{[^}]*background:\s*transparent;/s,
  );
  assert.match(css, /\.workspace-mobile-menu-trigger:active\s*{[^}]*background:\s*transparent;/s);
  assert.match(css, /\.workspace-mobile-menu-trigger:focus-visible\s*{[^}]*background:\s*transparent;/s);
  assert.match(css, /\.workspace-mobile-menu-trigger\s*{[^}]*-webkit-tap-highlight-color:\s*transparent;/s);
  assert.doesNotMatch(
    css,
    /@media \(max-width: 1000px\) and \(hover: hover\) and \(pointer: fine\)\s*{\s*\.workspace-mobile-menu-trigger:hover/s,
  );
});

void test("desktop controls stay compact while mobile New meeting uses a larger touch target", () => {
  assert.match(css, /\.workspace-layout\s*{[^}]*--workspace-toolbar-control-height:\s*36px;/s);
  assert.match(css, /\.workspace-account-menu\s*{[^}]*top:\s*3px;[^}]*margin-left:\s*-10px;/s);
  assert.match(
    css,
    /\.workspace-account-trigger\s*{[^}]*width:\s*61\.1875px;[^}]*height:\s*var\(--workspace-toolbar-control-height\);[^}]*min-height:\s*var\(--workspace-toolbar-control-height\);[^}]*padding:\s*0 7px 0 4\.5px;[^}]*gap:\s*7\.5px;/s,
  );
  assert.match(css, /\.workspace-account-avatar\s*{[^}]*width:\s*27px;[^}]*height:\s*27px;/s);
  assert.match(
    css,
    /\.workspace-mobile-new-meeting-button\s*{[^}]*height:\s*44px;[^}]*min-height:\s*44px;[^}]*padding:\s*0 16px;/s,
  );
  assert.match(
    css,
    /\.workspace-mobile-new-meeting-button \.workspace-nav-icon\s*{[^}]*width:\s*24px;[^}]*height:\s*24px;/s,
  );
  assert.match(
    css,
    /\.workspace-new-meeting-button\s*{[^}]*height:\s*var\(--workspace-toolbar-control-height\);[^}]*min-height:\s*var\(--workspace-toolbar-control-height\);/s,
  );
});
