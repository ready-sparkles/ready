const TASK_UPDATE_CONCURRENCY = 4;

/** Stop queuing on failure, settle in-flight writes, and retain unconfirmed tasks for retry. */
export async function updateTaskSelection<T>(options: {
  tasks: T[];
  update: (task: T) => Promise<unknown>;
}): Promise<{ updated: T[]; remaining: T[] }> {
  const { tasks, update } = options;
  const pendingTasks = tasks.entries();
  const stopController = new AbortController();
  const confirmed = new Set<number>();
  const workerCount = Math.min(TASK_UPDATE_CONCURRENCY, tasks.length);

  // Each worker pulls the next unclaimed task, so a slow write never holds back the rest of the queue.
  const runWorker = async (): Promise<void> => {
    if (stopController.signal.aborted) {
      return;
    }
    const next = pendingTasks.next();
    if (next.done === true) {
      return;
    }
    const [index, task] = next.value;
    try {
      await update(task);
      confirmed.add(index);
    } catch (updateError) {
      void updateError;
      stopController.abort();
    }
    await runWorker();
  };

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  return {
    updated: tasks.filter((_, index) => confirmed.has(index)),
    remaining: tasks.filter((_, index) => !confirmed.has(index)),
  };
}
