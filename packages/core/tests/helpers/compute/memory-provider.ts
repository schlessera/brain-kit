/**
 * An in-memory ComputeProvider shaped like a hosted vendor: idempotent
 * allocation by key, lookup by key, staging, collection, retention, a remote
 * auto-stop and actual usage from a clock and a rate. Every effect is
 * observable, and faults are injectable per method: a lost response (the
 * effect happens, the answer does not arrive), a transport failure (no
 * effect, outcome unknown), a hang, and failed releases.
 */

import { z } from "zod";

import type {
  CommandHandle,
  CommandStatus,
  ComputeCapabilities,
  ComputeContext,
  ComputeProvider,
  SandboxRef,
} from "../../../src/lib/seams";

type Method = "health" | "allocate" | "find" | "stage" | "exec" | "poll" | "kill" | "collect" | "release" | "usage";

interface Command {
  id: string;
  argv: string[];
  env: Record<string, string>;
  startedAt: number;
  exit?: { code: number | null; signal: string | null; reason: "exited" | "killed" | "oom"; stdout: string; stderr: string };
}

export interface MemorySandbox {
  id: string;
  key: string;
  instanceId: string;
  files: Map<string, Uint8Array>;
  createdAt: number;
  releasedAt: number | null;
  retainedUntil: number | null;
  remoteExpirySeconds: number | undefined;
  commands: Map<string, Command>;
}

export interface MemoryCall {
  method: Method;
  instanceId: string;
  options: unknown;
  secret: string | undefined;
}

export interface MemoryCompute {
  provider: ComputeProvider;
  sandboxes: Map<string, MemorySandbox>;
  calls: MemoryCall[];
  live(): number;
  /** Effects only: allocate calls that created a sandbox. */
  created(): number;
  lose(method: Method): void;
  failTransport(method: Method): void;
  hang(method: Method): void;
  failReleases(count: number): void;
  /** Make the next `method` call throw (a nonconforming provider). */
  throwOn(method: Method): void;
}

export const memoryOptionsSchema = z.object({ region: z.enum(["ithaca", "pylos", "sparta"]).default("ithaca") }).strict();

export interface MemoryComputeOptions {
  clock?: { now(): number };
  capabilities?: Partial<ComputeCapabilities>;
  ratePerHourUsd?: number;
  id?: string;
}

export function memoryCompute(opts: MemoryComputeOptions = {}): MemoryCompute {
  const clock = opts.clock ?? { now: () => Date.now() };
  const capabilities: ComputeCapabilities = {
    commands: true,
    detached: true,
    idempotentAllocate: true,
    findByKey: true,
    stage: { maxBytes: 1024 * 1024 },
    collect: { maxBytes: 1024 * 1024 },
    retain: { maxSeconds: 3600 },
    maxLeaseSeconds: 86_400,
    remoteExpiry: true,
    usage: "actual",
    ...opts.capabilities,
  };
  const sandboxes = new Map<string, MemorySandbox>();
  const calls: MemoryCall[] = [];
  const lost = new Set<Method>();
  const transport = new Set<Method>();
  const hung = new Set<Method>();
  const throwing = new Set<Method>();
  let releaseFailures = 0;
  let created = 0;
  let sequence = 0;

  /** Record the call and apply faults; returns an outcome to use instead, or undefined to proceed. */
  function enter(method: Method, ctx: ComputeContext): { kind: "uncertain"; reason: string } | { kind: "failed"; reason: string } | "hang" | undefined {
    calls.push({ method, instanceId: ctx.instanceId, options: ctx.options, secret: ctx.secret });
    if (throwing.delete(method)) throw new Error(`transport exploded during ${method}`);
    if (hung.delete(method)) return "hang";
    if (ctx.signal.aborted) return { kind: "failed", reason: "aborted before sending" };
    if (transport.delete(method)) return { kind: "uncertain", reason: `connection reset during ${method}` };
    return undefined;
  }
  const never = () => new Promise<never>(() => {});
  const leave = <T>(method: Method, outcome: T): T | { kind: "uncertain"; reason: string } =>
    lost.delete(method) ? { kind: "uncertain", reason: `response to ${method} lost` } : outcome;

  function sandbox(ref: SandboxRef): MemorySandbox | undefined {
    const s = sandboxes.get(ref.id);
    return s && s.releasedAt === null ? s : undefined;
  }

  function statusOf(cmd: Command): CommandStatus {
    if (cmd.exit) return { kind: "exited", ...cmd.exit };
    const [verb, arg] = cmd.argv;
    if (verb === "sleep" && clock.now() < cmd.startedAt + Number(arg) * 1000) return { kind: "running" };
    cmd.exit = { code: 0, signal: null, reason: "exited", stdout: "", stderr: "" };
    return { kind: "exited", ...cmd.exit };
  }

  const provider: ComputeProvider = {
    id: opts.id ?? "memory",
    capabilities,
    configSchema: memoryOptionsSchema,
    async health(ctx) {
      const fault = enter("health", ctx);
      if (fault === "hang") return never();
      return fault?.kind === "uncertain" ? { kind: "unavailable", reason: fault.reason } : { kind: "ok" };
    },
    async allocate(req, ctx) {
      const fault = enter("allocate", ctx);
      if (fault === "hang") return never();
      if (fault) return fault;
      if (capabilities.idempotentAllocate) {
        const existing = [...sandboxes.values()].find((s) => s.key === req.key && s.releasedAt === null);
        if (existing) return leave("allocate", { kind: "ok" as const, sandbox: { id: existing.id } });
      }
      const id = `sbx-${(++sequence).toString().padStart(4, "0")}`;
      created += 1;
      sandboxes.set(id, {
        id,
        key: req.key,
        instanceId: ctx.instanceId,
        files: new Map(),
        createdAt: clock.now(),
        releasedAt: null,
        retainedUntil: null,
        remoteExpirySeconds: req.remoteExpirySeconds,
        commands: new Map(),
      });
      return leave("allocate", { kind: "ok" as const, sandbox: { id } });
    },
    async exec(ref, command, ctx) {
      const fault = enter("exec", ctx);
      if (fault === "hang") return never();
      if (fault) return fault;
      const s = sandbox(ref);
      if (!s) return { kind: "failed", reason: "no such sandbox" };
      const cmd: Command = { id: `cmd-${++sequence}`, argv: command.argv, env: { ...command.env }, startedAt: clock.now() };
      const [verb, ...args] = command.argv;
      if (verb === "exit") cmd.exit = { code: Number(args[0]), signal: null, reason: "exited", stdout: "", stderr: "" };
      else if (verb === "write") {
        s.files.set(args[0], new TextEncoder().encode(args[1]));
        cmd.exit = { code: 0, signal: null, reason: "exited", stdout: "", stderr: "" };
      } else if (verb === "printenv") {
        cmd.exit = { code: 0, signal: null, reason: "exited", stdout: Object.entries(cmd.env).map(([k, v]) => `${k}=${v}`).join("\n"), stderr: "" };
      } else if (verb === "oom") cmd.exit = { code: null, signal: "SIGKILL", reason: "oom", stdout: "", stderr: "out of memory" };
      else if (verb !== "sleep") cmd.exit = { code: 127, signal: null, reason: "exited", stdout: "", stderr: `${verb}: not found` };
      s.commands.set(cmd.id, cmd);
      return leave("exec", { kind: "ok" as const, handle: { sandbox: { id: s.id }, id: cmd.id } });
    },
    async poll(handle: CommandHandle, ctx) {
      const fault = enter("poll", ctx);
      if (fault === "hang") return never();
      if (fault) return fault;
      const cmd = sandboxes.get(handle.sandbox.id)?.commands.get(handle.id);
      if (!cmd) return { kind: "failed", reason: "no such command" };
      return leave("poll", statusOf(cmd));
    },
    async kill(handle, ctx) {
      const fault = enter("kill", ctx);
      if (fault === "hang") return never();
      if (fault) return fault;
      const cmd = sandboxes.get(handle.sandbox.id)?.commands.get(handle.id);
      // A command that already ended on the clock is not killed after the fact.
      if (cmd && statusOf(cmd).kind === "running") cmd.exit = { code: null, signal: "SIGKILL", reason: "killed", stdout: "", stderr: "" };
      return leave("kill", { kind: "ok" as const });
    },
    async release(ref, mode, ctx) {
      const fault = enter("release", ctx);
      if (fault === "hang") return never();
      if (fault) return fault;
      if (releaseFailures > 0) {
        releaseFailures -= 1;
        return { kind: "failed", reason: "the vendor refused to stop the sandbox" };
      }
      const s = sandboxes.get(ref.id);
      if (s && s.releasedAt === null) {
        for (const cmd of s.commands.values()) if (!cmd.exit) cmd.exit = { code: null, signal: "SIGKILL", reason: "killed", stdout: "", stderr: "" };
        s.releasedAt = clock.now();
        if (mode === "retain" && capabilities.retain) s.retainedUntil = clock.now() + capabilities.retain.maxSeconds * 1000;
      }
      if (mode === "retain" && s?.retainedUntil) return leave("release", { kind: "retained" as const, until: s.retainedUntil });
      return leave("release", { kind: "released" as const });
    },
  };
  if (capabilities.findByKey) {
    provider.find = async (key, ctx) => {
      const fault = enter("find", ctx);
      if (fault === "hang") return never();
      if (fault) return fault;
      const s = [...sandboxes.values()].find((x) => x.key === key && x.releasedAt === null);
      return s ? { kind: "ok", sandbox: { id: s.id } } : { kind: "not_found" };
    };
  }
  if (capabilities.stage) {
    provider.stage = async (ref, source, ctx) => {
      const fault = enter("stage", ctx);
      if (fault === "hang") return never();
      if (fault) return fault;
      const s = sandbox(ref);
      if (!s) return { kind: "failed", reason: "no such sandbox" };
      for (const file of source.files) s.files.set(file.path, await file.read());
      return leave("stage", { kind: "ok" as const });
    };
  }
  if (capabilities.collect) {
    provider.collect = async (ref, request, ctx) => {
      const fault = enter("collect", ctx);
      if (fault === "hang") return never();
      if (fault) return fault;
      const s = sandbox(ref);
      if (!s) return { kind: "failed", reason: "no such sandbox" };
      return leave("collect", {
        kind: "ok" as const,
        artifacts: request.paths.map(({ path, maxBytes }) => {
          const data = s.files.get(path);
          if (!data) return { path, status: "missing" as const };
          if (data.byteLength > maxBytes) return { path, status: "too_large" as const, bytes: data.byteLength };
          return { path, status: "collected" as const, data };
        }),
      });
    };
  }
  if (capabilities.usage === "actual") {
    provider.usage = async (ref, ctx) => {
      const fault = enter("usage", ctx);
      if (fault === "hang") return never();
      if (fault) return { usd: null, seconds: null, coverage: "unknown" };
      const s = sandboxes.get(ref.id);
      if (!s || opts.ratePerHourUsd === undefined) return { usd: null, seconds: null, coverage: "unknown" };
      const seconds = ((s.releasedAt ?? clock.now()) - s.createdAt) / 1000;
      return { usd: (opts.ratePerHourUsd * seconds) / 3600, seconds, coverage: s.releasedAt === null ? "partial" : "complete" };
    };
  }

  return {
    provider,
    sandboxes,
    calls,
    live: () => [...sandboxes.values()].filter((s) => s.releasedAt === null).length,
    created: () => created,
    lose: (m) => void lost.add(m),
    failTransport: (m) => void transport.add(m),
    hang: (m) => void hung.add(m),
    failReleases: (n) => void (releaseFailures = n),
    throwOn: (m) => void throwing.add(m),
  };
}

/** argv the memory provider understands, for the contract harness. */
export const memoryCommands = {
  exit: (code: number) => ["exit", String(code)],
  sleep: (seconds: number) => ["sleep", String(seconds)],
  write: (path: string, text: string) => ["write", path, text],
  printEnv: () => ["printenv"],
};
