import { fileURLToPath } from "node:url";
import { dirname, relative, isAbsolute } from "node:path";
import { realpathSync, readFileSync } from "node:fs";
import type { MetadataRoot, MetadataResult } from "./metadata.js";
const inside = (root: string, path: string) => { const rel = relative(root, path); return !rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../")); };
/** Verify the installed public reader, never code or executables from content. */
function coreReader(brainPath: string, subpath: "storage" | "queries"): string {
  const manifestPath = realpathSync(fileURLToPath(import.meta.resolve("@schlessera/brain/package.json")));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== "@schlessera/brain") throw Error("storage-reader-unavailable");
  const entry = realpathSync(fileURLToPath(import.meta.resolve(`@schlessera/brain/${subpath}`))), brain = realpathSync(brainPath);
  if (inside(brain, manifestPath) || inside(brain, entry) || !inside(dirname(manifestPath), entry)) throw Error("storage-reader-untrusted");
  return entry;
}
export async function coreMetadata(brainPath: string, gitRoots: string[], signal: AbortSignal): Promise<unknown> {
  const source = `import {readStorageInventory} from ${JSON.stringify(coreReader(brainPath, "storage"))};
const controller=new AbortController();process.once("SIGTERM",()=>controller.abort());
console.log(JSON.stringify(await readStorageInventory({...${JSON.stringify({ brainPath, gitRoots })},signal:controller.signal})));`;
  return storageProcess([process.execPath, "--config=/dev/null", "--no-env-file", "-e", source], { signal });
}
/** No shell, inherited secrets, repository config or unbounded stdout. Waits for cancellation cleanup. */
export async function storageProcess(argv: string[], options: { signal: AbortSignal; bytes?: number }): Promise<unknown> {
  options.signal.throwIfAborted();
  const child = Bun.spawn(argv, { cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
  let reason: string | null = null, force: ReturnType<typeof setTimeout> | undefined;
  const signal = (value: NodeJS.Signals) => {
    try { process.kill(-child.pid, value); } catch { child.kill(value); }
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
  coreReader(brainPath, "queries"); // Refuse installation redirects into content.
  const source = `import {createCoreQueryAccess} from ${JSON.stringify(import.meta.resolve("../core-queries.js"))};
const feature=createCoreQueryAccess().storage?.();
console.log(JSON.stringify(feature?.ok?feature.queries.readStorageReferences(${JSON.stringify({ brainPath, path })}):{ok:false}));`;
  return storageProcess([process.execPath, "--config=/dev/null", "--no-env-file", "-e", source], { signal, bytes: 1024 * 1024 });
}
