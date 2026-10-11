import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "@schlessera/brain-ui-sdk";
import { WorkerHostError } from "@schlessera/brain-ui-sdk/internal";
import { createClaudeBackend } from "../src/backend.js";
import { SessionTooLargeError } from "../src/worker-state.js";
import * as budget from "../src/worker-state-budget.js";
import { WorkerStateError } from "../src/worker-state-budget.js";
import { mockWorkerHostForSdkStream } from "./helpers/worker-host.js";

mockWorkerHostForSdkStream();
for (const resumed of [true, false]) {
  for (const error of [new SessionTooLargeError(), new WorkerHostError("settings exceed available tmpfs"),
    new WorkerStateError("worker_state_busy", "Not enough worker runtime space for this turn right now")]) {
    test(`${error.errorClass} reaches the ${resumed ? "resumed result" : "pre-session error"} frame`, async () => {
      const frames: ServerMessage[] = [];
      const backend = createClaudeBackend({ brainPath: "/brain", queryFn: (() => { throw error; }) as never });
      await backend.startTurn({ prompt: "Return to Ithaca", ...(resumed ? { sessionId: "11111111-1111-4111-8111-111111111111" } : {}),
        signal: new AbortController().signal,
        bridge: { emit: frame => frames.push(frame), requestPermission: async () => ({ behavior: "allow" }) } });
      const terminal = frames.filter(f => (f.type === "error" || f.type === "result") && f.failure);
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({ type: resumed ? "result" : "error", failure: { errorClass: error.errorClass, message: error.message } });
    });
  }
}

test("a worker-state refusal the runtime reports as its own failure still ends the turn by name (#1625)", async () => {
  const root = mkdtempSync(join(tmpdir(), "claude-busy-")), brain = join(root, "brain"), config = join(root, "claude");
  mkdirSync(brain); mkdirSync(config); writeFileSync(join(config, "settings.json"), "{}");
  // The tmpfs could hold this turn, but running turns hold all but 1 MiB of it.
  const space = spyOn(budget, "tmpfsSpace").mockReturnValue({ free: 1024 * 1024, total: 64 * 1024 * 1024 });
  try {
    const frames: ServerMessage[] = [];
    let spawnError: unknown;
    const queryFn = (({ options }: { options: { spawnClaudeCodeProcess: (spawn: unknown) => unknown } }) => {
      try {
        options.spawnClaudeCodeProcess({ command: "/bin/true", args: [], env: { CLAUDE_CONFIG_DIR: config },
          signal: new AbortController().signal });
      } catch (error) { spawnError = error; }
      throw new Error("Claude Code process exited with code 1");
    }) as never;
    const backend = createClaudeBackend({ brainPath: brain, queryFn });
    await backend.startTurn({ prompt: "Return to Ithaca", sessionId: "11111111-1111-4111-8111-111111111111",
      signal: new AbortController().signal,
      bridge: { emit: frame => frames.push(frame), requestPermission: async () => ({ behavior: "allow" }) } });
    expect(spawnError).toBeInstanceOf(WorkerStateError);
    const terminal = frames.filter(f => (f.type === "error" || f.type === "result") && f.failure);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ type: "result", failure: { errorClass: "worker_state_busy" } });
    expect(frames.some(f => f.type === "error" && f.message.includes("exited with code 1")), "the runtime's own error is not the report").toBe(false);
  } finally { space.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});
