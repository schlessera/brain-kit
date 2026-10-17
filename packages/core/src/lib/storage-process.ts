import { collectStorageInventory, STORAGE_LIMITS, type StorageInventory } from "./storage-inventory.js";

/** Isolate blocking filesystem calls from the CLI coordinator. No writable state or config loading. */
export async function collectStorageProcess(root: string, gitRoots: readonly string[], signal: AbortSignal): Promise<StorageInventory> {
  if (signal.aborted || process.platform !== "linux") return collectStorageInventory(root, { signal });
  const startedAt = new Date().toISOString();
  const source = `import {collectStorageInventory} from ${JSON.stringify(import.meta.resolve("./storage-inventory.js"))};
const controller=new AbortController();
process.once("SIGTERM",()=>controller.abort());
process.once("SIGINT",()=>controller.abort());
console.log(JSON.stringify(await collectStorageInventory(${JSON.stringify(root)},{gitRoots:${JSON.stringify(gitRoots)},signal:controller.signal})));`;
  const child = Bun.spawn([process.execPath, "--config=/dev/null", "--no-env-file", "-e", source], { stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
  let reason: string | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already reaped */ } };
  const stop = (why: string) => {
    if (reason) return;
    reason = why;
    child.kill("SIGTERM");
    killTimer = setTimeout(kill, 500);
  };
  const cancel = () => stop("cancelled");
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const timer = setTimeout(() => stop("time-budget"), STORAGE_LIMITS.milliseconds);
  let bytes = 0;
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      bytes += chunk.byteLength;
      if (bytes > 64 * 1024 * 1024) { stop("output-budget"); continue; }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  };
  try {
    const [out, , code] = await Promise.all([read(child.stdout), read(child.stderr), child.exited]);
    if (code === 0 && !reason) return JSON.parse(out) as StorageInventory;
    // A terminated walker cannot certify that an unflushed subtotal is complete.
    // Return explicit empty lower-bound evidence, never success or fabricated usage.
    const aborted = new AbortController(); aborted.abort();
    const result = await collectStorageInventory(root, { signal: aborted.signal });
    result.startedAt = startedAt;
    result.errors = [{ path: "", reason: reason ?? "collector-failed" }];
    return result;
  } finally {
    clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
    signal.removeEventListener("abort", cancel);
    kill(); await child.exited;
  }
}
