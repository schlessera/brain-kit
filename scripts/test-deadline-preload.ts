/**
 * Preload for a run that applies CPU load on purpose (#4191): multiplies every
 * explicit test and hook timeout by the run's factor.
 *
 * Bun 1.4.2 has no flag for this. `--timeout` and `setDefaultTimeout` set only
 * the default: a test that names its own timeout (`test(name, body, 5000)`,
 * `{ timeout: 5000 }`) keeps it whatever the invocation says. The repetition
 * command (scripts/test-determinism.ts) therefore adds this preload after the
 * offline one and sets the factor in the environment. No other command loads
 * it, and with a factor of one it does nothing.
 *
 * It replaces `bun:test` for the invocation with a copy whose registrars scale
 * (`scaledTestModule`, scripts/test-deadlines.ts), through Bun's own
 * `mock.module`. Verified against Bun 1.4.2: the replacement reaches every
 * later import and the runner's globals, in every file and every repetition,
 * whether or not an earlier preload already imported `bun:test`; and
 * `mock.restore()` in a test does not undo it. Assigning to the object
 * `require("bun:test")` returns does not work once anything has imported the
 * module, which the offline preload has.
 */
import * as real from "bun:test";
import { mock } from "bun:test";
import { deadlineFactor, scaledTestModule } from "./test-deadlines";

const factor = deadlineFactor();
if (factor > 1) {
  const scaled = scaledTestModule(real, factor);
  mock.module("bun:test", () => scaled);
  // An unknown never becomes scaled: if a later Bun stops handing the
  // replacement to importers, the run stops here instead of repeating its
  // files under unscaled timeouts.
  const seen = await import("bun:test") as unknown as Record<string, unknown>;
  if (seen.test !== scaled.test || seen.beforeEach !== scaled.beforeEach)
    throw new Error("bun:test was not replaced for this invocation: explicit test timeouts would stay unscaled under load (scripts/test-deadline-preload.ts)");
}
