/** Preserve native result/control receipts before SDK parsing can throw. */
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { appendFileSync } from "node:fs";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export function observeSurfaceProcess(child: ChildProcessWithoutNullStreams, rawPath: string, observe: (frame: Record<string, any>) => void) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const parse = (line: string) => {
    if (!line.trim()) return;
    let frame: Record<string, any>;
    try { frame = JSON.parse(line); } catch { return; }
    // Observer failures must propagate; swallowing them can miss a stop guard.
    observe(frame);
  };
  const accept = (text: string) => {
    pending += text;
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      parse(pending.slice(0, newline)); pending = pending.slice(newline + 1);
    }
  };
  const tee = new Transform({
    transform(chunk, _encoding, callback) {
      try { appendFileSync(rawPath, chunk, { mode: 0o600 }); accept(decoder.write(chunk)); callback(null, chunk); }
      catch (error) { callback(error as Error); }
    },
    flush(callback) {
      try { accept(decoder.end()); parse(pending); pending = ""; callback(); }
      catch (error) { callback(error as Error); }
    },
  });
  child.stdout.pipe(tee);
  child.stderr.on("data", () => {});
  return { stdin: child.stdin, stdout: tee,
    get killed() { return child.killed; }, get exitCode() { return child.exitCode; }, get signalCode() { return child.signalCode; },
    kill: child.kill.bind(child), on: child.on.bind(child), once: child.once.bind(child), off: child.off.bind(child),
  };
}
