// Isolated process: replace inference/session collaborators, run the real entry.
import { mock } from "bun:test";
import * as internal from "@schlessera/brain-ui-sdk/internal";
import { PI_PIPE_MAX_BYTES } from "../../src/worker-protocol.js";
const scratch = process.argv[2]!;
const queued = process.argv[3] === "queued";
mock.module("@schlessera/brain-ui-sdk/internal", () => ({ ...internal, WORKER_SCRATCH: scratch }));
mock.module("../../src/session-resources.js", () => ({ createSessionResources: () => ({ buildToolkit() {} }) }));
mock.module("../../src/native-session-runtime.js", () => ({
  createSessionRuntime(options: any) {
    let listener: (event: any) => void;
    options.observeManager({ getHeader: () => ({ type: "session" }),
      getEntries: () => [{ text: "x".repeat(PI_PIPE_MAX_BYTES) }] });
    const session = {
      sessionId: options.sessionId,
      subscribe(fn: typeof listener) { listener = fn; },
      async prompt() {
        listener(queued ? { type: "tool_execution_end", toolCallId: "odysseus", toolName: "read_file",
          result: { content: [] }, isError: false } : { type: "entry_appended" });
      },
      async abort() {}, dispose() {}, getSessionStats: () => ({ cost: 0 }),
    };
    return { newSession: async () => ({ session }) };
  },
}));
await import("../../src/worker-entry.js");
