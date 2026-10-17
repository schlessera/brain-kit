/** Deterministic settlement windows complement the real SDK/native host proof. */
import { expect, test, spyOn } from "bun:test";
import type { query, Options } from "@anthropic-ai/claude-agent-sdk";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createClaudeBackend } from "../src/backend.js";
import * as workers from "../src/worker-spawn.js";
import { mockWorkerHostForSdkStream } from "./helpers/worker-host.js";
mockWorkerHostForSdkStream();
const SESSION = "11111111-1111-4111-8111-111111111111";
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const success = { type: "result", subtype: "success", session_id: SESSION, total_cost_usd: 0.25, duration_ms: 123, num_turns: 1 };

for (const mode of ["cancel-during-cleanup", "result-after-abort", "result-then-throw", "no-result-eof", "no-result-throw", "no-result-cancel-during-cleanup", "no-identity", "no-identity-eof-during-cleanup", "no-identity-throw-during-cleanup"] as const) {
  test(`${mode}: one cancelled terminal follows settlement`, async () => {
    const finishing = deferred(), release = deferred(), host = new AbortController(), frames: ServerMessage[] = [];
    let settled = false, finishedAtTerminal: boolean | undefined;
    const terminalFrame = (frame: ServerMessage) => frame.type === "result" || mode.startsWith("no-identity") && frame.type === "error";
    const cancelDuringCleanup = mode === "cancel-during-cleanup" || mode.includes("during-cleanup");
    const original = workers.createWorkerSpawn;
    const finish = spyOn(workers, "createWorkerSpawn").mockImplementation((...args) => {
      const worker = original(...args);
      return { ...worker, async finish() { finishing.resolve(); await release.promise; await worker.finish(); settled = true; } };
    });
    const queryFn = (({ options }: { options: Options }) => (async function* () {
      if (!mode.startsWith("no-identity")) yield { type: "system", subtype: "init", session_id: SESSION };
      if (!cancelDuringCleanup) host.abort();
      expect(options.abortController?.signal.aborted).toBe(!cancelDuringCleanup);
      if (["cancel-during-cleanup", "result-after-abort", "result-then-throw"].includes(mode)) yield success;
      if (mode === "no-identity-throw-during-cleanup") throw new Error("Fixture runtime failed before identity");
      if (mode === "result-then-throw" || mode === "no-result-throw") throw new DOMException("Aborted", "AbortError");
    })()) as unknown as typeof query;
    const backend = createClaudeBackend({ brainPath: "/brain", queryFn, log() {} });
    const run = backend.startTurn({ prompt: "Return to Ithaca", signal: host.signal, bridge: {
      emit(frame) { frames.push(frame); if (terminalFrame(frame)) finishedAtTerminal = settled; },
      requestPermission: async () => ({ behavior: "allow" }),
    } });
    try {
      await finishing.promise;
      expect(frames.filter(frame => terminalFrame(frame)), "NO_TERMINAL_WHILE_CLEANUP_PENDING").toHaveLength(0);
      host.abort(); release.resolve(); await run;
      expect(finishedAtTerminal, "TERMINAL_AFTER_SETTLEMENT").toBe(true);
      const terminal = frames.filter(terminalFrame);
      expect(frames.findIndex(frame => frame.type === "status" && frame.status === "cancelled"), "CANCELLED_STATUS_PRECEDES_TERMINAL").toBeGreaterThanOrEqual(0);
      expect(frames.findIndex(frame => frame.type === "status" && frame.status === "cancelled")).toBeLessThan(frames.findIndex(terminalFrame));
      expect(terminal, "EXACTLY_ONE_CANCELLED_TERMINAL").toHaveLength(1);
      if (mode.startsWith("no-identity")) expect(terminal[0]).toMatchObject({ type: "error", code: "CANCELLED" });
      else expect(terminal[0], "CANCEL_DURING_CLEANUP_OUTRANKS_BUFFERED_SUCCESS").toMatchObject({ type: "result", outcome: "cancelled", isError: false });
    } finally { release.resolve(); try { await run; } finally { finish.mockRestore(); } }
  });
}
