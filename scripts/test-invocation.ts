/** One fresh build owned by one live test invocation; never cross-run freshness. */
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { selectBuildPackages } from "./publishable-packages";
import { inheritWorkspaceLease, liveAncestor, processIdentity, workspaceLeaseIdentity } from "./workspace-lease.mjs";

const AUTHORITY = "BRAIN_TEST_BUILD_AUTHORITY";
const NONCE = "BRAIN_TEST_INVOCATION_NONCE";
const DELEGATION = "BRAIN_TEST_SPEECH_DELEGATION";
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const positive = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0;
const identity = (root: string) => { const path = realpathSync(root), st = statSync(path); return { path, dev: st.dev, ino: st.ino }; };
const event = (event: string, data: Record<string, unknown> = {}) => console.error(JSON.stringify({ kind: "test-invocation", event, pid: process.pid, at: Date.now(), ...data }));

type Authority = { version: 1; nonce: string; ownerPid: number; ownerStart: string; fd: number; dev: number; ino: number; sha256: string };
type CompletedBuild = { schemaVersion: number; kind: string; pid: number; id: string; state: string; success: boolean; code: number; jobs: number;
  packages: { name: string; state: string; children: { compiler: string; pid: number; code: number; elapsedMs: number }[] }[] };
type InvocationRecord = { version: 1; nonce: string; ownerPid: number; ownerStart: string; root: ReturnType<typeof identity>; lease: NonNullable<ReturnType<typeof workspaceLeaseIdentity>>; build: CompletedBuild };

function readRegular(path: string): { bytes: Buffer; dev: number; ino: number } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size < 2 || before.size > 1_048_576) throw new Error("Invalid invocation receipt file");
    const bytes = readFileSync(fd), after = fstatSync(fd);
    if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Changed invocation receipt");
    return { bytes, dev: before.dev, ino: before.ino };
  } finally { closeSync(fd); }
}

function completedBuild(root: string, build: CompletedBuild, pid: number, id: string, expected?: readonly string[]): boolean {
  if (!build || build.schemaVersion !== 1 || build.kind !== "workspace-build" || build.pid !== pid || build.id !== id ||
      !positive(pid) || !uuid.test(id) || build.state !== "complete" || build.success !== true || build.code !== 0 || build.jobs !== 1 ||
      !Array.isArray(build.packages) || !build.packages.length || build.packages.length > 128) return false;
  const names = build.packages.map(pkg => pkg?.name);
  if (names.some(name => typeof name !== "string") || new Set(names).size !== names.length ||
      (expected && !same(names, expected)) || !same(names, selectBuildPackages(root, names).map(pkg => pkg.dir))) return false;
  return build.packages.every(pkg => pkg.state === "complete" && Array.isArray(pkg.children) &&
    same(pkg.children.map(child => child.compiler), ["tsc", ...(["ui-react", "ui-kit"].includes(pkg.name) ? ["css"] : [])]) &&
    pkg.children.every(child => positive(child.pid) && child.code === 0 && Number.isFinite(child.elapsedMs) && child.elapsedMs >= 0));
}

/** Check the live owner's descriptor, never a pathname from the environment. */
export function invocationBuild(root: string, directories: readonly string[]): InvocationRecord | undefined {
  try {
    if (process.platform !== "linux" || (process.env[AUTHORITY]?.length ?? 0) > 4096) return;
    // Direct Bun watch/hot entrypoints can inherit a live outer locator too.
    if (readFileSync("/proc/self/cmdline", "utf8").split("\0").some(arg => /^(?:--watch|--hot)(?:=|$)/.test(arg))) return;
    const locator = JSON.parse(process.env[AUTHORITY] ?? "null") as Authority | null;
    if (!locator || locator.version !== 1 || !uuid.test(locator.nonce) || locator.nonce !== process.env[NONCE] ||
        !positive(locator.ownerPid) || !positive(locator.fd) || locator.fd < 3 || !/^[0-9a-f]{64}$/.test(locator.sha256) ||
        !liveAncestor(locator.ownerPid, locator.ownerStart)) return;
    const path = `/proc/${locator.ownerPid}/fd/${locator.fd}`;
    const st = statSync(path);
    if (!st.isFile() || st.dev !== locator.dev || st.ino !== locator.ino || st.size < 2 || st.size > 1_048_576) return;
    // /proc's descriptor is deliberately followed; no caller-controlled path is opened.
    const bytes = readFileSync(path);
    if (bytes.length !== st.size || digest(bytes) !== locator.sha256) return;
    const record = JSON.parse(bytes.toString()) as InvocationRecord;
    const lease = workspaceLeaseIdentity(root);
    if (record.version !== 1 || record.nonce !== locator.nonce || record.ownerPid !== locator.ownerPid || record.ownerStart !== locator.ownerStart ||
        !same(record.root, identity(root)) || !lease || lease.mode !== "write" || !same(record.lease, lease) ||
        !completedBuild(root, record.build, record.build?.pid, record.build?.id)) return;
    const built = new Set(record.build.packages.map(pkg => pkg.name));
    if (!selectBuildPackages(root, directories).every(pkg => built.has(pkg.dir))) return;
    const after = statSync(path);
    if (after.dev !== st.dev || after.ino !== st.ino || after.size !== st.size || after.ctimeMs !== st.ctimeMs ||
        !liveAncestor(locator.ownerPid, locator.ownerStart)) return;
    return record;
  } catch { /* Missing, stale or malformed authority always rebuilds in the hook. */ }
}

/** Only the isolated external-speech wrapper may deliberately borrow this run. */
export function externalSpeechDelegation(root: string): NodeJS.ProcessEnv {
  const record = invocationBuild(root, ["ui-react", "ui-server", "core"]);
  return { ...process.env, [DELEGATION]: record ? JSON.stringify({ nonce: record.nonce, pid: process.pid, start: processIdentity(process.pid)?.start }) : "" };
}

export function acceptsSpeechDelegation(root: string, paths: readonly string[]): boolean {
  try {
    if (process.env.BRAIN_EXTERNAL_SPEECH_WORKER !== "1" || paths.length !== 1 ||
        resolve(root, paths[0]!) !== join(root, "packages/ui-react/tests/external-speech-runtime.test.ts")) return false;
    const request = JSON.parse(process.env[DELEGATION] ?? "null");
    const record = invocationBuild(root, ["ui-react", "ui-server", "core"]);
    return Boolean(record && request?.nonce === record.nonce && liveAncestor(request.pid, request.start));
  } catch { return false; }
}

export function clearInvocation(): string {
  delete process.env[AUTHORITY]; delete process.env[DELEGATION];
  return process.env[NONCE] = randomUUID();
}

/** Called after write admission. Caller forwards cancellation throughout build/test. */
export async function prepareInvocation(root: string, directories: readonly string[] | undefined,
  started: (child: ReturnType<typeof Bun.spawn>) => void): Promise<{ code: number; dispose: () => void }> {
  const nonce = process.env[NONCE]!;
  const selected = selectBuildPackages(root, directories).map(pkg => pkg.dir);
  const buildId = randomUUID(), before = performance.now();
  const child = Bun.spawn([process.execPath, join(root, "scripts/build.ts"), ...(directories ? ["--for", directories.join(",")] : [])],
    inheritWorkspaceLease({ cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, BRAIN_TEST_BUILD_ID: buildId } }));
  started(child);
  event("build-start", { nonce, builderPid: child.pid, buildId, packages: selected });
  async function drain(stream: ReadableStream<Uint8Array>, channel: "stdout" | "stderr") {
    let bytes = 0;
    for await (const chunk of stream) { bytes += chunk.length; process[channel].write(chunk); }
    event(`${channel}-complete`, { nonce, builderPid: child.pid, bytes });
  }
  const results = await Promise.allSettled([child.exited.then(code => { event("build-exit", { nonce, builderPid: child.pid, code, signal: child.signalCode }); return code; }),
    drain(child.stdout as ReadableStream<Uint8Array>, "stdout"), drain(child.stderr as ReadableStream<Uint8Array>, "stderr")]);
  const resource = child.resourceUsage();
  const usage = resource ? { cpuUserUs: Number(resource.cpuTime.user), cpuSystemUs: Number(resource.cpuTime.system),
    maxRssBytes: Number(resource.maxRSS) } : undefined;
  const exited = results[0];
  const code = exited.status === "fulfilled" ? exited.value : 1;
  if (code !== 0 || child.signalCode || results.some(result => result.status === "rejected")) {
    event("preparation-failed", { nonce, builderPid: child.pid, code, usage, elapsedMs: performance.now() - before });
    return { code: code || 1, dispose() {} };
  }
  let fd: number | undefined;
  let directory: { path: string; dev: number; ino: number } | undefined;
  let named: { path: string; dev: number; ino: number } | undefined;
  const dispose = () => {
    delete process.env[AUTHORITY];
    const errors: unknown[] = [];
    if (fd !== undefined) { try { closeSync(fd); } catch (error) { errors.push(error); } fd = undefined; }
    if (named) {
      try {
        const current = lstatSync(named.path, { throwIfNoEntry: false });
        if (current) {
          if (!current.isFile() || current.dev !== named.dev || current.ino !== named.ino) throw new Error("Replaced invocation receipt; retained scratch");
          unlinkSync(named.path);
        }
        named = undefined;
      } catch (error) { errors.push(error); }
    }
    if (directory) {
      try {
        const current = lstatSync(directory.path, { throwIfNoEntry: false });
        if (current) {
          if (!current.isDirectory() || current.dev !== directory.dev || current.ino !== directory.ino) throw new Error("Replaced invocation directory; retained scratch");
          // Never recurse: an unrelated entry or failed owned unlink is retained.
          rmdirSync(directory.path);
        }
        directory = undefined;
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Invocation receipt cleanup failed");
  };
  try {
    const receipt = readRegular(join(root, "tmp", `build-${child.pid}-${buildId}-probe.json`));
    const build = JSON.parse(receipt.bytes.toString()) as CompletedBuild;
    const lease = workspaceLeaseIdentity(root), ownerStart = processIdentity(process.pid)?.start;
    if (!completedBuild(root, build, child.pid, buildId, selected) || !lease || lease.mode !== "write" || !ownerStart || !uuid.test(nonce)) throw new Error("Unattested completed preparation");
    const record: InvocationRecord = { version: 1, nonce, ownerPid: process.pid, ownerStart, root: identity(root), lease, build };
    const bytes = JSON.stringify(record);
    const scratch = mkdtempSync(join(tmpdir(), "brain-test-invocation-")), dirStat = lstatSync(scratch);
    directory = { path: scratch, dev: dirStat.dev, ino: dirStat.ino };
    const path = join(scratch, "receipt");
    const writer = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const created = fstatSync(writer);
    named = { path, dev: created.dev, ino: created.ino };
    try { writeFileSync(writer, bytes); } finally { closeSync(writer); }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.dev !== named.dev || st.ino !== named.ino) throw new Error("Replaced invocation receipt before publication");
    unlinkSync(path); named = undefined;
    rmdirSync(scratch); directory = undefined;
    const locator: Authority = { version: 1, nonce, ownerPid: process.pid, ownerStart, fd, dev: st.dev, ino: st.ino, sha256: digest(bytes) };
    process.env[AUTHORITY] = JSON.stringify(locator);
    event("build-attested", { nonce, builderPid: child.pid, buildId, packages: selected, usage, elapsedMs: performance.now() - before });
    return { code: 0, dispose };
  } catch {
    dispose();
    event("build-unattested", { nonce, builderPid: child.pid, usage, elapsedMs: performance.now() - before });
    return { code: 0, dispose() {} };
  }
}

/** Stop this invocation's actual child tree before draining/releasing ownership.
 * Nested wrappers share the enclosing flock/group, so killing only their builder
 * cannot rely on the enclosing group exiting. PID/start pairs bound every signal.
 */
export function invocationChild(child: ReturnType<typeof Bun.spawn>) {
  const start = processIdentity(child.pid)?.start;
  let stopped: Promise<void> | undefined;
  return {
    stop(signal: NodeJS.Signals): Promise<void> {
      if (stopped) return stopped;
      stopped = (async () => {
        if (process.platform !== "linux" || !start) { child.kill(signal); await child.exited; return; }
        if (processIdentity(child.pid)?.start !== start) return;
        const processes = readdirSync("/proc").filter(name => /^\d+$/.test(name)).flatMap(name => {
          const pid = Number(name), state = processIdentity(pid);
          return state ? [{ pid, ...state }] : [];
        });
        const owned = [{ pid: child.pid, start }];
        for (let index = 0; index < owned.length; index++) {
          for (const process of processes) if (process.parent === owned[index]!.pid && !owned.some(item => item.pid === process.pid)) owned.push(process);
        }
        const live = (item: { pid: number; start: string }) => processIdentity(item.pid)?.start === item.start;
        const signalOwned = (signal: NodeJS.Signals) => {
          for (const item of [...owned].reverse()) if (live(item)) {
            try { process.kill(item.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
          }
        };
        signalOwned(signal);
        const grace = Date.now() + 1_000;
        while (owned.some(live) && Date.now() < grace) await Bun.sleep(10);
        if (owned.some(live)) signalOwned("SIGKILL");
        await child.exited;
        const end = Date.now() + 1_000;
        while (owned.some(live) && Date.now() < end) await Bun.sleep(10);
        if (owned.some(live)) throw new Error("Invocation child cleanup incomplete");
      })();
      return stopped;
    },
  };
}
