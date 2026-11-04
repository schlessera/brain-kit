/**
 * An SSH-shaped ComputeProvider on the local machine: a sandbox is a fresh
 * directory, a command is a detached process group with its output and exit
 * code in files, kill signals the group, and staging and collection are file
 * copies. Deliberately unlike the memory provider: allocation is NOT
 * idempotent (each call makes a new directory), lookup scans key markers,
 * there is no remote auto-stop and no usage report.
 */

import type { Subprocess } from "bun";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

import type { ComputeCapabilities, ComputeContext, ComputeProvider, SandboxRef } from "../../../src/lib/seams";

const SCRIPT = [
  'src="$0"; out="$1"; shift',
  'cd "$src" || exit 127',
  '"$@" >"$out/stdout" 2>"$out/stderr"',
  "code=$?",
  "printf '%s' \"$code\" >\"$out/exit.tmp\"",
  'mv "$out/exit.tmp" "$out/exit"',
].join("\n");

type Method = "allocate" | "exec" | "poll" | "release";

export interface LocalCompute {
  provider: ComputeProvider;
  workRoot: string;
  live(): number;
  lose(method: Method): void;
  failTransport(method: Method): void;
  /** Make release a no-op that still reports success (a nonconforming provider). */
  breakRelease(): void;
  dispose(): Promise<void>;
}

const pidOf = (data: unknown) => (typeof data === "object" && data !== null && typeof (data as { pid?: unknown }).pid === "number" ? (data as { pid: number }).pid : undefined);

/** Whether any process in the group still runs. */
function groupAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The pids of commands started in a sandbox that never wrote an exit file. */
function pidsIn(dir: string): number[] {
  const cmd = join(dir, "cmd");
  if (!existsSync(cmd)) return [];
  return readdirSync(cmd)
    .filter((id) => existsSync(join(cmd, id, "pid")) && !existsSync(join(cmd, id, "exit")))
    .map((id) => Number(readFileSync(join(cmd, id, "pid"), "utf8")));
}

export function localProcessCompute(workRoot: string): LocalCompute {
  mkdirSync(workRoot, { recursive: true });
  const capabilities: ComputeCapabilities = {
    commands: true,
    detached: true,
    idempotentAllocate: false,
    findByKey: true,
    stage: { maxBytes: 4 * 1024 * 1024 },
    collect: { maxBytes: 4 * 1024 * 1024 },
    retain: { maxSeconds: 600 },
    maxLeaseSeconds: 86_400,
    remoteExpiry: false,
    usage: "none",
  };
  const procs = new Map<string, Subprocess>();
  const lost = new Set<Method>();
  const transport = new Set<Method>();
  let releaseBroken = false;
  let sequence = 0;

  const dirOf = (ref: SandboxRef) => join(workRoot, ref.id);
  const alive = (ref: SandboxRef) => existsSync(dirOf(ref)) && !existsSync(join(dirOf(ref), ".retain-until"));
  const enter = (method: Method, ctx: ComputeContext) => {
    if (ctx.signal.aborted) return { kind: "failed" as const, reason: "aborted before starting" };
    if (transport.delete(method)) return { kind: "uncertain" as const, reason: `ssh channel closed during ${method}` };
    return undefined;
  };
  const leave = <T>(method: Method, outcome: T) => (lost.delete(method) ? { kind: "uncertain" as const, reason: `${method} reply lost` } : outcome);
  const inside = (base: string, rel: string) => {
    const path = normalize(join(base, rel));
    if (!path.startsWith(`${base}/`)) throw new Error(`${rel} escapes the sandbox`);
    return path;
  };

  /** Kill a command's process group, whether this process or an earlier one started it. */
  async function killGroup(key: string, pid?: number): Promise<void> {
    const proc = procs.get(key);
    const group = proc?.pid ?? pid;
    if (group === undefined) return;
    try { process.kill(-group, "SIGKILL"); } catch { /* already gone */ }
    if (proc) await proc.exited;
    else for (let i = 0; i < 100 && groupAlive(group); i++) await Bun.sleep(10);
    procs.delete(key);
  }

  const provider: ComputeProvider = {
    id: "local-process",
    capabilities,
    async health() {
      return existsSync(workRoot) ? { kind: "ok" } : { kind: "unavailable", reason: "work root missing" };
    },
    async allocate(req, ctx) {
      const fault = enter("allocate", ctx);
      if (fault) return fault;
      const dir = mkdtempSync(join(workRoot, "sbx-"));
      mkdirSync(join(dir, "src"));
      mkdirSync(join(dir, "cmd"));
      writeFileSync(join(dir, ".key"), req.key);
      return leave("allocate", { kind: "ok" as const, sandbox: { id: dir.slice(workRoot.length + 1) } });
    },
    async find(key) {
      for (const name of readdirSync(workRoot)) {
        const marker = join(workRoot, name, ".key");
        if (existsSync(marker) && readFileSync(marker, "utf8") === key && !existsSync(join(workRoot, name, ".retain-until"))) {
          return { kind: "ok", sandbox: { id: name } };
        }
      }
      return { kind: "not_found" };
    },
    async stage(ref, source) {
      if (!alive(ref)) return { kind: "failed", reason: "no such sandbox" };
      const src = join(dirOf(ref), "src");
      for (const file of source.files) {
        const path = inside(src, file.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, await file.read());
      }
      return { kind: "ok" };
    },
    async exec(ref, command, ctx) {
      const fault = enter("exec", ctx);
      if (fault) return fault;
      if (!alive(ref)) return { kind: "failed", reason: "no such sandbox" };
      const id = `c${++sequence}`;
      const out = join(dirOf(ref), "cmd", id);
      mkdirSync(out);
      const src = command.cwd ? inside(join(dirOf(ref), "src"), command.cwd) : join(dirOf(ref), "src");
      const proc = Bun.spawn(["sh", "-c", SCRIPT, src, out, ...command.argv], {
        env: { PATH: "/usr/bin:/bin", ...command.env },
        stdio: ["ignore", "ignore", "ignore"],
        detached: true,
      });
      procs.set(`${ref.id}/${id}`, proc);
      writeFileSync(join(out, "pid"), String(proc.pid));
      return leave("exec", { kind: "ok" as const, handle: { sandbox: { id: ref.id }, id, data: { pid: proc.pid } } });
    },
    async poll(handle, ctx) {
      const fault = enter("poll", ctx);
      if (fault) return fault;
      const out = join(workRoot, handle.sandbox.id, "cmd", handle.id);
      const read = (name: string) => (existsSync(join(out, name)) ? readFileSync(join(out, name), "utf8") : "");
      if (existsSync(join(out, "killed"))) return { kind: "exited", code: null, signal: "SIGKILL", reason: "killed", stdout: read("stdout"), stderr: read("stderr") };
      if (existsSync(join(out, "exit"))) {
        await procs.get(`${handle.sandbox.id}/${handle.id}`)?.exited;
        return leave("poll", { kind: "exited" as const, code: Number(read("exit")), signal: null, reason: "exited" as const, stdout: read("stdout"), stderr: read("stderr") });
      }
      const proc = procs.get(`${handle.sandbox.id}/${handle.id}`);
      if (proc ? proc.exitCode === null && proc.signalCode === null : groupAlive(pidOf(handle.data))) return { kind: "running" };
      if (!existsSync(out)) return { kind: "failed", reason: "no such command" };
      return { kind: "exited", code: null, signal: proc?.signalCode ?? null, reason: "signal", stdout: read("stdout"), stderr: read("stderr") };
    },
    async kill(handle) {
      const out = join(workRoot, handle.sandbox.id, "cmd", handle.id);
      if (existsSync(out) && !existsSync(join(out, "exit"))) writeFileSync(join(out, "killed"), "");
      await killGroup(`${handle.sandbox.id}/${handle.id}`, pidOf(handle.data));
      return { kind: "ok" };
    },
    async collect(ref, request) {
      if (!existsSync(dirOf(ref))) return { kind: "failed", reason: "no such sandbox" };
      const src = join(dirOf(ref), "src");
      return {
        kind: "ok",
        artifacts: request.paths.map(({ path, maxBytes }) => {
          const abs = inside(src, path);
          if (!existsSync(abs) || !statSync(abs).isFile()) return { path, status: "missing" as const };
          const bytes = statSync(abs).size;
          if (bytes > maxBytes) return { path, status: "too_large" as const, bytes };
          return { path, status: "collected" as const, data: new Uint8Array(readFileSync(abs)) };
        }),
      };
    },
    async release(ref, mode, ctx) {
      const fault = enter("release", ctx);
      if (fault) return fault;
      if (releaseBroken) return { kind: "released" };
      for (const key of [...procs.keys()]) if (key.startsWith(`${ref.id}/`)) await killGroup(key);
      const dir = dirOf(ref);
      for (const pid of pidsIn(dir)) await killGroup(`${ref.id}/pid-${pid}`, pid);
      if (mode === "retain" && existsSync(dir) && capabilities.retain) {
        const until = Date.now() + capabilities.retain.maxSeconds * 1000;
        writeFileSync(join(dir, ".retain-until"), String(until));
        return leave("release", { kind: "retained" as const, until });
      }
      rmSync(dir, { recursive: true, force: true });
      return leave("release", { kind: "released" as const });
    },
  };

  return {
    provider,
    workRoot,
    live: () => readdirSync(workRoot).filter((name) => alive({ id: name })).length,
    lose: (m) => void lost.add(m),
    failTransport: (m) => void transport.add(m),
    breakRelease: () => void (releaseBroken = true),
    async dispose() {
      for (const key of [...procs.keys()]) await killGroup(key);
      for (const name of existsSync(workRoot) ? readdirSync(workRoot) : []) {
        for (const pid of pidsIn(join(workRoot, name))) await killGroup(`${name}/pid-${pid}`, pid);
      }
      rmSync(workRoot, { recursive: true, force: true });
    },
  };
}

/** argv for the local provider's shell, for the contract harness. */
export const localCommands = {
  exit: (code: number) => ["sh", "-c", `exit ${code}`],
  sleep: (seconds: number) => ["sleep", String(seconds)],
  write: (path: string, text: string) => ["sh", "-c", 'printf "%s" "$1" > "$0"', path, text],
  printEnv: () => ["env"],
};
