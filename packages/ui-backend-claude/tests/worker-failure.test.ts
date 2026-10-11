import { expect, test } from "bun:test";
import type { ServerMessage } from "@schlessera/brain-ui-sdk";
import { WorkerHostError } from "@schlessera/brain-ui-sdk/internal";
import { createClaudeBackend } from "../src/backend.js";
import { SessionTooLargeError } from "../src/worker-state.js";
import { mockWorkerHostForSdkStream } from "./helpers/worker-host.js";

mockWorkerHostForSdkStream();
for (const resumed of [true, false]) {
  for (const error of [new SessionTooLargeError(), new WorkerHostError("settings exceed available tmpfs")]) {
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
