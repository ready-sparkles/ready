import assert from "node:assert/strict";
import test from "node:test";

import { suggestedActionsTestInternals } from "../../application/suggested-actions";

void test("suggested action run guard reuses terminal non-failed runs", () => {
  assert.equal(suggestedActionsTestInternals.shouldReturnExistingSuggestedActionRun("completed"), true);
  assert.equal(suggestedActionsTestInternals.shouldReturnExistingSuggestedActionRun("no_work_found"), true);
  assert.equal(suggestedActionsTestInternals.shouldReturnExistingSuggestedActionRun("skipped"), true);
  assert.equal(suggestedActionsTestInternals.shouldReturnExistingSuggestedActionRun("cancelled"), true);
});

void test("suggested action run guard allows pending, running, and failed runs to continue", () => {
  assert.equal(suggestedActionsTestInternals.shouldReturnExistingSuggestedActionRun("pending"), false);
  assert.equal(suggestedActionsTestInternals.shouldReturnExistingSuggestedActionRun("running"), false);
  assert.equal(suggestedActionsTestInternals.shouldReturnExistingSuggestedActionRun("failed"), false);
});
