export type RealtimeEvent = {
  channel: string;
  eventName: string;
  payload: Record<string, unknown>;
};

const UNCONFIGURED_REALTIME_PUBLISHER_MESSAGE = "Realtime publisher is not configured";

const runtime: { publish?: (event: RealtimeEvent) => Promise<void> } = {};

/** The composition root supplies network delivery; repositories never queue it. */
export function configureRealtimePublisher(publish: (event: RealtimeEvent) => Promise<void>): void {
  runtime.publish = publish;
}

export async function publishRealtimeEvents(events: readonly RealtimeEvent[]): Promise<void> {
  if (events.length === 0) {
    return;
  }
  const publish = runtime.publish;
  if (publish === undefined) {
    throw new Error(UNCONFIGURED_REALTIME_PUBLISHER_MESSAGE);
  }
  await events.reduce(async (pending, event) => {
    await pending;
    await publish(event);
  }, Promise.resolve());
}
