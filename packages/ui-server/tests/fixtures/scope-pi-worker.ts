/** Keyless provider/session fixture behind the actual pi parent pipe adapter. */
import { createInterface } from "node:readline";
let brain = "", sessionId = "", running = false;
const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.type === "init") {
    if ("workerStarted" in message.env) throw Error("Parent lifecycle handle was serialized");
    brain = message.backend.brainPath; sessionId = message.sessionId;
    emit({ type: "ready", sessionId, levels: [], cost: 0 });
  } else if (message.type === "prompt" && !running) {
    running = true;
    const shell = Bun.spawn(["/bin/sh", "-c", 'while :; do printf x >> adapter-heartbeat; sleep 0.02; done'], { cwd: brain, env: { PATH: "/usr/bin:/bin" }, stdout: "ignore", stderr: "pipe" });
    void shell.exited;
    let call = 0;
    const interval = setInterval(() => {
      const toolCallId = `loom-${++call}`;
      emit({ type: "event", event: { type: "tool_execution_start", toolCallId, toolName: "bash", args: { command: "printf Ithaca" } } });
      emit({ type: "event", event: { type: "tool_execution_end", toolCallId, toolName: "bash", result: { content: [{ type: "text", text: "Ithaca" }] }, isError: false } });
      if (call === 4) clearInterval(interval);
    }, 100);
  } else if (message.type === "abort") process.exit(0);
});
