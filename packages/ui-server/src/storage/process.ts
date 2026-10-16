import { fileURLToPath } from "node:url";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { realpathSync, readFileSync } from "node:fs";
import { wrapCommand, killWrapped, type ExecWrapperConfig } from "@schlessera/brain-ui-sdk/server";
import type { MetadataRoot, MetadataResult } from "./metadata.js";
const inside = (root: string, path: string) => { const rel = relative(root, path); return !rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../")); };
/** Resolve the installed host package's public bin, never a content repository's executable. */
export function storageCli(brainPath: string): string[] {
  const manifestPath = realpathSync(fileURLToPath(import.meta.resolve("@schlessera/brain/package.json")));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== "@schlessera/brain" || typeof manifest.bin?.brain !== "string") throw Error("storage-cli-unavailable");
  const bin = realpathSync(resolve(dirname(manifestPath), manifest.bin.brain)), brain = realpathSync(brainPath);
  if (inside(brain, manifestPath) || inside(brain, bin) || !inside(dirname(manifestPath), bin)) throw Error("storage-cli-untrusted");
  return [process.execPath, "--config=/dev/null", "--no-env-file", bin];
}
/** No shell, inherited secrets, repository config or unbounded stdout. Waits for cancellation cleanup. */
export async function storageProcess(argv: string[], options: { signal: AbortSignal; env?: Record<string, string>; exec?: ExecWrapperConfig; bytes?: number }): Promise<unknown> {
  options.signal.throwIfAborted();
  const exec = options.exec ?? {};
  const child = Bun.spawn(wrapCommand(argv, exec.wrapper), { cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", ...options.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
  let reason: string | null = null, force: ReturnType<typeof setTimeout> | undefined;
  const helperAttempts: Promise<void>[] = [];
  const signal = (value: NodeJS.Signals) => {
    if (exec.wrapper) helperAttempts.push(new Promise<void>(done => {
      killWrapped(child, exec, value, () => { reason = "cancellation-unconfirmed"; }, { helperTimeoutMs: 1000, onComplete: done });
    }));
    else { try { process.kill(-child.pid, value); } catch { child.kill(value); } }
  };
  const stop = (why: string) => { if (reason) return; reason = why; signal("SIGTERM"); force = setTimeout(() => signal("SIGKILL"), 1500); };
  const abort = () => stop("cancelled");
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) abort();
  const timer = setTimeout(() => stop("time-budget"), 32_000);
  let bytes = 0;
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) { bytes += chunk.byteLength; if (bytes > (options.bytes ?? 64 * 1024 * 1024)) { stop("output-budget"); continue; } chunks.push(chunk); }
    return Buffer.concat(chunks).toString("utf8");
  };
  try {
    const [out, , code] = await Promise.all([read(child.stdout), read(child.stderr), child.exited]);
    if (reason || code !== 0) throw Error(reason ?? "collector-unavailable");
    return JSON.parse(out);
  } finally {
    clearTimeout(timer); if (force) clearTimeout(force);
    options.signal.removeEventListener("abort", abort);
    signal("SIGKILL");
    // The shared helper bounds its own cleanup; do not release our scan while
    // an asynchronous cancellation attempt is still running.
    await Promise.allSettled(helperAttempts);
    await child.exited;
  }
}
export async function serverMetadata(roots: MetadataRoot[], signal: AbortSignal, entries: number): Promise<MetadataResult> {
  const source = `import {collectMetadata} from ${JSON.stringify(import.meta.resolve("./metadata.js"))};
const controller=new AbortController();process.once("SIGTERM",()=>controller.abort());
console.log(JSON.stringify(await collectMetadata(${JSON.stringify(roots)},{signal:controller.signal,entries:${entries}})));`;
  return await storageProcess([process.execPath, "--config=/dev/null", "--no-env-file", "-e", source], { signal }) as MetadataResult;
}

/** Isolated supported core query, with the same trusted-installation boundary as inventory. */
export async function storageReferences(brainPath: string, path: string, signal: AbortSignal): Promise<unknown> {
  storageCli(brainPath); // Refuse any host installation redirected into content before loading code.
  const source = `import {createCoreQueryAccess} from ${JSON.stringify(import.meta.resolve("../core-queries.js"))};
const feature=createCoreQueryAccess().storage?.();
console.log(JSON.stringify(feature?.ok?feature.queries.readStorageReferences(${JSON.stringify({ brainPath, path })}):{ok:false}));`;
  return storageProcess([process.execPath, "--config=/dev/null", "--no-env-file", "-e", source], { signal, bytes: 1024 * 1024 });
}
