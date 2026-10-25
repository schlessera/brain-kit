/**
 * A provider-restricted turn's private, filtered search index (#1668, G2).
 *
 * While a recipient is unproven, every provider folder is masked for a turn.
 * Its `.brain-index/` is then a turn-private directory rather than the real
 * index, which holds the masked documents' bodies. The copy is not filtered
 * after the fact: deleted rows survive in SQLite free pages, FTS5 segments
 * and vector shadow tables. It is built from nothing, by the brain's own CLI,
 * in a worker that sees the brain through the same masks as the turn. The
 * masked documents never enter it.
 *
 * The build is keyword-only (the worker has no provider keys). A build that
 * fails or runs out of time leaves the directory as far as it got: it can
 * only hold what the masked view showed, so the turn starts anyway, and the
 * agent can run `brain index` into it. After the turn the real index is
 * refreshed from Markdown as usual, so captures made in the turn reach it.
 *
 * A complete build is kept as a host-owned base and reused by later turns
 * whose views provably index to the same thing (`private-index-cache.ts`).
 */
import { chmodSync, chownSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { launchAgentWorker, prepareWorkerSandbox, retainWorkerStartupView, workerIdentityHelper, type WorkerStartupView } from "@schlessera/brain-ui-sdk/internal";
import { privateIndexArgv } from "./client.js";

/** How long admission waits for the private index; a slower build leaves a partial index. */
export const PRIVATE_INDEX_BUILD_MS = 120_000;
const OUTPUT_BYTES = 64 * 1024;

/** A host directory outside the brain that only the server and the worker identity can reach. */
export function createPrivateIndexDirectory(): string {
  const separateIdentity = Boolean(workerIdentityHelper());
  const dir = mkdtempSync(join(tmpdir(), "brain-private-index-"));
  try {
    if (separateIdentity) chownSync(dir, process.getuid!(), process.getgid!());
    // The worker identity shares the server's primary group; setgid keeps
    // what it creates in that group so the server can remove it.
    chmodSync(dir, separateIdentity ? 0o2770 : 0o700);
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
  return dir;
}

export function removePrivateIndexDirectory(dir: string): void {
  if (!dir.startsWith(join(tmpdir(), "brain-private-index-"))) throw new Error("not a private index directory");
  rmSync(dir, { recursive: true, force: true });
}

/** Up to `bytes` of a stream as text; `whole` is false when more arrived. */
async function bounded(stream: unknown, bytes: number): Promise<{ text: string; whole: boolean }> {
  if (!stream) return { text: "", whole: true };
  const kept: Uint8Array[] = [];
  let length = 0, whole = true;
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    if (length + chunk.length > bytes) whole = false;
    if (length < bytes) { kept.push(chunk.subarray(0, bytes - length)); length += Math.min(chunk.length, bytes - length); }
  }
  return { text: new TextDecoder().decode(Buffer.concat(kept)), whole };
}

/**
 * Run the brain's own CLI in a credential-free strict worker on the immutable
 * startup view, with `folders` masked, `.git` hidden and only the private
 * index directory writable. Repository code never runs on the host.
 */
export async function runMaskedBrainCli(options: {
  brainPath: string; startupView: WorkerStartupView; folders: readonly string[]; index: string;
  maskPaths: readonly string[]; signal: AbortSignal; timeoutMs: number; command: readonly string[];
  /** Names the run in failure details, such as `brain index`. */
  label: string; outputBytes?: number;
  /** The only brain paths the worker sees, as `WorkerProviderMasks.visible`; default: the whole view. */
  visible?: readonly string[];
}): Promise<{ ok: true; stdout: string } | { ok: false; detail: string; stdout?: string }> {
  options.signal.throwIfAborted();
  const sandbox = { ...prepareWorkerSandbox(options.brainPath, { profile: "strict", areas: [], maskPaths: options.maskPaths }),
    providerMasks: Object.freeze({ folders: Object.freeze([...options.folders]), index: options.index, indexWritable: true,
      ...(options.visible ? { visible: Object.freeze([...options.visible]) } : {}) }) };
  const view = retainWorkerStartupView(options.startupView);
  let worker: ReturnType<typeof launchAgentWorker>;
  try {
    worker = launchAgentWorker({ brainPath: options.brainPath, startupView: view, sandbox,
      env: { PATH: [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"), BRAIN_ROOT: options.brainPath, HOME: "/tmp", NO_COLOR: "1" },
      command: [...options.command] });
  } catch (error) {
    await view.cleanup();
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
  let timedOut = false;
  const stop = () => worker.kill("SIGKILL");
  const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
  options.signal.addEventListener("abort", stop, { once: true });
  try {
    const [stdout, stderr, exit] = await Promise.all([bounded(worker.stdout, options.outputBytes ?? OUTPUT_BYTES), bounded(worker.stderr, OUTPUT_BYTES), worker.exited]);
    options.signal.throwIfAborted();
    if (timedOut) return { ok: false, detail: `${options.label} did not finish within ${options.timeoutMs / 1000} s` };
    if (exit !== 0) return { ok: false, detail: `${options.label} exited ${exit}: ${stderr.text.trim().split("\n").at(-1) ?? ""}`,
      ...(options.outputBytes !== undefined && stdout.whole ? { stdout: stdout.text } : {}) };
    // Output is read only when it is wanted, and then only whole.
    return options.outputBytes === undefined || stdout.whole ? { ok: true, stdout: stdout.text }
      : { ok: false, detail: `${options.label} wrote more than ${options.outputBytes} bytes` };
  } catch (error) {
    // A failed output read must also stop the worker before its pipes settle.
    try { stop(); } catch { /* already gone */ }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", stop);
    await worker.exited.catch(() => {});
    worker.stdin.end();
    // Bun closes its FIFO duplicates on the pool after the output streams end.
    await worker.released();
    options.signal.throwIfAborted();
  }
}

/**
 * Index the masked view into `index`, through the strict immutable startup
 * view: the build reads the brain as the turn will, and writes only its
 * private index directory.
 */
export async function buildPrivateIndex(options: {
  brainPath: string; startupView: WorkerStartupView; folders: readonly string[]; index: string;
  maskPaths: readonly string[]; signal: AbortSignal; timeoutMs?: number;
  /** The CLI argv before `index --json`; default: the brain's own packaged CLI. */
  command?: readonly string[];
}): Promise<{ ok: true } | { ok: false; detail: string }> {
  const built = await runMaskedBrainCli({ ...options, timeoutMs: options.timeoutMs ?? PRIVATE_INDEX_BUILD_MS,
    command: privateIndexArgv(options.brainPath, options.command), label: "brain index" });
  return built.ok ? { ok: true } : built;
}

/**
 * The same `brain index --json` over an index directory that already holds a
 * reused base: the CLI's incremental run adds what is new. Its stats prove
 * that nothing already in the base was rewritten.
 */
export async function updatePrivateIndex(options: Parameters<typeof buildPrivateIndex>[0]): Promise<{ ok: true; stdout: string } | { ok: false; detail: string }> {
  return runMaskedBrainCli({ ...options, timeoutMs: options.timeoutMs ?? PRIVATE_INDEX_BUILD_MS,
    command: privateIndexArgv(options.brainPath, options.command), label: "brain index", outputBytes: OUTPUT_BYTES });
}
