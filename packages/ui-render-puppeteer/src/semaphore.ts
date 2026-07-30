/** Minimal FIFO semaphore — bounds concurrent renders. */
export class Semaphore {
  private queue: (() => void)[] = [];
  private available: number;

  constructor(slots: number) {
    this.available = slots;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
    } else {
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
