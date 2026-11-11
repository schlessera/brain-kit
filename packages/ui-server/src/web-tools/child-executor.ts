/**
 * A web executor session as one child process per principal's session
 * (#3685): the process-per-session candidate of
 * `docs/plans/host-owned-web-search.md` ("Common bridge and governance
 * design", item 5). The child speaks newline-delimited JSON on its standard
 * streams; this module owns its whole lifecycle:
 *
 * - It starts in its own process group with exactly the environment it is
 *   given (nothing is inherited) and must announce `ready` in time.
 * - A cancelled call is sent `cancel` and settled at once; the child gets a
 *   grace period to acknowledge before its whole group is killed. A result for
 *   a settled call is discarded.
 * - A malformed or oversized frame, an unknown call id or an early exit ends
 *   the session: every pending call settles as executor death.
 * - Closing sends SIGTERM to the group, then SIGKILL after the grace period,
 *   and reports the exit it observed.
 *
 * Which program runs is the caller's choice: the trusted Pi executor (#3686)
 * and test fixtures. A launch may be prepared per session; its cleanup runs
 * after the group is observed gone and is reported in the exit receipt. No
 * credential handling lives here.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { WebExecutor, WebExecutorExit, WebExecutorRequest, WebExecutorResult, WebExecutorSession } from "./broker.js";

/** What one session's child is started with. */
interface ChildWebExecutorLaunch {
  /** argv of the executor program. */
  command: readonly [string, ...string[]];
  /** The child's whole environment. */
  env: Readonly<Record<string, string>>;
  cwd?: string;
  /** Runs once after the child and its group are gone, before `ended` settles; its result is the receipt's `cleaned`. */
  cleanup?: () => void;
}

interface ChildWebExecutorOptions {
  /** The same launch for every session, or one prepared per principal's session (its own private state). */
  launch: ChildWebExecutorLaunch | ((owner: { principalId: string; sessionId: string }) => ChildWebExecutorLaunch);
  /** How long a started child may take to announce `ready`. */
  startMs?: number;
  /** How long a cancelled call or a closing child is given before the group is killed. */
  graceMs?: number;
  /** Largest frame the child may send, UTF-8 bytes. */
  maxFrameBytes?: number;
}

type Pending = { resolve(result: WebExecutorResult): void; reject(error: Error): void; cancelled: boolean; grace?: ReturnType<typeof setTimeout> };

function alive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try { process.kill(-pid, signal); } catch { /* Already gone. */ }
}

export function createChildWebExecutor(options: ChildWebExecutorOptions): WebExecutor {
  const startMs = options.startMs ?? 10_000, graceMs = options.graceMs ?? 2_000, maxFrameBytes = options.maxFrameBytes ?? 1_048_576;
  return {
    async open(owner, signal) {
      signal.throwIfAborted();
      const launch = typeof options.launch === "function" ? options.launch(owner) : options.launch;
      let child: ChildProcess;
      try {
        child = spawn(launch.command[0], launch.command.slice(1), {
          cwd: launch.cwd, env: { ...launch.env }, stdio: ["pipe", "pipe", "ignore"], detached: true,
        });
      } catch (error) { launch.cleanup?.(); throw error; }
      const pid = child.pid;
      const pending = new Map<string, Pending>();
      let reason: WebExecutorExit["reason"] = "died", ending = false;
      const ended = new Promise<WebExecutorExit>(resolve => {
        child.once("exit", (code, exitSignal) => {
          // The group may outlive its leader: make sure nothing it started survives.
          killGroup(pid, "SIGKILL");
          const deadline = Date.now() + graceMs;
          const settle = () => {
            const gone = !pid || !alive(pid);
            if (!gone && Date.now() < deadline) { setTimeout(settle, 20); return; }
            for (const waiting of pending.values()) { if (waiting.grace) clearTimeout(waiting.grace); waiting.reject(new Error("executor ended")); }
            pending.clear();
            // Private state is removed only once nothing that could still write it is alive.
            let cleaned: boolean | undefined;
            if (launch.cleanup) { try { if (gone) { launch.cleanup(); cleaned = true; } else cleaned = false; } catch { cleaned = false; } }
            resolve({ reason, pid: pid ?? null, code, signal: exitSignal, exited: gone, ...(cleaned === undefined ? {} : { cleaned }) });
          };
          settle();
        });
        child.once("error", () => { if (child.exitCode === null && !child.killed) killGroup(pid, "SIGKILL"); });
      });
      const stop = (why: WebExecutorExit["reason"]) => { if (!ending) { ending = true; reason = why; } killGroup(pid, "SIGKILL"); };
      const send = (frame: unknown) => { try { child.stdin?.write(JSON.stringify(frame) + "\n"); } catch { stop("died"); } };

      const ready = Promise.withResolvers<void>();
      let buffered = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        buffered += chunk;
        if (Buffer.byteLength(buffered) > maxFrameBytes && !buffered.includes("\n")) return stop("died");
        let newline: number;
        while ((newline = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (Buffer.byteLength(line) > maxFrameBytes) return stop("died");
          let frame: any;
          try { frame = JSON.parse(line); } catch { return stop("died"); }
          if (frame?.type === "ready") { ready.resolve(); continue; }
          const waiting = typeof frame?.id === "string" ? pending.get(frame.id) : undefined;
          // A frame for no call this host is waiting on is a protocol break.
          if (!waiting) return stop("died");
          if (frame.type === "cancelled") {
            if (!waiting.cancelled) return stop("died");
            clearTimeout(waiting.grace); pending.delete(frame.id); continue;
          }
          if (frame.type !== "result") return stop("died");
          pending.delete(frame.id);
          if (waiting.grace) clearTimeout(waiting.grace);
          // A result for a call that was already settled is discarded.
          if (waiting.cancelled) continue;
          const extra = frame.handles;
          if (frame.ok === true && typeof frame.text === "string" && (frame.handle === undefined || typeof frame.handle === "string")
            && (extra === undefined || (Array.isArray(extra) && extra.length <= 8 && extra.every((id: unknown) => typeof id === "string" && id)))) {
            waiting.resolve({ ok: true, text: frame.text, ...(frame.handle ? { handle: frame.handle } : {}), ...(extra?.length ? { handles: extra } : {}) });
          } else if (frame.ok === false && ["failed", "unsupported", "unknown_handle"].includes(frame.code) && typeof frame.message === "string") {
            waiting.resolve({ ok: false, code: frame.code, message: frame.message.slice(0, 500), ...(typeof frame.feature === "string" ? { feature: frame.feature } : {}) });
          } else return stop("died");
        }
      });

      const start = setTimeout(() => ready.reject(new Error("The web executor did not start in time.")), startMs);
      const startAbort = () => ready.reject(new Error("The web executor start was cancelled."));
      signal.addEventListener("abort", startAbort, { once: true });
      void ended.then(() => ready.reject(new Error("The web executor exited before it was ready.")));
      try { await ready.promise; }
      catch (error) { stop("start_failed"); await ended; throw error; }
      finally { clearTimeout(start); signal.removeEventListener("abort", startAbort); }

      const session: WebExecutorSession = {
        ended,
        call(request: WebExecutorRequest, callSignal: AbortSignal) {
          return new Promise<WebExecutorResult>((resolve, reject) => {
            if (ending) return reject(new Error("executor ended"));
            const waiting: Pending = { resolve, reject, cancelled: false };
            const cancel = () => {
              if (waiting.cancelled || !pending.has(request.callId)) return;
              waiting.cancelled = true;
              send({ type: "cancel", id: request.callId });
              // Settled now; the child has a grace period to confirm it stopped.
              reject(callSignal.reason instanceof Error ? callSignal.reason : new Error("cancelled"));
              waiting.grace = setTimeout(() => { if (pending.has(request.callId)) stop("cancel_timeout"); }, graceMs);
            };
            pending.set(request.callId, waiting);
            if (callSignal.aborted) return cancel();
            callSignal.addEventListener("abort", cancel, { once: true });
            send({ type: "call", id: request.callId, tool: request.tool, input: request.input, scope: request.scope });
          });
        },
        async close(why) {
          if (!ending) { ending = true; reason = why; }
          killGroup(pid, "SIGTERM");
          const kill = setTimeout(() => killGroup(pid, "SIGKILL"), graceMs);
          try { return await ended; } finally { clearTimeout(kill); }
        },
      };
      return session;
    },
  };
}
