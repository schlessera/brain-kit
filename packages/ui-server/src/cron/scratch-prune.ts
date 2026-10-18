import type { Database } from "bun:sqlite";
import { recordGovernanceEvent } from "../governance/events.js";
import type { Logger } from "@opentelemetry/api-logs";
import type { BrainClient, MaintenanceRequest } from "../brain/client.js";

/**
 * The periodic pass over the brain's scratch area (#310): `brain scratch
 * prune` once at boot and then every hour, through the same CLI client every
 * other brain call goes through. ui-server does not depend on core
 * (tests/allowed-edges.ts), so the policy stays in core and this only asks
 * for it to run. Bridge tools that write into scratch (a mask beside a
 * draft) run the same pass through `tick`.
 *
 * Writes into scratch prune as they go, and `brain maintain` prunes when the
 * container crontab runs it; this timer covers a deployment that runs neither
 * for a while, so a scratch file never outlives the policy by more than an
 * hour past its last write. A failed pass is logged, never thrown: a brain
 * repo pinned to a CLI without the command must not take the server down.
 *
 * Every pass has a deadline: a CLI that hangs is killed, so it cannot pin
 * `inFlight` and switch pruning off for good. `close()` kills a pass still
 * running and resolves once its child has exited.
 */
export class ScratchPruneSuspended extends Error {}

export const SCRATCH_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
export const SCRATCH_PRUNE_DEADLINE_MS = 5 * 60 * 1000;

export interface ScratchPruner {
  /** Run one pass now. Resolves once it finished; never rejects. */
  tick(): Promise<void>;
  /** Explicit owner pass after existing work settles; preserves the raw owner report. */
  run(request: MaintenanceRequest): Promise<string>;
  /** Stop the timer, kill a pass in flight, and resolve once it has exited. */
  close(): Promise<void>;
}

/** Schedule `check` every `ms`; returns the cancel. Injected by tests. */
export type Every = (check: () => void, ms: number) => () => void;

export function startScratchPrune(options: {
  brain: Pick<BrainClient, "scratchPrune">;
  log?: Logger;
  db?: Database;
  pins?: { file: string; refresh(signal: AbortSignal): Promise<void> };
  every?: Every;
  intervalMs?: number;
  deadlineMs?: number;
}): ScratchPruner {
  const { brain, log } = options;
  const deadlineMs = options.deadlineMs ?? SCRATCH_PRUNE_DEADLINE_MS;
  let inFlight: Promise<string> | null = null;
  let active: AbortController | null = null;
  let closed = false;
  let tickFlight: Promise<void> | null = null;

  const run = (request?: MaintenanceRequest): Promise<string> => {
    // A pass still running when the next is due is left to finish; the
    // timer does not stack a second CLI process on top of it.
    if (inFlight) return request ? inFlight.catch(() => "").then(() => run(request)) : inFlight;
    if (closed) return Promise.reject(new Error("scratch prune is closed"));
    request?.signal?.throwIfAborted(); request?.assertAuthorized?.();
    const controller = new AbortController();
    const deadline = setTimeout(
      () => controller.abort(new Error(`scratch prune exceeded ${deadlineMs}ms and was killed`)),
      deadlineMs
    );
    if (typeof deadline === "object" && "unref" in deadline) deadline.unref();
    const abort = () => controller.abort(request?.signal?.reason);
    request?.signal?.addEventListener("abort", abort, { once: true });
    if (request?.signal?.aborted) abort();
    active = controller;
    inFlight = (async () => {
      if (options.pins) {
        try { await options.pins.refresh(controller.signal); }
        catch (error) { controller.signal.throwIfAborted(); throw new ScratchPruneSuspended(error instanceof Error ? error.message : String(error)); }
      }
      controller.signal.throwIfAborted();
      request?.assertAuthorized?.();
      return brain.scratchPrune({ ...(request ?? {}), signal: controller.signal, ...(options.pins ? { pinsFile: options.pins.file } : {}) });
    })()
      .then((output) => {
        try {
          const report = JSON.parse(output) as { bytes: number; overageBytes?: number; pinned: { files: number; bytes: number } };
          if (report.overageBytes && report.overageBytes > 0) {
            let eventError: unknown;
            if (options.db) {
              try {
                recordGovernanceEvent(options.db, { kind: "scratch_overage", actor: "server", sessionId: null,
                  turnId: null, model: null, profile: null, payload: { bytes: report.bytes,
                    pinnedFiles: report.pinned.files, pinnedBytes: report.pinned.bytes, overageBytes: report.overageBytes } });
                return output;
              } catch (error) { eventError = error; }
            }
            log?.emit({ severityText: "WARN", body: "scratch remains over its size cap; retained conversation pins were preserved",
              attributes: { "scratch.overage_bytes": report.overageBytes, "scratch.pinned_bytes": report.pinned?.bytes ?? 0,
                ...(eventError ? { "governance.error": eventError instanceof Error ? eventError.message : String(eventError) } : {}) } });
          }
        } catch { /* Legacy human-output CLI remains an unknown structured report. */ }
        return output;
      })
      .finally(() => {
        clearTimeout(deadline);
        request?.signal?.removeEventListener("abort", abort);
        active = null;
        inFlight = null;
      });
    return inFlight;
  };

  const tick = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (tickFlight) return tickFlight;
    tickFlight = run().then(() => undefined).catch((error: unknown) => {
      log?.emit({ severityText: "WARN", body: "scratch prune failed; the next pass is in an hour",
        attributes: { error: error instanceof Error ? error.message : String(error) } });
    }).finally(() => { tickFlight = null; });
    return tickFlight;
  };

  const every: Every =
    options.every ??
    ((check, ms) => {
      const timer = setInterval(check, ms);
      // A closed test app must not be kept alive by it.
      if (typeof timer === "object" && "unref" in timer) timer.unref();
      return () => clearInterval(timer);
    });
  void tick();
  const cancel = every(() => void tick(), options.intervalMs ?? SCRATCH_PRUNE_INTERVAL_MS);

  return {
    tick,
    run,
    close: () => {
      closed = true;
      cancel();
      active?.abort(new Error("the server is shutting down"));
      return inFlight?.then(() => undefined, () => undefined) ?? Promise.resolve();
    },
  };
}
