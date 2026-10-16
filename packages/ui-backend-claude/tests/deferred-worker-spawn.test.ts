import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { deferredWorkerSpawn } from "../src/deferred-worker-spawn.js";

function gate() { let release!: () => void; const ready = new Promise<void>(resolve => { release = resolve; }); return { ready, release }; }
function echoWorker() {
  const process = spawn("/bin/cat", [], { stdio: ["pipe", "pipe", "ignore"] });
  return { process, settled: once(process, "exit").then(() => {}) };
}
async function read(stream: AsyncIterable<Buffer | string>) { const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); }

test("SDK streams backpressure while native preparation waits, then drain through a real child", async () => {
  const hold = gate(); let spawns = 0;
  const deferred = deferredWorkerSpawn(async signal => { await hold.ready; signal.throwIfAborted(); spawns++; return echoWorker(); }, []);
  const errors: unknown[] = []; deferred.process.on("error", error => errors.push(error));
  const output = read(deferred.process.stdout);
  const bytes = Buffer.alloc(256 * 1024, 65);
  expect(deferred.process.stdin.write(bytes), "NATIVE_PENDING_SPAWN_BACKPRESSURE").toBe(false);
  deferred.process.stdin.end();
  await Promise.resolve(); expect(spawns).toBe(0);
  hold.release();
  try {
    expect(await output).toEqual(bytes); await deferred.settled;
    expect(spawns).toBe(1); expect(errors).toEqual([]); expect(deferred.process.exitCode).toBe(0);
  } finally { deferred.process.kill("SIGKILL"); await deferred.settled.catch(() => {}); }
});

test("cancellation during preparation starts no late worker and settles once", async () => {
  const hold = gate(); let spawns = 0;
  const deferred = deferredWorkerSpawn(async signal => { await hold.ready; signal.throwIfAborted(); spawns++; return echoWorker(); }, []);
  const exits: unknown[] = []; deferred.process.on("exit", (code, signal) => exits.push([code, signal]));
  deferred.process.on("error", () => {});
  await Promise.resolve(); deferred.process.kill("SIGKILL"); hold.release();
  await expect(deferred.settled).rejects.toThrow("cancelled");
  expect(spawns, "NATIVE_CANCEL_NEVER_STARTS_LATE_WORKER").toBe(0);
  expect(exits).toEqual([[null, "SIGKILL"]]); expect(deferred.process.killed).toBe(true);
});

test("a late owned child is killed and awaited even if preparation ignored cancellation", async () => {
  const hold = gate(); let child: ReturnType<typeof echoWorker> | undefined;
  const deferred = deferredWorkerSpawn(async () => { await hold.ready; return child = echoWorker(); }, []);
  deferred.process.on("error", () => {});
  await Promise.resolve(); deferred.process.kill("SIGKILL"); hold.release();
  await deferred.settled;
  expect(child!.process.signalCode, "NATIVE_LATE_CHILD_RECLAIMED").toBe("SIGKILL");
  expect(deferred.process.signalCode).toBe("SIGKILL");
});

test("preparation refusal reaches the SDK error and exit channels without spawning", async () => {
  const deferred = deferredWorkerSpawn(async () => { throw new Error("Odysseus native capacity refused"); }, []);
  const errors: string[] = [], exits: unknown[] = [];
  deferred.process.on("error", error => errors.push(error.message));
  deferred.process.on("exit", (code, signal) => exits.push([code, signal]));
  await expect(deferred.settled).rejects.toThrow("capacity refused");
  expect(errors).toEqual(["Odysseus native capacity refused"]); expect(exits).toEqual([[1, null]]);
});
