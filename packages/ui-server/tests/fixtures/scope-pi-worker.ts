/** Keyless provider/session fixture behind the actual pi parent pipe adapter. */
import { createInterface } from "node:readline";
import { join } from "node:path";
let brain = "", sessionId = "", running = false;
// The test pipe acknowledges this checkpoint before delivering its backlog.
// Only the parent, after observation and accepted Continue, releases the rest.
const PAUSE_AFTER_CALL = Number(process.env.SCOPE_FIXTURE_CHECKPOINT ?? "2");
let continueFixture!: () => void;
const continuation = new Promise<void>(done => { continueFixture = done; });
const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
createInterface({ input: process.stdin }).on("line", async line => {
  const message = JSON.parse(line);
  if (message.type === "init") {
    if ("workerStarted" in message.env) throw Error("Parent lifecycle handle was serialized");
    brain = message.backend.brainPath; sessionId = message.sessionId;
    emit({ type: "ready", sessionId, levels: [], cost: 0 });
  } else if (message.type === "prompt" && !running) {
    running = true;
    const heartbeat = join(process.env.BRAIN_WORKER_SCRATCH!, "adapter-heartbeat");
    const shell = Bun.spawn(["/bin/sh", "-c", 'while :; do printf x >> "$1"; sleep 0.02; done', "heartbeat", heartbeat], { cwd: brain, env: { PATH: "/usr/bin:/bin" }, stdout: "ignore", stderr: "inherit" });
    void shell.exited;
    const deadline = performance.now() + 2_000;
    while (Bun.file(heartbeat).size < 2) {
      if (performance.now() > deadline) throw Error("SCOPE_ADAPTER_HEARTBEAT_DID_NOT_GROW");
      await Bun.sleep(1);
    }
    for (let call = 1; call <= 4; call++) {
      const toolCallId = `loom-${call}`;
      emit({ type: "event", event: { type: "tool_execution_start", toolCallId, toolName: "bash", args: { command: "printf Ithaca" } } });
      emit({ type: "event", event: { type: "tool_execution_end", toolCallId, toolName: "bash", result: { content: [{ type: "text", text: "Ithaca" }] }, isError: false } });
      if (call === PAUSE_AFTER_CALL) {
        emit({ type: "fixture_checkpoint", calls: call });
        await continuation;
      }
    }
  } else if (message.type === "fixture_continue") {
    emit({ type: "fixture_continued" }); continueFixture();
  } else if (message.type === "abort") process.exit(0);
});
