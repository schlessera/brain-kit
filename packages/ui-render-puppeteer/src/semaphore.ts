/** Minimal FIFO semaphore with a bounded, expiring wait queue. */
export class Semaphore {
  private queue: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  private available: number;
  private readonly maxQueue: number;
  private closed = false;

  constructor(slots: number, maxQueue = Infinity) {
    if (!Number.isInteger(slots) || slots < 1) throw new Error("maxConcurrent must be a positive integer");
    if (maxQueue !== Infinity && (!Number.isInteger(maxQueue) || maxQueue < 0)) {
      throw new Error("maxQueue must be a non-negative integer");
    }
    this.available = slots;
    this.maxQueue = maxQueue;
  }

  async acquire(timeoutMs?: number): Promise<() => void> {
    if (this.closed) throw new Error("Renderer has been shut down");
    if (this.available > 0) {
      this.available--;
    } else {
      if (this.queue.length >= this.maxQueue) {
        throw new Error("Renderer busy — too many renders queued");
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          const waiter = { resolve, reject };
          this.queue.push(waiter);
          if (timeoutMs !== undefined) {
            timer = setTimeout(() => {
              const index = this.queue.indexOf(waiter);
              if (index < 0) return;
              this.queue.splice(index, 1);
              reject(new Error(`Render queue exceeded ${timeoutMs}ms budget`));
            }, timeoutMs);
          }
        });
      } finally {
        clearTimeout(timer);
      }
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next.resolve();
      else this.available++;
    };
  }

  /** Refuse new acquires and reject queued callers; current owners may drain. */
  close(): void {
    this.closed = true;
    for (const waiter of this.queue.splice(0)) {
      waiter.reject(new Error("Renderer has been shut down"));
    }
  }
}
