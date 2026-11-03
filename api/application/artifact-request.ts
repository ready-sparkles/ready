import type { AiWorkflowJobType } from "@readymeet/shared";

import { repositories } from "../ports/repository-runtime";

const ARTIFACT_REQUEST_FAILED_MESSAGE = "Artifact request failed.";

/** Direct callers and workflow callers use the same persisted request identity. */
export async function recordArtifactRequest<T>(input: {
  meetingId: string;
  type: AiWorkflowJobType;
  run: (jobId: string) => Promise<T>;
}): Promise<T> {
  const job = await repositories().startAiWorkflowExecution(input);
  try {
    const result = await input.run(job.id);
    await repositories().completeAiWorkflowJob({ jobId: job.id });

    return result;
  } catch (error) {
    await repositories().failAiWorkflowJob({ jobId: job.id, error: ARTIFACT_REQUEST_FAILED_MESSAGE });
    throw error;
  }
}
