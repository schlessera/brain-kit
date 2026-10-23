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

async function bounded(stream: unknown): Promise<string> {
  if (!stream) return "";
  let text = "";
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    if (text.length < OUTPUT_BYTES) text += new TextDecoder().decode(chunk).slice(0, OUTPUT_BYTES - text.length);
  }
  return text;
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
  options.signal.throwIfAborted();
  const sandbox = { ...prepareWorkerSandbox(options.brainPath, { profile: "strict", areas: [], maskPaths: options.maskPaths }),
    providerMasks: Object.freeze({ folders: Object.freeze([...options.folders]), index: options.index }) };
  const view = retainWorkerStartupView(options.startupView);
  let worker: ReturnType<typeof launchAgentWorker>;
  try {
    worker = launchAgentWorker({ brainPath: options.brainPath, startupView: view, sandbox,
      env: { PATH: [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"), BRAIN_ROOT: options.brainPath, HOME: "/tmp", NO_COLOR: "1" },
      command: privateIndexArgv(options.brainPath, options.command) });
  } catch (error) {
    await view.cleanup();
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
  let timedOut = false;
  const stop = () => worker.kill("SIGKILL");
  const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? PRIVATE_INDEX_BUILD_MS);
  options.signal.addEventListener("abort", stop, { once: true });
  try {
    const [, stderr, exit] = await Promise.all([bounded(worker.stdout), bounded(worker.stderr), worker.exited]);
    options.signal.throwIfAborted();
    if (timedOut) return { ok: false, detail: `the build did not finish within ${(options.timeoutMs ?? PRIVATE_INDEX_BUILD_MS) / 1000} s` };
    return exit === 0 ? { ok: true } : { ok: false, detail: `brain index exited ${exit}: ${stderr.trim().split("\n").at(-1) ?? ""}` };
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", stop);
  }
}
