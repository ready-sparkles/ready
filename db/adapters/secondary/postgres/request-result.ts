import { REQUEST_EXECUTION_MAX_AGE_MS, RequestExecutionExpiredError } from "../../../domain/request-execution";

import type { AccountTransaction } from "./account-coordination";
import { db } from "./client";

/** Database work only: never hold this transaction across a model or provider call. */
export async function withRequestMutation<T>(input: {
  meetingId: string;
  run: (executor: AccountTransaction) => Promise<T>;
}): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT id
      FROM meetings
      WHERE id = ${input.meetingId}::uuid
      FOR UPDATE
    `;

    return input.run(tx);
  });
}

export async function withRequestResult<T>(input: {
  meetingId: string;
  jobId?: string | null;
  run: (executor: typeof db | AccountTransaction) => Promise<T>;
}): Promise<T> {
  if (input.jobId === undefined || input.jobId === null) {
    return input.run(db);
  }

  const jobId = input.jobId;

  return withRequestMutation({
    meetingId: input.meetingId,
    run: async (tx) => {
      const jobs = await tx.$queryRaw<{ status: string; startedAt: Date }[]>`
        SELECT status, started_at AS "startedAt"
        FROM ai_workflow_executions
        WHERE id = ${jobId}::uuid
          AND meeting_id = ${input.meetingId}::uuid
        FOR UPDATE
      `;
      const job = jobs[0];
      if (
        job === undefined ||
        job.status !== "running" ||
        job.startedAt.getTime() <= Date.now() - REQUEST_EXECUTION_MAX_AGE_MS
      ) {
        throw new RequestExecutionExpiredError();
      }

      return input.run(tx);
    },
  });
}
