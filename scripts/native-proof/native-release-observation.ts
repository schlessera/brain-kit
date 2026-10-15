/** Failure-only evidence for the fixed offline fixture's checkpoint reclamation. */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

type Child = { pid: number; exited: Promise<number>; kill(signal?: NodeJS.Signals | number): unknown };
type Root = { id: string; rootId: string; path: string; device: string; inode: string };
const STORE = "/brain-fixture";
const LIMITS = { processes: 256, descriptors: 256, references: 64, mounts: 16, samples: 4 };
function optional<T>(read: () => T): { value: T } | { error: string } {
  try { return { value: read() }; } catch (error) { return { error: String(error).slice(0, 512) }; }
}
function processState(pid: number) {
  return optional(() => ({ stat: readFileSync(`/proc/${pid}/stat`, "utf8").trim().slice(0, 4096), wchan: readFileSync(`/proc/${pid}/wchan`, "utf8").trim().slice(0, 4096) }));
}
function snapshot(root: Root, pid: number) {
  const began = performance.now(), errors: string[] = [], references: object[] = [], mounts: object[] = [];
  const names = readdirSync("/proc").filter(name => /^\d+$/.test(name));
  let descriptorsTruncated = false, referencesTruncated = false, mountsTruncated = false;
  for (const name of names.slice(0, LIMITS.processes)) {
    const processRoot = `/proc/${name}`;
    try {
      const mountState = optional(() => readFileSync(`${processRoot}/mountinfo`, "utf8").split("\n").filter(line => line.includes(root.id)));
      const matches = "value" in mountState ? mountState.value : [];
      if ("error" in mountState) errors.push(mountState.error);
      if (matches.length) {
        mountsTruncated ||= matches.length > LIMITS.mounts;
        if (mounts.length < LIMITS.mounts) mounts.push({ pid: Number(name), rows: matches.slice(0, LIMITS.mounts).map(row => row.slice(0, 4096)) }); else mountsTruncated = true;
      }
      const descriptors = readdirSync(`${processRoot}/fd`); descriptorsTruncated ||= descriptors.length > LIMITS.descriptors;
      for (const fd of descriptors.slice(0, LIMITS.descriptors)) {
        try {
          const path = `${processRoot}/fd/${fd}`, info = statSync(path, { bigint: true });
          const target = readlinkSync(path);
          const deviceMatch = String(info.dev) === root.device, pathMatch = target === root.path || target.startsWith(`${root.path}/`) || target === `${root.path} (deleted)`;
          if (!deviceMatch && !pathMatch) continue;
          if (references.length >= LIMITS.references) { referencesTruncated = true; continue; }
          references.push({ pid: Number(name), fd: Number(fd), device: String(info.dev), inode: String(info.ino), target: target.slice(0, 4096), deviceMatch, pathMatch,
            fdinfo: optional(() => readFileSync(`${processRoot}/fdinfo/${fd}`, "utf8").slice(0, 4096)), process: processState(Number(name)) });
        } catch (error) { if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) errors.push(String(error)); }
      }
    } catch (error) { if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) errors.push(String(error)); }
  }
  return { at: began, wallAt: Date.now(), elapsedMs: performance.now() - began, sync: processState(pid), pathExists: existsSync(root.path), references, mounts,
    coverage: { processesSeen: names.length, processesTruncated: names.length > LIMITS.processes, descriptorsTruncated, referencesTruncated, mountsTruncated }, errors: errors.slice(0, 16).map(error => error.slice(0, 512)) };
}

/** Called only by the real native fixture's existing spawn observer, never production. */
export function nativeReleaseObservations(directory: string) {
  const roots = new Map<string, Root>(), active = new Set<Promise<void>>(), failures: unknown[] = [];
  const abortDescriptor = Object.getOwnPropertyDescriptor(AbortController.prototype, "abort")!;
  let currentAbort: { reason: string; stack: string | undefined } | undefined;
  Object.defineProperty(AbortController.prototype, "abort", { ...abortDescriptor, value: function(this: AbortController, ...args: Parameters<AbortController["abort"]>) {
    const previous = currentAbort;
    currentAbort = { reason: String(args[0]).slice(0, 512), stack: new Error("Native release abort source").stack?.slice(0, 4096) };
    try { return Reflect.apply(abortDescriptor.value, this, args); } finally { currentAbort = previous; }
  } });
  return {
    prepare(argv: readonly string[]): ((child: Child) => void) | undefined {
      if (argv[0] !== "/usr/bin/btrfs" || argv[1] !== "subvolume") return;
      if (argv[2] === "delete" && argv[3] === "--commit-after") {
        const path = argv[4]!, id = basename(path);
        if (path !== join(STORE, ".brain-native/checkpoints", id)) return;
        // The directory is gone by the time sync starts. Its pre-delete native
        // device identifies held files even when another namespace aliases it.
        const info = lstatSync(path, { bigint: true });
        if (statfsSync(path).type !== 0x9123683e) throw Error("Native release observations require the actual Btrfs fixture");
        const intent = JSON.parse(readFileSync(join(STORE, ".brain-native/state", `${id}.json`), "utf8"));
        const rootId = intent.checkpoint?.rootId;
        if (typeof rootId !== "string" || !/^[1-9][0-9]*$/.test(rootId)) throw Error("Native release observation lacks the recorded root identity");
        roots.set(rootId, { id, rootId, path, device: String(info.dev), inode: String(info.ino) });
        return;
      }
      if (argv[2] !== "sync" || argv[3] !== STORE) return;
      const root = roots.get(argv[4]!); if (!root) return;
      return child => {
        const started = performance.now(), samples: ReturnType<typeof snapshot>[] = [], signals: object[] = [];
        const timers = [1_000, 5_000, 15_000].map(delay => setTimeout(() => samples.push(snapshot(root, child.pid)), delay));
        const descriptor = Object.getOwnPropertyDescriptor(child, "kill"), originalKill = child.kill;
        Object.defineProperty(child, "kill", { configurable: true, value(signal?: NodeJS.Signals | number) {
          const evidence = { signal: signal ?? "SIGTERM", at: performance.now(), wallAt: Date.now(), abort: currentAbort, stack: new Error("Native release termination").stack?.slice(0, 4096) };
          const result = originalKill.call(child, signal); signals.push(evidence); return result;
        } });
        const finished = child.exited.then(code => {
          for (const timer of timers) clearTimeout(timer);
          if (descriptor) Object.defineProperty(child, "kill", descriptor); else delete (child as Partial<Child>).kill;
          if (code !== 0 || signals.length) {
            samples.push(snapshot(root, child.pid));
            const output = join(directory, "native-release"); mkdirSync(output, { recursive: true });
            writeFileSync(join(output, `${root.id}.json`), JSON.stringify({ version: 1, root, command: argv, pid: child.pid, started, ended: performance.now(), code,
              signals, limits: LIMITS, samples: samples.slice(0, LIMITS.samples) }, null, 2));
          }
          roots.delete(root.rootId);
        });
        active.add(finished); void finished.catch(error => failures.push(error)).finally(() => active.delete(finished));
      };
    },
    async drain() { await Promise.all([...active]); if (failures.length) throw new AggregateError(failures, "Native release diagnostics failed"); },
    async close() { try { await this.drain(); } finally { Object.defineProperty(AbortController.prototype, "abort", abortDescriptor); } },
  };
}
