import { createRequestWorkflow, runAiWorkflowInRequest } from "./run-ai-work";

const LIVE_WORK_FAILED_MESSAGE = "Live AI work failed after transcript acknowledgement";
type WorkInput = Parameters<typeof runAiWorkflowInRequest>[0];

/** Live analysis must not hold transcript persistence or meeting finalization open. */
export function createLiveAiWorkRunner(deps = { create: createRequestWorkflow, run: runAiWorkflowInRequest }): {
  start: (input: WorkInput) => Promise<void>;
  drain: () => Promise<void>;
} {
  // shortcut: process exit can interrupt accepted work; add durable replay if restart recovery is required.
  const pending = new Set<Promise<void>>();
  async function start(input: WorkInput): Promise<void> {
    const job = await deps.create(input);
    const work = run({ ...input, job });
    pending.add(work);
    void removeWhenFinished(work);
  }
  async function run(input: WorkInput): Promise<void> {
    try {
      await deps.run(input);
    } catch (error) {
      // The workflow records failure; do not log provider responses or speech.
      input.logger.warn(
        { meetingId: input.meetingId, type: input.type, errorType: typeof error },
        LIVE_WORK_FAILED_MESSAGE,
      );
    }
  }
  async function removeWhenFinished(work: Promise<void>): Promise<void> {
    try {
      await work;
    } finally {
      pending.delete(work);
    }
  }
  async function drain(): Promise<void> {
    await Promise.all(pending);
  }

  return { start, drain };
}
