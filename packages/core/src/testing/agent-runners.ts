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
 *      as `{ kind: "tool" | "text", label }` events
 *
 * Runners run against caller-supplied fake agents (a stand-in binary on
 * `PATH`, a stub process), never a live model and never a key.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentRunner } from "../lib/seams.js";
import { settleWithin, type ContractTestPrimitives } from "./primitives.js";

export interface AgentRunnerContractHarness {
  name: string;
  /**
   * A runner whose agent uses one tool, then answers with its working
   * directory, a newline, and the prompt it received, verbatim:
   * `${process.cwd()}\n${prompt}`.
   */
  echoing(): AgentRunner;
  /** A runner whose agent starts and never finishes. */
  hanging(): AgentRunner;
}

/**
 * Two deadlines far enough apart that a runner timing out on a fixed deadline
 * of its own cannot satisfy both: the short run must be over soon after the
 * short deadline, and the long run must still be going well past it.
 */
const SHORT_TIMEOUT_MS = 400;
const LONG_TIMEOUT_MS = 1_500;
/** How far past its deadline a run may still be going before it counts as hung. */
const GRACE_MS = 2_500;

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
        expect(performance.now() - started).toBeGreaterThan(SHORT_TIMEOUT_MS - 50);
      });
    });

    test("run honours timeoutMs: a longer deadline keeps the run going past the shorter one", async () => {
      const runner = harness.hanging();
      await inScratchDir(async (cwd) => {
        const run = runner.run(PROMPT, { cwd, timeoutMs: LONG_TIMEOUT_MS });
        const early = await settleWithin(run, SHORT_TIMEOUT_MS + GRACE_MS / 4);
        expect(early.state).toBe("pending");
        const outcome = await settleWithin(run, LONG_TIMEOUT_MS + GRACE_MS);
        expect(outcome.state).toBe("rejected");
      });
    });

    test("runStreaming, when present, resolves to the final text and surfaces tool activity", async () => {
      const runner = harness.echoing();
      if (!runner.runStreaming) return;
      await inScratchDir(async (cwd) => {
        const events: unknown[] = [];
        const text = await runner.runStreaming!(PROMPT, { cwd, onEvent: (e) => events.push(e) });

        expect(text).toBe(`${cwd}\n${PROMPT}`);
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
