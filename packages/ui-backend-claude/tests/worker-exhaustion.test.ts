/**
 * A real bubblewrap worker whose runtime state fills only after the runtime
 * reported its result (#1625): the terminal result waits for the worker's exit
 * and copy-out, so it is named `worker_state_exceeded`, never a saved success.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import type { ServerMessage } from "@schlessera/brain-ui-sdk";
import { createClaudeBackend } from "../src/backend.js";

const MiB = 1024 * 1024;

async function run(script: string, abortAfterResult = false) {
  const root = mkdtempSync(join(tmpdir(), "claude-exhaustion-")), brain = join(root, "brain"), config = join(root, "claude");
  mkdirSync(brain); mkdirSync(config); writeFileSync(join(config, "settings.json"), "{}");
  const frames: ServerMessage[] = [];
  const host = new AbortController();
  const queryFn = ((params: { options?: Options }) => {
    const options = params.options!;
    const stream = (async function* () {
      // The runtime's process: a real worker that writes after its result is out.
      const child = options.spawnClaudeCodeProcess!({ command: "/bin/sh", args: ["-c", script], cwd: brain,
        env: { PATH: "/usr/bin:/bin", CLAUDE_CONFIG_DIR: config }, signal: new AbortController().signal } as never);
      (child.stdout as NodeJS.ReadableStream).resume();
      yield { type: "system", subtype: "init", session_id: "11111111-1111-4111-8111-111111111111", apiKeySource: "none" };
      yield { type: "result", subtype: "success", session_id: "11111111-1111-4111-8111-111111111111", total_cost_usd: 0.25,
        duration_ms: 1, num_turns: 1, result: "Ithaca" };
      if (abortAfterResult) host.abort();
    })();
    return Object.assign(stream, { initializationResult: async () => ({
      account: { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" } }) });
  }) as unknown as typeof query;
  try {
    const backend = createClaudeBackend({ brainPath: brain, queryFn,
      workerState: { allowanceBytes: 4 * MiB, budgetBytes: 4 * MiB } });
    await backend.startTurn({ prompt: "Return to Ithaca", signal: host.signal,
      bridge: { emit: frame => frames.push(frame), requestPermission: async () => ({ behavior: "allow" }) } });
    return frames.filter(f => f.type === "result");
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("state that fills after the result still ends the turn as worker_state_exceeded, keeping its usage", async () => {
  const results = await run(`sleep 0.3; head -c ${8 * MiB} /dev/zero > "$CLAUDE_CONFIG_DIR/late" 2>/dev/null; exit 0`);
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ outcome: "error", isError: true, costUsd: 0.25, failure: { errorClass: "worker_state_exceeded" } });
}, 30_000);

test("state with room left keeps the runtime's success", async () => {
  const results = await run(`sleep 0.3; head -c ${MiB} /dev/zero > "$CLAUDE_CONFIG_DIR/small"; exit 0`);
  expect(results).toMatchObject([{ outcome: "success" }]);
}, 30_000);

test("a host cancellation outranks a full state found after the result", async () => {
  const results = await run(`head -c ${8 * MiB} /dev/zero > "$CLAUDE_CONFIG_DIR/full" 2>/dev/null; sleep 0.3; exit 0`, true);
  expect(results).toHaveLength(1);
  expect(results[0]).not.toHaveProperty("failure.errorClass", "worker_state_exceeded");
}, 30_000);

test("a write failure the worker reported stays on record however much it prints afterwards", async () => {
  const results = await run(`echo "Error: ENOSPC: no space left on device, write $CLAUDE_CONFIG_DIR/late" >&2; head -c 200000 /dev/zero | tr '\\0' x >&2; exit 0`);
  expect(results[0]).toMatchObject({ outcome: "error", failure: { errorClass: "worker_state_exceeded" } });
}, 30_000);
