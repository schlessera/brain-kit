/**
 * Wait in a Bun test until a condition holds (#4835).
 *
 *   import { until } from "../../../tests/helpers/until";
 *   await until(() => frames.some(frame => frame.type === "result"), "the result frame");
 *   await until(() => done, () => JSON.stringify(frames), 10_000);
 *
 * The bound is a watchdog, not a product timing: it only stops a wait that
 * would otherwise hang, so it goes through `watchdogMs` and a run under
 * deliberate load scales it (docs/process/test-authoring.md, C4). A product
 * timing is never asserted through this helper. `what` names the awaited
 * state in the error; a function is called only when the wait fails, so it can
 * print the state the test saw.
 */
import { watchdogMs } from "../../scripts/test-deadlines";

/** The wall the loop reads and how it sleeps; the default is the monotonic clock and a real timer. */
export interface UntilClock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export interface UntilOptions {
  clock?: UntilClock;
  /** The environment `watchdogMs` reads the run's factor from. */
  env?: Readonly<Record<string, string | undefined>>;
}

export const UNTIL_DEFAULT_MS = 5_000;
const POLL_MS = 5;

const realClock: UntilClock = {
  now: () => performance.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

const describe = (what: string | (() => unknown) | undefined): string => {
  if (what === undefined) return "the condition";
  if (typeof what === "string") return what;
  const seen = what();
  return typeof seen === "string" ? seen : JSON.stringify(seen);
};

export async function until(
  predicate: () => boolean,
  what?: string | (() => unknown),
  ms: number = UNTIL_DEFAULT_MS,
  options: UntilOptions = {},
): Promise<void> {
  const clock = options.clock ?? realClock;
  const deadline = clock.now() + watchdogMs(ms, options.env);
  for (;;) {
    if (predicate()) return;
    if (clock.now() >= deadline) break;
    await clock.sleep(POLL_MS);
  }
  throw new Error(`until: timed out after ${ms} ms waiting for ${describe(what)}`);
}
