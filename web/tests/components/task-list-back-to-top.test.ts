import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../../presentation/styles/globals.css", import.meta.url), "utf8");

void test("task list uses Highlight width centered in the ReadyMeet content panel", () => {
  assert.match(
    css,
    /\.workspace-content\.workspace-content-tasks\s*\{[^}]*width:\s*calc\(100% - var\(--workspace-rail-gutter\)\);[^}]*margin-left:\s*var\(--workspace-rail-gutter\);[^}]*justify-self:\s*stretch;[^}]*padding:\s*0 32px 48px;/s,
  );
  assert.match(
    css,
    /\.workspace-content-tasks \.workspace-task-page\s*\{[^}]*width:\s*min\(100%, calc\(760px \+ 0\.42rem \+ 128px\)\);[^}]*margin:\s*74px auto 0;/s,
  );
  assert.match(
    css,
    /\.workspace-content-tasks \.workspace-task-list\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*margin-left:\s*0;/s,
  );
});

void test("task rows use Highlight hover and active surfaces", () => {
  assert.match(css, /--task-active-background:\s*color-mix\(in srgb, var\(--ready-blue\) 8%, var\(--app-canvas\)\);/);
  assert.match(css, /--task-hover-background:\s*color-mix\(in srgb, var\(--ready-blue\) 6%, var\(--app-canvas\)\);/);
  assert.match(
    css,
    /\.workspace-content-tasks \.workspace-task-row::before\s*\{[^}]*background:\s*var\(--task-hover-background\);/s,
  );
  assert.match(
    css,
    /\.workspace-content-tasks \.workspace-task-row:is\(\.is-active, \.is-selected\)::before\s*\{[^}]*background:\s*var\(--task-active-background\);/s,
  );
  assert.match(
    css,
    /@media \(hover: hover\) and \(pointer: fine\)\s*\{[\s\S]*?\.workspace-content-tasks \.workspace-task-row:hover::before\s*\{[^}]*opacity:\s*1;/s,
  );
});
