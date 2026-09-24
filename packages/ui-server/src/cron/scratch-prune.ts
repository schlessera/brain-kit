import type { Logger } from "@opentelemetry/api-logs";
import type { BrainClient } from "../brain/client.js";

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
export const SCRATCH_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
export const SCRATCH_PRUNE_DEADLINE_MS = 5 * 60 * 1000;

export interface ScratchPruner {
  /** Run one pass now. Resolves once it finished; never rejects. */
  tick(): Promise<void>;
  /** Stop the timer, kill a pass in flight, and resolve once it has exited. */
  close(): Promise<void>;
}

/** Schedule `check` every `ms`; returns the cancel. Injected by tests. */
export type Every = (check: () => void, ms: number) => () => void;

export function startScratchPrune(options: {
  brain: Pick<BrainClient, "scratchPrune">;
  log?: Logger;
  every?: Every;
  intervalMs?: number;
  deadlineMs?: number;
}): ScratchPruner {
  const { brain, log } = options;
  const deadlineMs = options.deadlineMs ?? SCRATCH_PRUNE_DEADLINE_MS;
  let inFlight: Promise<void> | null = null;
  let active: AbortController | null = null;
  let closed = false;

  const tick = (): Promise<void> => {
    // A pass still running when the next is due is left to finish; the
    // timer does not stack a second CLI process on top of it.
    if (inFlight) return inFlight;
    if (closed) return Promise.resolve();
    const controller = new AbortController();
    const deadline = setTimeout(
      () => controller.abort(new Error(`scratch prune exceeded ${deadlineMs}ms and was killed`)),
      deadlineMs
    );
    if (typeof deadline === "object" && "unref" in deadline) deadline.unref();
    active = controller;
    inFlight = brain
      .scratchPrune({ signal: controller.signal })
      .then(() => undefined)
      .catch((error: unknown) => {
        log?.emit({
          severityText: "WARN",
          body: "scratch prune failed; the next pass is in an hour",
          attributes: { error: error instanceof Error ? error.message : String(error) },
        });
      })
      .finally(() => {
        clearTimeout(deadline);
        active = null;
        inFlight = null;
      });
    return inFlight;
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
    close: () => {
      closed = true;
      cancel();
      active?.abort(new Error("the server is shutting down"));
      return inFlight ?? Promise.resolve();
    },
  };
}
