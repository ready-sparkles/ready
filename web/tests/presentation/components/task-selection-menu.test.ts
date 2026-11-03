import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../../../presentation/styles/globals.css", import.meta.url), "utf8");
void test("selected-task options layer above the task list", () => {
  assert.match(css, /\.workspace-task-page-actions\s*\{[^}]*z-index:\s*40;/s);
  assert.match(css, /\.workspace-tasks-section\s*\{[^}]*z-index:\s*20;/s);
});
