/**
 * Published AgentRunner contract suite — the executable form of the promises
 * in docs/extending/agent-runners.md and on the interface in ../lib/seams.ts:
 *
 *   1. `id` is a string; `capabilities.streaming` and `capabilities.skills`
 *      are booleans
 *   2. `capabilities.streaming` agrees with whether `runStreaming` exists
 *   3. `run` executes the agent in `cwd` on the prompt it was given and
 *      resolves to the agent's final text
 *   4. `run` honours `timeoutMs`: an agent that never finishes is abandoned
 *      and the run rejects once the given deadline passes, not before it and
 *      not on some fixed deadline of the runner's own
 *   5. `runStreaming`, when present, runs the same way, resolves to the same
 *      final text, and surfaces the agent's tool activity through `onEvent`
 *      as `{ kind: "tool" | "text", label }` events *as it happens*: the fake
 *      agent does not finish until the runner has delivered its tool event,
 *      so a runner that holds events back until the end never resolves
 *
 * Runners run against caller-supplied fake agents (a stand-in binary on
 * `PATH`, a stub process), never a live model and never a key.
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentRunner } from "../lib/seams.js";
import { settleWithin, type ContractTestPrimitives } from "./primitives.js";

/**
 * The file the suite creates in the run's working directory once the agent
 * may finish: before `run`, and under `runStreaming` only when the runner has
 * delivered the agent's tool event to `onEvent`.
 */
export const TOOL_EVENT_SEEN_FILE = ".brain-contract-tool-event-seen";

export interface AgentRunnerContractHarness {
  name: string;
  /**
   * A runner whose agent uses one tool, waits until `TOOL_EVENT_SEEN_FILE`
   * exists in its working directory, then answers with that directory, a
   * newline, and the prompt it received, verbatim:
   * `${process.cwd()}\n${prompt}`. Give up waiting after a few seconds by
   * failing, so a stand-in process never outlives the suite.
   */
  echoing(): AgentRunner;
  /** A runner whose agent starts and never finishes. */
  hanging(): AgentRunner;
}

/**
 * Two deadlines whose acceptance windows do not overlap, so a runner timing
 * out on a fixed deadline of its own cannot satisfy both: the short run must
 * be over by SHORT_TIMEOUT_MS + GRACE_MS, and the long run must still be going
 * after that, until its own deadline.
 */
const SHORT_TIMEOUT_MS = 400;
const LONG_TIMEOUT_MS = 2_500;
/** How far past its deadline a run may still be going before it counts as hung. */
const GRACE_MS = 1_100;
/** A run may be abandoned this much before its deadline (timer granularity). */
const EARLY_MS = 50;
/** How long a streamed run may take once its tool event has been delivered. */
const STREAM_SETTLE_MS = 4_000;

const PROMPT = "Summarise the notes filed under voyages.";

/** Run `fn` in a fresh working directory, removed afterwards. */
async function inScratchDir<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "brain-runner-contract-")));
  try {
    return await fn(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** Register the AgentRunner contract suite for one runner harness. */
export function runAgentRunnerContract(
  harness: AgentRunnerContractHarness,
  primitives: ContractTestPrimitives
): void {
  const { describe, expect, test } = primitives;

  describe(`AgentRunner contract: ${harness.name}`, () => {
    test("id is a string and capabilities are booleans", () => {
      const runner = harness.echoing();
      expect(typeof runner.id).toBe("string");
      expect(typeof runner.capabilities?.streaming).toBe("boolean");
      expect(typeof runner.capabilities?.skills).toBe("boolean");
    });

    test("capabilities.streaming agrees with whether runStreaming exists", () => {
      const runner = harness.echoing();
      expect({
        streaming: runner.capabilities.streaming,
        runStreaming: typeof runner.runStreaming,
      }).toEqual({
        streaming: runner.capabilities.streaming,
        runStreaming: runner.capabilities.streaming ? "function" : "undefined",
      });
    });

    test("run executes the agent in cwd on the prompt and resolves to its final text", async () => {
      const runner = harness.echoing();
      await inScratchDir(async (cwd) => {
        writeFileSync(join(cwd, TOOL_EVENT_SEEN_FILE), "");
        expect(await runner.run(PROMPT, { cwd })).toBe(`${cwd}\n${PROMPT}`);
      });
    });

    test("run honours timeoutMs: a run that never finishes rejects once its deadline passes", async () => {
      const runner = harness.hanging();
      await inScratchDir(async (cwd) => {
        const started = performance.now();
        const outcome = await settleWithin(
          runner.run(PROMPT, { cwd, timeoutMs: SHORT_TIMEOUT_MS }),
          SHORT_TIMEOUT_MS + GRACE_MS
        );
        expect(outcome.state).toBe("rejected");
        // Rejecting before the deadline would be a failure, not a timeout.
        expect(performance.now() - started).toBeGreaterThan(SHORT_TIMEOUT_MS - EARLY_MS);
      });
    });

    test("run honours timeoutMs: a longer deadline keeps the run going past the shorter one", async () => {
      const runner = harness.hanging();
      await inScratchDir(async (cwd) => {
        const started = performance.now();
        const run = runner.run(PROMPT, { cwd, timeoutMs: LONG_TIMEOUT_MS });
        const outcome = await settleWithin(run, LONG_TIMEOUT_MS + GRACE_MS);
        const elapsed = performance.now() - started;
        expect(outcome.state).toBe("rejected");
        // Still going past the short run's whole window, and until its own deadline.
        expect(elapsed).toBeGreaterThan(LONG_TIMEOUT_MS - EARLY_MS);
      });
    });

    test("runStreaming, when present, resolves to the final text and surfaces tool activity as it happens", async () => {
      const runner = harness.echoing();
      if (!runner.runStreaming) return;
      await inScratchDir(async (cwd) => {
        const events: unknown[] = [];
        const onEvent = (e: { kind: "tool" | "text"; label: string }) => {
          events.push(e);
          if ((e as { kind?: unknown } | null)?.kind === "tool") {
            writeFileSync(join(cwd, TOOL_EVENT_SEEN_FILE), "");
          }
        };
        const outcome = await settleWithin(runner.runStreaming!(PROMPT, { cwd, onEvent }), STREAM_SETTLE_MS);

        // A runner that holds the tool event back leaves the agent waiting.
        expect(outcome.state).toBe("resolved");
        expect(outcome.state === "resolved" ? outcome.value : undefined).toBe(`${cwd}\n${PROMPT}`);
        const malformed = events.filter((e) => {
          const event = e as { kind?: unknown; label?: unknown } | null;
          return (
            event === null ||
            typeof event !== "object" ||
            (event.kind !== "tool" && event.kind !== "text") ||
            typeof event.label !== "string"
          );
        });
        expect(malformed).toEqual([]);
        const tools = events.filter((e) => (e as { kind?: unknown }).kind === "tool");
        expect(tools.length).toBeGreaterThan(0);
      });
    });
  });
}
