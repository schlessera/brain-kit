import type { Logger } from "@opentelemetry/api-logs";
import type { BrainClient } from "../brain/client.js";

/**
 * The periodic pass over the brain's scratch area (#310): `brain scratch
 * prune` once at boot and then every hour, through the same CLI client every
 * other brain call goes through. ui-server does not depend on core
 * (tests/allowed-edges.ts), so the policy stays in core and this only asks
 * for it to run.
 *
 * Writes into scratch prune as they go, and `brain maintain` prunes when the
 * container crontab runs it; this timer covers a deployment that runs neither
 * for a while, so a scratch file never outlives the policy by more than an
 * hour past its last write. A failed pass is logged, never thrown: a brain
 * repo pinned to a CLI without the command must not take the server down.
 */
export const SCRATCH_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export interface ScratchPruner {
  /** Run one pass now. Resolves once it finished; never rejects. */
  tick(): Promise<void>;
  /** Stop the timer. */
  close(): void;
}

/** Schedule `check` every `ms`; returns the cancel. Injected by tests. */
export type Every = (check: () => void, ms: number) => () => void;

export function startScratchPrune(options: {
  brain: Pick<BrainClient, "scratchPrune">;
  log?: Logger;
  every?: Every;
  intervalMs?: number;
}): ScratchPruner {
  const { brain, log } = options;
  let inFlight: Promise<void> | null = null;

  const tick = (): Promise<void> => {
    // A pass still running when the next is due is left to finish; the
    // timer does not stack a second CLI process on top of it.
    if (inFlight) return inFlight;
    inFlight = brain
      .scratchPrune()
      .then(() => undefined)
      .catch((error: unknown) => {
        log?.emit({
          severityText: "WARN",
          body: "scratch prune failed; the next pass is in an hour",
          attributes: { error: error instanceof Error ? error.message : String(error) },
        });
      })
      .finally(() => {
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

  return { tick, close: cancel };
}
