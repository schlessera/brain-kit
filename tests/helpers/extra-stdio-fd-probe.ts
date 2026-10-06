/**
 * Does collecting a finished `node:child_process` child close an fd number it
 * no longer owns? Spawns with Playwright's Chrome launch shape (stdin ignored,
 * an extra pipe on fd 3), lets the child and its fd-3 socket close, makes the
 * kernel hand that number to an unrelated file, collects garbage and checks
 * the unrelated file. Prints one JSON line: `{ fd, survived }`.
 */
import { spawn } from "node:child_process";
import { closeSync, fstatSync, openSync } from "node:fs";

type Extra = { _handle?: { fd?: number }; resume(): void; destroyed: boolean; once(event: "close", listener: () => void): void };

/** Runs the child in its own scope, so nothing here keeps it reachable. */
async function launch(): Promise<number> {
  const child = spawn("/bin/sh", ["-c", "exit 0"], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
  const extra = child.stdio[3] as unknown as Extra;
  const fd = extra._handle?.fd;
  if (typeof fd !== "number") throw new Error("fd 3 of the child has no parent-side descriptor");
  extra.resume();
  await new Promise((resolve) => child.on("close", resolve));
  await new Promise<void>((resolve) => (extra.destroyed ? resolve() : extra.once("close", resolve)));
  return fd;
}

const fd = await launch();
const opened: number[] = [];
// Each open takes the lowest free number, so this stops at the recycled one.
while (!opened.includes(fd)) {
  if (opened.length > 4096) throw new Error(`fd ${fd} was never recycled`);
  opened.push(openSync(process.execPath, "r"));
}
for (const other of opened) if (other !== fd) closeSync(other);
for (let i = 0; i < 5; i++) {
  Bun.gc(true);
  await Bun.sleep(10);
}
let survived = true;
try {
  fstatSync(fd);
} catch {
  survived = false;
}
console.log(JSON.stringify({ fd, survived }));
