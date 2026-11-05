export type WorkerOperation = { intervalMs: number; name: string; run: () => Promise<unknown>; timeoutMs: number };
export type WorkerObserver = { error: (fields: Record<string, unknown>) => void; info: (fields: Record<string, unknown>) => void };

function withTimeout(operation: Promise<unknown>, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WORKER_OPERATION_TIMEOUT")), timeoutMs);
    void operation.then(() => resolve(), reject).finally(() => clearTimeout(timer));
  });
}

export function startWorkerLoops(operations: WorkerOperation[], observer: WorkerObserver) {
  let stopped = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const active = new Set<Promise<void>>();

  const schedule = (operation: WorkerOperation, delay: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (stopped) return;
      const startedAt = Date.now();
      observer.info({ event: "worker.operation.started", operation: operation.name });
      const run = withTimeout(operation.run(), operation.timeoutMs)
        .then(() => observer.info({ event: "worker.operation.succeeded", durationMs: Date.now() - startedAt, operation: operation.name }))
        .catch((error) => observer.error({ event: "worker.operation.failed", durationMs: Date.now() - startedAt, errorCode: error instanceof Error ? error.message : "WORKER_OPERATION_FAILED", operation: operation.name }))
        .finally(() => {
          active.delete(run);
          if (!stopped) schedule(operation, operation.intervalMs);
        });
      active.add(run);
    }, delay);
    timers.add(timer);
  };

  for (const operation of operations) schedule(operation, 0);
  return async () => {
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    await Promise.allSettled(active);
  };
}
