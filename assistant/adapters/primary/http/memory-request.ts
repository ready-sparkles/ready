import type { FastifyReply, FastifyRequest } from "fastify";

const MEMORY_REQUEST_MESSAGES = {
  workerDisconnected: "Memory worker disconnected",
} as const;

// Cancel memory model work when its worker disconnects, including during deploys.
// Request 'close' also fires for normally consumed bodies, so watch the response.
export async function withMemoryRequestSignal<T>(input: {
  request: Pick<FastifyRequest, "raw">;
  reply: Pick<FastifyReply, "raw">;
  operation: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const controller = new AbortController();
  const cancel = () => {
    if (!input.reply.raw.writableFinished) {
      controller.abort(new Error(MEMORY_REQUEST_MESSAGES.workerDisconnected));
    }
  };
  input.reply.raw.once("close", cancel);
  if ((input.request.raw.destroyed && !input.request.raw.complete) || input.reply.raw.destroyed) {
    cancel();
  }
  try {
    controller.signal.throwIfAborted();

    return await input.operation(controller.signal);
  } finally {
    input.reply.raw.off("close", cancel);
  }
}
