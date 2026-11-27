// Isolated process: replace the session runtime with a scripted stream, run the real entry.
// Writes the upstream events it emitted to `<scratch>/upstream.json` for the test to compare.
import { mock } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as internal from "@schlessera/brain-ui-sdk/internal";
const scratch = process.argv[2]!;
const DELTAS = 2000;
mock.module("@schlessera/brain-ui-sdk/internal", () => ({ ...internal, WORKER_SCRATCH: scratch }));
mock.module("../../src/session-resources.js", () => ({ createSessionResources: () => ({ buildToolkit() {} }) }));
mock.module("../../src/native-session-runtime.js", () => ({
  createSessionRuntime(options: any) {
    let listener: (event: any) => void;
    options.observeManager({ getHeader: () => ({ type: "session" }), getEntries: () => [] });
    const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const session = {
      sessionId: options.sessionId,
      subscribe(fn: typeof listener) { listener = fn; },
      async prompt() {
        const forwarded: unknown[] = [];
        let thinking = "", text = "";
        for (let i = 0; i < DELTAS; i++) {
          const type = i % 2 ? "text_delta" : "thinking_delta", delta = `Ithaca ${i} `;
          if (type === "text_delta") text += delta; else thinking += delta;
          // The answer accumulated so far, as upstream carries it on every delta.
          const partial = { role: "assistant", content: [{ type: "thinking", thinking }, { type: "text", text }],
            model: "odysseus-model", stopReason: "stop", usage, timestamp: 1 };
          listener({ type: "message_update", message: partial, assistantMessageEvent: { type, contentIndex: type === "text_delta" ? 1 : 0, delta, partial } });
          // Not a forwarded update kind: the filter keeps dropping it.
          if (i === 0) listener({ type: "message_update", message: partial, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2, delta: "{}", partial } });
        }
        const end = { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking }, { type: "text", text },
          { type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "ithaca.md" } }],
          model: "odysseus-model", stopReason: "toolUse", usage, timestamp: 1 } };
        listener(end); forwarded.push(end);
        const toolEnd = { type: "tool_execution_end", toolCallId: "call-1", toolName: "read_file",
          result: { content: [{ type: "text", text: "Penelope waits." }], details: { lines: 1 } }, isError: false };
        listener(toolEnd); forwarded.push(toolEnd);
        writeFileSync(join(scratch, "upstream.json"), JSON.stringify(forwarded));
      },
      async abort() {}, dispose() {}, getSessionStats: () => ({ cost: 0 }),
    };
    return { newSession: async () => ({ session, loadedExtensions: 0 }) };
  },
}));
await import("../../src/worker-entry.js");
