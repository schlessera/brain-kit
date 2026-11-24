import { observeDiagnostic } from "@schlessera/brain-ui-sdk/internal";
import type { ActivityTurnOpenSubPhase } from "@schlessera/brain-ui-sdk/protocol";
import { recordIndexUpdate, type IndexUpdateReceipt } from "./index-update-receipt.js";
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
interface IndexOutcome {
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
  queue(paths: readonly string[], settle?: (outcome: IndexOutcome) => void, turnId?: string): void;
  /**
   * Resolve once everything queued before this call is indexed. Rejects with
   * {@link IndexFlushError} when the update covering it fails. `signal` stops
   * this wait only; a started update is owned by the batch and still runs.
   */
  barrier(signal?: AbortSignal, observation?: { turnId: string; observed?(): void; stats: NonNullable<ActivityTurnOpenSubPhase["indexSettle"]> }): Promise<void>;
  /** Whether queued paths wait for an update. */
  pending(): boolean;
  /** Settles once no update is running; for shutdown. */
  idle(): Promise<void>;
  /**
   * Mark the queue before a checkpoint of the brain is taken (#2848). Read
   * after it, `paths` names every path queued but not yet indexed at the mark,
   * and every path queued since, flushed or not: the checkpoint's index may
   * lack any of them. Over-inclusion is harmless. Release it once read.
   */
  watermark(): { paths(): string[]; release(): void };
}

interface Entry { turnId?: string; seq: number; paths: readonly string[]; settle?: (outcome: IndexOutcome) => void; failed: boolean }

export function createIndexBatch(options: {
  /** One targeted update over exact paths, in the isolated maintenance boundary. */
  index(paths: readonly string[]): Promise<void>;
  receipt?: (receipt: IndexUpdateReceipt, turnIds: string[]) => unknown;
  cancellation?: readonly AbortSignal[];
  /** A separate credentialed refresh keeps the same causing turns. */
  afterIndex?: (turnIds: string[]) => void;
}): IndexBatch {
  let queued = 0, indexed = 0;
  let entries: Entry[] = [];
  // Flushed entries a held watermark still names.
  let history: Entry[] = [];
  const marks = new Set<{ seq: number }>();
  const lowest = () => Math.min(...[...marks].map(mark => mark.seq));
  type Flight = { work: Promise<void>; receipt?: IndexUpdateReceipt };
  let flight: Flight | undefined;
  const report = (entry: Entry, outcome: IndexOutcome) => {
    try { entry.settle?.(outcome); } catch { /* A receipt sink cannot fail the update it reports. */ }
  };
  const flush = async (running: Flight): Promise<void> => {
    const through = queued;
    const batch = entries.filter(entry => entry.seq <= through);
    const paths = [...new Set(batch.flatMap(entry => entry.paths))].sort();
    try { await recordIndexUpdate(() => options.index(paths), receipt => {
      running.receipt = receipt;
      return options.receipt?.(receipt, [...new Set(batch.flatMap(entry => entry.turnId ? [entry.turnId] : []))]);
    }, options.cancellation); }
    catch (error) {
      const indexError = error instanceof Error ? error.message : String(error);
      for (const entry of batch) if (!entry.failed) { entry.failed = true; report(entry, { paths: entry.paths, indexed: false, indexError }); }
      throw new IndexFlushError(paths, indexError);
    }
    options.afterIndex?.([...new Set(batch.flatMap(entry => entry.turnId ? [entry.turnId] : []))]);
    if (marks.size) history.push(...batch.filter(entry => entry.seq > lowest()));
    entries = entries.filter(entry => entry.seq > through);
    indexed = Math.max(indexed, through);
    for (const entry of batch) report(entry, { paths: entry.paths, indexed: true });
  };
  const start = () => {
    const running: Flight = { work: Promise.resolve() };
    flight = running;
    running.work = flush(running).finally(() => { flight = undefined; });
    return running;
  };
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
    queue(paths, settle, turnId) {
      if (!paths.length) return;
      entries.push({ ...(turnId ? { turnId } : {}), seq: ++queued, paths: [...paths], ...(settle ? { settle } : {}), failed: false });
    },
    async barrier(signal, observation) {
      const target = queued;
      const stats: NonNullable<ActivityTurnOpenSubPhase["indexSettle"]> | undefined = observation ? {
        queuedPaths: new Set(entries.filter(entry => entry.turnId === observation.turnId).flatMap(entry => entry.paths)).size,
        updates: 0, firstAlreadyRunning: indexed < target && flight !== undefined, updateMs: 0, lastOutcome: null,
      } : undefined;
      const publish = () => {
        if (stats && observation) observeDiagnostic(() => {
          Object.assign(observation.stats, stats);
          return observation.observed?.();
        });
      };
      publish();
      // A running update may predate the paths this caller waits for: after
      // it settles, the next one covers them.
      while (indexed < target) {
        const running = flight ?? start();
        if (stats) { stats.updates++; publish(); }
        try { await wait(running.work, signal); }
        finally {
          if (stats && running.receipt) {
            stats.updateMs += running.receipt.durationMs;
            stats.lastOutcome = running.receipt.outcome;
            publish();
          }
        }
      }
    },
    pending: () => entries.length > 0,
    async idle() { while (flight) await flight.work.catch(() => {}); },
    watermark() {
      const mark = { seq: indexed };
      marks.add(mark);
      return {
        paths: () => [...new Set([...history, ...entries].filter(entry => entry.seq > mark.seq).flatMap(entry => entry.paths))].sort(),
        release() { marks.delete(mark); history = marks.size ? history.filter(entry => entry.seq > lowest()) : []; },
      };
    },
  };
}

/** pi's direct in-worker readers of the index, and the shell that can run the CLI's. */
const INDEX_READERS = new Set(["brain_search", "brain_context", "brain_read", "brain_list", "brain_graph", "brain_read_many", "bash", "Bash"]);

/**
 * Whether a tool, by the name the runtime calls it, can read the index: every
 * tool of the brain's own MCP server (core's readers and module tools alike),
 * pi's in-worker readers, and either backend's shell, which can run `brain
 * search`. Host application tools and file tools read Markdown, not the index.
 */
export function readsIndex(toolName: string): boolean {
  return toolName.startsWith("mcp__brain__") || INDEX_READERS.has(toolName);
}
