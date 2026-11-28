// Isolated process: replace the session runtime with a scripted transcript, run the real entry.
// Modes: `turn` (a new session, ten tool rounds), `stream` (the same rounds, each streaming
// its answer as upstream `message_update` events first), `resume` (continues init.entries and leaves
// its last call unanswered), `branch` (the list is rebuilt from the same entries in another
// order) and `bound:<extra>` (small appends up to a whole snapshot of PI_PIPE_MAX_BYTES + extra).
// Writes the worker's final list to `<scratch>/final.json`.
import { mock } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as internal from "@schlessera/brain-ui-sdk/internal";
import { PI_PIPE_MAX_BYTES } from "../../src/worker-protocol.js";
const scratch = process.argv[2]!, mode = process.argv[3]!;
const at = "2026-07-12T10:00:00.000Z";
// Keys deliberately out of schema order: a reordering validator would change the saved bytes.
const usage = { totalTokens: 3, input: 2, output: 1, cacheWrite: 0, cacheRead: 0,
  cost: { total: 0, cacheWrite: 0, cacheRead: 0, output: 0, input: 0 } };
mock.module("@schlessera/brain-ui-sdk/internal", () => ({ ...internal, WORKER_SCRATCH: scratch }));
mock.module("../../src/session-resources.js", () => ({ createSessionResources: () => ({ buildToolkit() {} }) }));
mock.module("../../src/native-session-runtime.js", () => ({
  createSessionRuntime(options: any) {
    let listener: (event: any) => void;
    let header: Record<string, unknown>, list: Record<string, any>[];
    const manager = { getHeader: () => header, getEntries: () => list.filter(() => true) };
    // Microtask steps only: this entry exits once its stdin (a regular file here) ends, which a
    // macrotask would let happen mid-turn. The entry's queued snapshots still interleave.
    const tick = async () => { for (let i = 0; i < 3; i++) await Promise.resolve(); };
    const append = (entry: Record<string, any>) => {
      list.push(entry);
      listener({ type: "entry_appended", entry });
      if (entry.type === "message") listener({ type: "message_end", message: entry.message });
    };
    const message = (id: string, value: Record<string, unknown>) =>
      ({ parentId: list.at(-1)?.id ?? null, message: value, id, timestamp: at, type: "message" });
    async function round(prefix: string, n: number, answered = true) {
      const call = `${prefix}-call-${n}`;
      if (mode === "stream") {
        // As upstream sends them: every delta carries the answer so far, twice.
        let text = "";
        for (const delta of [`Round ${n}: `, "ask ", "Tiresias."]) {
          text += delta;
          const partial = { role: "assistant", content: [{ type: "text", text }], model: "odysseus-model", stopReason: "stop", usage, timestamp: 1 };
          listener({ type: "message_update", message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial } });
        }
        await tick();
      }
      append(message(`${prefix}-a${n}`, { usage, stopReason: "toolUse", model: "odysseus-model", content: [
        { type: "text", text: `Round ${n}: ask Tiresias.` }, { arguments: { path: `voyage/${n}.md` }, name: "read_file", id: call, type: "toolCall" }],
        role: "assistant", timestamp: 1 }));
      await tick();
      if (!answered) return;
      listener({ type: "tool_execution_start", toolCallId: call, toolName: "read_file", args: { path: `voyage/${n}.md` } });
      listener({ type: "tool_execution_end", toolCallId: call, toolName: "read_file",
        result: { content: [{ type: "text", text: `Leg ${n} of the voyage.` }] }, isError: false });
      await tick();
      append(message(`${prefix}-r${n}`, { isError: false, content: [{ text: `Leg ${n} of the voyage.`, type: "text" }],
        toolName: "read_file", toolCallId: call, role: "toolResult", timestamp: 1 }));
      await tick();
    }
    const session = {
      sessionId: options.sessionId,
      subscribe(fn: typeof listener) { listener = fn; },
      async prompt(text: string) {
        const prefix = mode === "resume" ? "second" : "first";
        append(message(`${prefix}-u`, { content: text, role: "user", timestamp: 1 }));
        await tick();
        if (mode === "turn" || mode === "stream") for (let n = 1; n <= 10; n++) await round(prefix, n);
        if (mode === "resume") { for (let n = 1; n <= 3; n++) await round(prefix, n); await round(prefix, 4, false); }
        if (mode === "branch") {
          for (let n = 1; n <= 2; n++) await round(prefix, n);
          // The same entry objects in another order, as upstream branching can leave them.
          list = [list[0]!, list[3]!, list[4]!, list[1]!, list[2]!];
          await round(prefix, 3);
        }
        if (mode.startsWith("bound:")) {
          const target = PI_PIPE_MAX_BYTES + Number(mode.slice(6)), step = 1024 * 1024;
          const filler = (id: string, size: number) => ({ type: "custom", id, parentId: list.at(-1)!.id, timestamp: at, data: "x".repeat(size) });
          const whole = () => Buffer.byteLength(JSON.stringify({ type: "snapshot", entries: [header, ...list] }) + "\n");
          let n = 0;
          // Whole megabytes, then one entry sized to land exactly on the target.
          while (whole() + step + 1024 < target) { append(filler(`fill-${n++}`, step)); await tick(); }
          const last = filler(`fill-${n}`, 0);
          last.data = "x".repeat(target - whole() - Buffer.byteLength(JSON.stringify(last)) - 1);
          append(last);
          await tick();
        }
        writeFileSync(join(scratch, "final.json"), JSON.stringify([header, ...list]));
      },
      async abort() {}, dispose() {}, getSessionStats: () => ({ cost: 0 }),
    };
    return {
      async newSession() {
        header = { cwd: options.backend.brainPath, timestamp: at, id: options.sessionId, version: 3, type: "session" };
        list = [];
        options.observeManager(manager);
        return { session, loadedExtensions: 0 };
      },
      async openSession() {
        [header, ...list] = options.entries;
        options.observeManager(manager);
        return { session, loadedExtensions: 0 };
      },
    };
  },
}));
await import("../../src/worker-entry.js");
