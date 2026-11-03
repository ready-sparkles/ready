import assert from "node:assert/strict";
import test from "node:test";

import { pool, setDbPoolErrorHandler } from "../../../../adapters/secondary/postgres/client";

const MESSAGE_CONNECTION_TERMINATED_UNEXPECTEDLY = "Connection terminated unexpectedly";

void test("reports an idle client error without leaving the attached client on the error", () => {
  const failure = Object.assign(new Error(MESSAGE_CONNECTION_TERMINATED_UNEXPECTEDLY), {
    client: { connectionParameters: { user: "postgres" } },
  });
  const reportedState = { reported: [] as Error[] };

  setDbPoolErrorHandler((error) => {
    reportedState.reported = [...reportedState.reported, error];
  });

  assert.doesNotThrow(() => {
    pool.emit("error", failure);
  });
  assert.deepEqual(reportedState.reported, [failure]);
  assert.equal("client" in failure, false);
});
