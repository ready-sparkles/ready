import assert from "node:assert/strict";
import test from "node:test";

import { aiCreditActionTypeSchema } from "../domain/credit-usage";

void test("AI credit action schema includes meeting prep research", () => {
  assert.equal(aiCreditActionTypeSchema.parse("meeting_prep"), "meeting_prep");
});
