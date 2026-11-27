import { expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { piWorkerMessage } from "../src/worker-protocol.js";

test("the worker sends a streamed delta's text only and forwards other events unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-stream-frames-"));
  try {
    const messages = [
      { type: "init", backend: { brainPath: root }, env: { caps: {} },
        sessionId: "11111111-1111-4111-8111-111111111111", resume: false, agentFiles: {} },
      { type: "prompt", text: "Sail home to Ithaca" },
    ];
    const input = join(root, "stdin"), output = join(root, "stdout"), diagnostic = join(root, "stderr");
    writeFileSync(input, messages.map(m => JSON.stringify(m)).join("\n") + "\n");
    const fds = [openSync(input, "r"), openSync(output, "w"), openSync(diagnostic, "w")];
    let code: number;
    try {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/worker-stream-frames-probe.ts"), root],
        { stdin: fds[0], stdout: fds[1], stderr: fds[2] });
      code = await child.exited;
    } finally { fds.forEach(fd => closeSync(fd)); }
    expect(readFileSync(diagnostic, "utf8")).toBe("");
    expect(code).toBe(0);
    const frames = readFileSync(output, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const updates = frames.filter(frame => frame.type === "event" && frame.event.type === "message_update");
    expect(updates).toHaveLength(2000);
    updates.forEach((frame, i) => {
      const type = i % 2 ? "text_delta" : "thinking_delta";
      expect(frame).toEqual({ type: "event", event: { type: "message_update", assistantMessageEvent: { type, delta: `Ithaca ${i} ` } } });
    });
    const upstream = JSON.parse(readFileSync(join(root, "upstream.json"), "utf8"));
    expect(frames.filter(frame => frame.type === "event" && frame.event.type !== "message_update").map(frame => frame.event)).toEqual(upstream);
    // Every frame the worker wrote is one the host accepts.
    for (const frame of frames) expect(piWorkerMessage.safeParse(frame).success).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the host refuses a delta frame that carries the accumulated answer", () => {
  const partial = { role: "assistant", content: [{ type: "text", text: "Ithaca" }] };
  const frame = (event: Record<string, unknown>) => ({ type: "event", event: { type: "message_update", ...event } });
  expect(piWorkerMessage.safeParse(frame({ assistantMessageEvent: { type: "text_delta", delta: "Ithaca" } })).success).toBe(true);
  expect(piWorkerMessage.safeParse(frame({ message: partial, assistantMessageEvent: { type: "text_delta", delta: "Ithaca" } })).success,
    "OUTER_MESSAGE_UPDATE_STRICT").toBe(false);
  expect(piWorkerMessage.safeParse(frame({ assistantMessageEvent: { type: "thinking_delta", delta: "Ithaca", partial } })).success,
    "INNER_ASSISTANT_EVENT_STRICT").toBe(false);
});
