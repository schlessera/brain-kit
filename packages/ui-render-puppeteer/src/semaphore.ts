/** Minimal FIFO semaphore with a bounded wait queue. */
export class Semaphore {
  private queue: (() => void)[] = [];
  private available: number;
  private readonly maxQueue: number;

  constructor(slots: number, maxQueue = Infinity) {
    this.available = slots;
    this.maxQueue = maxQueue;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
    } else {
      if (this.queue.length >= this.maxQueue) {
        throw new Error("Renderer busy — too many renders queued");
      }
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next();
      else this.available++;
    };
  }
}
