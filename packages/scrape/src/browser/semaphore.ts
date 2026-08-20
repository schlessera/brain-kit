/**
 * Minimal FIFO semaphore with a bounded wait queue.
 *
 * Same implementation as the one in `@schlessera/brain-render-puppeteer`.
 * Copied rather than shared: it is 30 lines with no dependencies, and a
 * package existing only to hold it would add an internal dependency edge and a
 * release-coupling between the renderer's hardening and this package.
 */
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
        throw new Error("Scraper busy — too many page loads queued");
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
