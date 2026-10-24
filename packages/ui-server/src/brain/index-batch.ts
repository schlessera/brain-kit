/**
 * Deferred, batched index updates after host applications (#2835).
 *
 * An application commits its Markdown and returns; the paths it changed wait
 * here. The next index-dependent read, from any turn or route, and the end of
 * every turn that applied something flush everything waiting in one targeted
 * update, inside the planner's isolated maintenance boundary. A read that
 * waits here never runs against an index that misses a write committed
 * before it: a flush that fails rejects every waiter, its paths stay queued,
 * and the next waiter tries again. Nothing queued is dropped or reported as
 * indexed before an update that covered it completed.
 */

/** What became of one application's queued paths. */
export interface IndexOutcome {
  /** The application's own committed paths. */
  paths: readonly string[];
  /** True only once an update that covered them completed. */
  indexed: boolean;
  /** Present only when an update covering them failed. */
  indexError?: string;
}

/** A flush that did not complete: no read waiting on it may run. */
export class IndexFlushError extends Error {
  constructor(readonly paths: readonly string[], readonly indexError: string) {
    super(`The search index has not caught up with Markdown already applied: ${paths.slice(0, 8).join(", ")}${paths.length > 8 ? ` and ${paths.length - 8} more` : ""}`
      + ` ${paths.length === 1 ? "is" : "are"} committed, but updating the index failed: ${indexError.slice(0, 300)}`
      + " This read did not run, so it returned nothing stale. Retrying it retries the index update.");
    this.name = "IndexFlushError";
  }
}

export interface IndexBatch {
  /**
   * Queue committed paths. `settle` hears each outcome for them: a failure
   * once, then success once an update covers them. Returns at once.
   */
  queue(paths: readonly string[], settle?: (outcome: IndexOutcome) => void): void;
  /**
   * Resolve once everything queued before this call is indexed. Rejects with
   * {@link IndexFlushError} when the update covering it fails. `signal` stops
   * this wait only; a started update is owned by the batch and still runs.
   */
  barrier(signal?: AbortSignal): Promise<void>;
  /** Whether queued paths wait for an update. */
  pending(): boolean;
  /** Settles once no update is running; for shutdown. */
  idle(): Promise<void>;
}

interface Entry { seq: number; paths: readonly string[]; settle?: (outcome: IndexOutcome) => void; failed: boolean }

export function createIndexBatch(options: {
  /** One targeted update over exact paths, in the isolated maintenance boundary. */
  index(paths: readonly string[]): Promise<void>;
}): IndexBatch {
  let queued = 0, indexed = 0;
  let entries: Entry[] = [];
  let flight: Promise<void> | undefined;
  const report = (entry: Entry, outcome: IndexOutcome) => {
    try { entry.settle?.(outcome); } catch { /* A receipt sink cannot fail the update it reports. */ }
  };
  const flush = (): Promise<void> => flight ??= (async () => {
    const through = queued;
    const batch = entries.filter(entry => entry.seq <= through);
    const paths = [...new Set(batch.flatMap(entry => entry.paths))].sort();
    try { await options.index(paths); }
    catch (error) {
      const indexError = error instanceof Error ? error.message : String(error);
      for (const entry of batch) if (!entry.failed) { entry.failed = true; report(entry, { paths: entry.paths, indexed: false, indexError }); }
      throw new IndexFlushError(paths, indexError);
    }
    entries = entries.filter(entry => entry.seq > through);
    indexed = Math.max(indexed, through);
    for (const entry of batch) report(entry, { paths: entry.paths, indexed: true });
  })().finally(() => { flight = undefined; });
  const wait = (work: Promise<void>, signal?: AbortSignal): Promise<void> => {
    if (!signal) return work;
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  };
  return {
    queue(paths, settle) {
      if (!paths.length) return;
      entries.push({ seq: ++queued, paths: [...paths], ...(settle ? { settle } : {}), failed: false });
    },
    async barrier(signal) {
      const target = queued;
      // A running update may predate the paths this caller waits for: after
      // it settles, the next one covers them.
      while (indexed < target) await wait(flight ?? flush(), signal);
    },
    pending: () => entries.length > 0,
    async idle() { while (flight) await flight.catch(() => {}); },
  };
}

/** pi's direct in-worker readers of the index, and the shell that can run the CLI's. */
const INDEX_READERS = new Set(["brain_search", "brain_context", "brain_read", "brain_list", "brain_graph", "bash", "Bash"]);

/**
 * Whether a tool, by the name the runtime calls it, can read the index: every
 * tool of the brain's own MCP server (core's readers and module tools alike),
 * pi's in-worker readers, and either backend's shell, which can run `brain
 * search`. Host application tools and file tools read Markdown, not the index.
 */
export function readsIndex(toolName: string): boolean {
  return toolName.startsWith("mcp__brain__") || INDEX_READERS.has(toolName);
}
