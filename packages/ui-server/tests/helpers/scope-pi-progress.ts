/** Deliberately backlog fixture events until its explicit progress checkpoint. */
import { Transform } from "node:stream";
import type { launchAgentWorker } from "@schlessera/brain-ui-sdk/internal";

export function scopePiProgress(worker: ReturnType<typeof launchAgentWorker>) {
  let pending = "", checkpoint: number | undefined, released = false, continued = false;
  const calls: string[] = [], backlog: string[] = [];
  const stdout = new Transform({ transform(chunk, _encoding, done) {
    try {
      pending += chunk.toString();
      for (let end; (end = pending.indexOf("\n")) >= 0;) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        const message = JSON.parse(line);
        if (message.type === "fixture_checkpoint") {
          checkpoint = message.calls;
          this.push(backlog.splice(0).join(""));
        } else if (message.type === "fixture_continued") continued = true;
        else {
          if (message.type === "event" && message.event.type === "tool_execution_start") calls.push(message.event.toolCallId);
          if (message.type === "event" && checkpoint === undefined) backlog.push(line + "\n");
          else this.push(line + "\n");
        }
      }
      done();
    } catch (error) { done(error as Error); }
  } });
  worker.stdout.pipe(stdout);
  return {
    worker: { ...worker, stdout }, calls,
    get checkpoint() { return checkpoint; },
    get continued() { return continued; },
    release() {
      if (released || worker.stdin.destroyed) return;
      released = true;
      worker.stdin.write(JSON.stringify({ type: "fixture_continue" }) + "\n");
    },
    close() { worker.stdout.unpipe(stdout); stdout.destroy(); worker.stdout.destroy(); },
  };
}
