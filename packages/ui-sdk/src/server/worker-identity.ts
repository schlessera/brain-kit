/** Host-only identity broker client. No authority from this module enters a payload. */
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statfsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { workerIdentityHelperInput } from "../config/env.js";
import { WORKER_IDENTITY_CLIENT, WORKER_IDENTITY_FALLBACK, WORKER_IDENTITY_STOP, WORKER_IDENTITY_SUPERVISOR } from "./worker-identity-program.js";

export const WORKER_IDENTITY_HELPER_ENV = "BRAIN_UI_WORKER_IDENTITY_HELPER";
export class WorkerIdentityCleanupError extends Error {
  readonly cleanupUnconfirmed = true;
  constructor(message: string) { super(message); this.name = "WorkerIdentityCleanupError"; }
}
export function workerCleanupUnconfirmed(error: unknown): boolean {
  return typeof error === "object" && error !== null && "cleanupUnconfirmed" in error && error.cleanupUnconfirmed === true;
}
export interface IdentityRoot { name: "state" | "temp"; path: string; bytes: number }
interface Ready { ok: true; workerUid: number; worker: { pid: number; start: string }; roots: Record<string, { fd: number; dev: number; ino: number }> }

/** Resolve only trusted host configuration, never a worker's child environment. */
export function workerIdentityHelper(): string | undefined {
  const raw = workerIdentityHelperInput();
  if (raw === undefined || raw === "") return undefined;
  const value = raw.trim();
  if (!value) throw new Error(`${WORKER_IDENTITY_HELPER_ENV} cannot be whitespace`);
  if (!isAbsolute(value)) throw new Error(`${WORKER_IDENTITY_HELPER_ENV} must be an absolute executable path`);
  const info = lstatSync(value);
  if (!info.isFile() || (info.mode & 0o022) !== 0 || !(info.mode & 0o111) || info.uid !== 0)
    throw new Error(`${WORKER_IDENTITY_HELPER_ENV} must name a root-owned executable that is not group/world writable`);
  return realpathSync(value);
}

/** Original process identity; PID alone never authenticates a retained launch. */
function processIdentity(pid: number): { pid: number; start: string } {
  const fields = readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "").split(" ");
  return { pid, start: fields[19]! };
}

/** Construct the coordinator argv after the unchanged worker-entry descriptor filter. */
export function prepareWorkerIdentity(helper: string, argv: string[], roots: IdentityRoot[], cgroup?: string,
  stage?: { identityTicketFd?: number; namespacePid: number; namespaceStart?: string }) {
  const python = ["/usr/bin/python3", "/bin/python3"].find(path => {
    try { return lstatSync(realpathSync(path)).isFile(); } catch { return false; }
  });
  if (!python) throw new Error("worker_identity_requires_system_python");
  const directory = mkdtempSync(join(tmpdir(), "brain-worker-identity-"));
  const socket = join(directory, "control"), readyPath = join(directory, "ready");
  const secret = crypto.randomUUID();
  const launch = crypto.randomUUID(), server = { ...processIdentity(process.pid), uid: process.getuid?.() };
  let open = true;
  let supervisorIdentity: { pid: number; start: string } | undefined;
  const supervisionLost = () => {
    if (supervisorIdentity !== undefined) {
      // This is our same-UID supervisor. Its kernel-bound launch death path
      // terminates the different-UID worker even when control RPC is lost.
      const stop = Bun.spawnSync([python, "-I", "-S", "-c", WORKER_IDENTITY_STOP, String(supervisorIdentity.pid), supervisorIdentity.start],
        { env: {}, stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 2_000 });
      if (stop.exitCode !== 0) throw new WorkerIdentityCleanupError(`worker_identity_supervisor_stop_unconfirmed: ${stop.stderr.toString().slice(0, 300)}`);
    }
  };
  const fallback = (operations: ("signal" | "cleanup")[]) => {
    if (!supervisorIdentity) throw new Error("worker_identity_supervisor_identity_lost");
    try {
      const receipt = JSON.parse(readFileSync(`${readyPath}.cleanup`, "utf8")) as { ok?: boolean; complete?: boolean; launch?: string; supervisor?: { pid: number; start: string } };
      if (receipt.ok === true && receipt.complete === true && receipt.launch === launch
        && receipt.supervisor?.pid === supervisorIdentity.pid && receipt.supervisor.start === supervisorIdentity.start) return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    supervisionLost();
    const cleanup = Bun.spawnSync([python, "-I", "-S", "-c", WORKER_IDENTITY_FALLBACK, JSON.stringify({
      helper, base: { version: 1, launch, server, supervisor: supervisorIdentity }, operations,
    })], { env: {}, stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 12_000 });
    if (cleanup.exitCode !== 0) throw new WorkerIdentityCleanupError(`worker_identity_cleanup_unconfirmed: ${cleanup.stderr.toString().slice(0, 300)}`);
  };
  const request = <T extends object>(operation: string, input: object = {}): T => {
    if (!open) throw new Error("worker_identity_control_closed");
    const result = Bun.spawnSync([python, "-I", "-S", "-c", WORKER_IDENTITY_CLIENT, socket,
      JSON.stringify({ secret, operation, ...input })], { env: {}, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 7_000 });
    if (result.exitCode !== 0) {
      supervisionLost();
      throw new Error(`worker_identity_control_lost: ${result.stderr.toString().slice(0, 300)}`);
    }
    const reply: unknown = JSON.parse(result.stdout.toString());
    if (!reply || typeof reply !== "object" || !("ok" in reply) || reply.ok !== true)
      throw new Error(`worker_identity_operation_failed: ${JSON.stringify(reply).slice(0, 300)}`);
    return reply as T;
  };
  const requestAsync = async <T extends object>(operation: string, input: object = {}, signal?: AbortSignal): Promise<T> => {
    signal?.throwIfAborted();
    if (!open) throw new Error("worker_identity_control_closed");
    const child = Bun.spawn([python, "-I", "-S", "-c", WORKER_IDENTITY_CLIENT, socket,
      JSON.stringify({ secret, operation, ...input })], { env: {}, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    let cancellationFailure: unknown, cancelled = false;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      try { child.kill("SIGKILL"); } catch (error) { cancellationFailure = error; }
      try { supervisionLost(); } catch (error) { cancellationFailure = error; }
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (cancellationFailure) throw cancellationFailure;
      signal?.throwIfAborted();
      if (code !== 0) { supervisionLost(); throw new Error(`worker_identity_control_lost: ${errors.slice(0, 300)}`); }
      const reply: unknown = JSON.parse(output);
      if (!reply || typeof reply !== "object" || !("ok" in reply) || reply.ok !== true)
        throw new Error(`worker_identity_operation_failed: ${JSON.stringify(reply).slice(0, 300)}`);
      return reply as T;
    } catch (error) {
      if (cancellationFailure) throw cancellationFailure;
      signal?.throwIfAborted();
      throw error;
    } finally { signal?.removeEventListener("abort", cancel); }
  };
  return {
    command: [python, "-I", "-S", "-c", WORKER_IDENTITY_SUPERVISOR, JSON.stringify({
      helper, argv, roots, cgroup, socket, ready: readyPath, secret,
      ...(stage ? { stage: { ...(stage.identityTicketFd === undefined ? {} : { ticketSource: `/proc/${process.pid}/fd/${stage.identityTicketFd}` }),
        keeper: { pid: stage.namespacePid, start: stage.namespaceStart } } } : {}),
      bwrap: Bun.which("bwrap"), server, launch,
    })],
    ready(supervisor: number, deadline: number): Ready {
      supervisorIdentity = processIdentity(supervisor);
      for (;;) {
        try {
          const result = JSON.parse(readFileSync(readyPath, "utf8")) as Ready | { ok: false; reason: string };
          if (!result.ok) throw new Error(result.reason);
          if (!Number.isSafeInteger(result.workerUid) || result.workerUid <= 0 || result.workerUid >= 0xffffffff || result.workerUid === process.getuid?.())
            throw new Error("worker_identity_wrong_uid");
          if (!Number.isSafeInteger(result.worker?.pid) || result.worker.pid <= 1 || typeof result.worker.start !== "string" || !/^[0-9]+$/.test(result.worker.start))
            throw new Error("worker_identity_malformed_worker_identity");
          if (Object.keys(result.roots).length !== roots.length) throw new Error("worker_identity_unexpected_mount_handles");
          for (const root of roots) {
            const receipt = result.roots[root.name];
            if (!receipt || !Number.isSafeInteger(receipt.fd) || receipt.fd < 3 || !Number.isSafeInteger(receipt.dev) || !Number.isSafeInteger(receipt.ino)) throw new Error("worker_identity_missing_mount_handle");
            // This alias belongs to our same-uid coordinator, not the cross-UID payload.
            const descriptor = openSync(`/proc/${supervisor}/fd/${receipt.fd}`, constants.O_RDONLY | constants.O_DIRECTORY);
            try {
              const info = fstatSync(descriptor), space = statfsSync(`/proc/self/fd/${descriptor}`);
              if (info.dev !== receipt.dev || info.ino !== receipt.ino || space.type !== 0x01021994 || space.blocks * space.bsize !== root.bytes)
                throw new Error("worker_identity_substituted_mount");
            } finally { closeSync(descriptor); }
          }
          return result;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          processIdentity(supervisor);
          if (Date.now() >= deadline) throw new Error("worker_identity_setup_timed_out");
          Bun.sleepSync(1);
        }
      }
    },
    request,
    requestAsync,
    terminate() {
      try { request("signal", { signal: "KILL" }); }
      catch { fallback(["signal"]); }
    },
    close() {
      if (!open) return;
      try { request("close"); }
      catch (error) {
        if (!supervisorIdentity) throw error;
        fallback(["signal", "cleanup"]);
      }
      // Failed cleanup retains authority and accounting. A later close may
      // obtain a fresh authenticated receipt after outstanding IO has drained.
      open = false; rmSync(directory, { recursive: true, force: true });
    },
    discard() { open = false; rmSync(directory, { recursive: true, force: true }); },
  };
}
