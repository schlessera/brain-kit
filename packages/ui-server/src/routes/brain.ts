import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { probeBrainCliVersion, type BrainClient } from "../brain/client.js";
import { brainCommandClass, createHostBoundary, type HostBoundary, type StreamingExecution } from "../brain/host-boundary.js";
import type { Logger } from "@opentelemetry/api-logs";
import { subprocessEnv } from "../config/env.js";
import type { ExecWrapperConfig } from "@schlessera/brain-ui-sdk/server";
import {
  buildKeyterms,
  writeCache,
  type KeytermSettings,
} from "../voice/keyterm-builder.js";
import { realpathSync } from "fs";
import { readJsonBody } from "../middleware/body-limit.js";
import { requireJson } from "../middleware/origin.js";
import type { AppEnv } from "../app-env.js";
import type { AwaitableActivityStore } from "../activity/store.js";
import { observeWrite } from "../activity/store-writes.js";
import { GOVERNANCE_POLICY_PATH } from "@schlessera/brain-common/internal/governance-policy";
import { OwnerPolicyReviewError, type OwnerPolicyProposal, type OwnerPolicyReviews } from "../brain/owner-policy-reviews.js";
import type { IncomingPolicyChange } from "../brain/sync-mirror.js";

/**
 * How long a UI sync may take from admission until its process has started
 * (#4257): the CLI probe, the writer gate and the worker launch. Past it the
 * sync is refused by name and the brain is free again; a sync that has
 * started is never bounded here.
 */
const SYNC_LAUNCH_TIMEOUT_MS = 120_000;
/** How long a sync's output may keep its pipes open after the process has exited. */
const SYNC_OUTPUT_GRACE_MS = 10_000;
/** Combined output kept on a UI sync's Activity run, as a cron job keeps its own. */
const SYNC_OUTPUT_TAIL_CHARS = 8_000;
/** Non-empty output lines named in a failed UI sync's run reason and log line. */
const SYNC_ERROR_LINES = 5;

interface BrainRoutesDeps {
  /**
   * App-owned admission state, each admitted canonical root with when it was
   * admitted; the host boundary still coordinates repository writers.
   */
  syncingRoots?: Map<string, number>;
  /** @internal The launch bound; {@link SYNC_LAUNCH_TIMEOUT_MS} when omitted. */
  syncLaunchTimeoutMs?: number;
  /** @internal The output grace after exit; {@link SYNC_OUTPUT_GRACE_MS} when omitted. */
  syncOutputGraceMs?: number;
  /** Where each UI sync records its run (#4257), as scheduled syncs do. Fail-open. */
  activity?: AwaitableActivityStore;
  /**
   * Host-owned reviews of a policy change a sync's pull brings in (#4256).
   * Absent: such a sync fails, naming the waiting change.
   */
  policyReviews?: OwnerPolicyReviews;
  brainCliMinimum?: string;
  log?: Logger;
  brain: BrainClient;
  brainPath: string;
  keyterms: KeytermSettings;
  /** @internal The host execution boundary (#1648); omitted, the routes build their own. */
  boundary?: HostBoundary;
  /** The app's configured exec wrapper; the streaming sync spawns through it. */
  exec: ExecWrapperConfig;
}

class SyncLaunchTimeout extends Error {
  constructor(ms: number) {
    super(`Sync did not start within ${Math.round(ms / 1000)} s (the brain's writer may be busy, or the sync worker did not start). Nothing ran; try again.`);
  }
}

/** The last few non-empty lines of a sync's output: what a failure says. */
function lastLines(output: string, count: number): string {
  return output.split("\n").map(line => line.trim()).filter(Boolean).slice(-count).join("\n");
}

/**
 * Read a stream line by line, handing each non-empty line to `line` in order.
 * `idleSince` is when the current read started while it waits for data with
 * nothing pending, null while a line is being handled: it tells a pipe held
 * open apart from output still being delivered.
 */
function drainLines(stream: ReadableStream<Uint8Array>, line: (text: string) => unknown) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "", waiting: number | null = null, finished = false;
  const done = (async () => {
    try {
      while (true) {
        waiting = Date.now();
        const { done, value } = await reader.read();
        waiting = null;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const text of lines) if (text.trim()) await line(text);
      }
      if (buffer.trim()) await line(buffer);
    } catch {} finally { waiting = null; finished = true; }
  })();
  return {
    done,
    finished: () => finished,
    idleSince: () => waiting,
    cancel: () => reader.cancel().catch(() => {}),
  };
}

export function createBrainRoutes(deps: BrainRoutesDeps): Hono<AppEnv> {
  const { brain, brainPath, keyterms } = deps;
  const syncingRoots = deps.syncingRoots ?? new Map<string, number>();
  const launchTimeoutMs = deps.syncLaunchTimeoutMs ?? SYNC_LAUNCH_TIMEOUT_MS;
  const outputGraceMs = deps.syncOutputGraceMs ?? SYNC_OUTPUT_GRACE_MS;
  const boundary = deps.boundary ?? createHostBoundary({ brainPath, exec: deps.exec });
  let indexing: Promise<void> | null = null;
  /**
   * A UI sync's Activity run (#4257), so its outcome outlives the stream: a
   * reader that disconnected is exactly the one who did not see the result.
   * Recording is fail-open and never stops the sync it observes.
   */
  function startSyncRun(principalId: string | undefined) {
    const store = deps.activity;
    const unavailable = (error: unknown) => deps.log?.emit({ severityText: "WARN", body: "ui sync activity unavailable",
      attributes: { error: error instanceof Error ? error.message : String(error) } });
    const runId = `ui-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, spanId = `${runId}:root`;
    let started = false;
    if (store) {
      try {
        observeWrite(store.startSpan({ spanId, runId, name: "cron ui-sync", kind: "cron", origin: "cron", jobName: "ui-sync", principalId }), unavailable);
        started = true;
      } catch (error) { unavailable(error); }
    }
    return {
      end(failure: string | undefined, output: string, paused?: string) {
        if (failure !== undefined) deps.log?.emit({ severityText: "ERROR", body: "ui sync failed", attributes: { error: failure.slice(0, 2_000) } });
        else if (paused !== undefined) deps.log?.emit({ severityText: "INFO", body: "ui sync paused for policy review", attributes: { reason: paused } });
        if (!store || !started) return;
        try {
          if (output) observeWrite(store.appendEvent(spanId, "job_output", output, undefined, SYNC_OUTPUT_TAIL_CHARS), unavailable);
          // A paused sync is not a failure (#4256): `cancelled` is the taxonomy's non-failure stop, with its reason.
          observeWrite(store.endSpan(spanId, failure !== undefined ? { outcome: "error", reason: failure }
            : paused !== undefined ? { outcome: "cancelled", reason: paused } : { outcome: "success" }), unavailable);
          observeWrite(store.rollupRun(runId), unavailable);
        } catch (error) { unavailable(error); }
      },
    };
  }

  /** Open the owner's review of an incoming policy change; never writes. */
  async function openPolicyReview(principalId: string, change: IncomingPolicyChange) {
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(change.content); }
    catch { return { ok: false as const, message: `The incoming ${GOVERNANCE_POLICY_PATH} is not UTF-8 text, so it cannot be reviewed. Revert the upstream commit that changes it.` }; }
    // Truthful whatever made the stage differ: the review offers exactly the upstream commit's own version.
    const rationale = `The brain's remote has a different ${GOVERNANCE_POLICY_PATH}${change.upstream ? ` at commit ${change.upstream.slice(0, 12)}` : ""}. Approving adopts that version, and the next sync completes.`;
    try {
      // This sync's review is the current one: an older unanswered sync review is declined, never left to fill the cap.
      await deps.policyReviews!.supersede(principalId);
      return { ok: true as const, proposal: await deps.policyReviews!.propose(principalId, () => text, undefined, rationale,
        `The incoming policy did not validate, so nothing was proposed. Revert the upstream commit that changes ${GOVERNANCE_POLICY_PATH}, or fix it there`) };
    } catch (error) {
      return { ok: false as const, message: error instanceof Error ? error.message : "The incoming policy change could not be reviewed." };
    }
  }

  return new Hono<AppEnv>()
  .get("/brain/search", async (c) => {
    const q = c.req.query("q");
    if (!q) {
      return c.json({ error: "Query parameter 'q' is required" }, 400);
    }
    try {
      const { results, warnings } = await brain.search(q, {
        type: c.req.query("type"),
        tag: c.req.query("tag"),
        limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
        mode: c.req.query("mode"),
        signal: c.req.raw.signal,
      });
      return c.json({ results, warnings });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Search failed" },
        err instanceof Error && err.name === "TimeoutError" ? 504 : 500
      );
    }
  })

  .get("/brain/briefing", async (c) => {
    try {
      const content = await brain.briefing();
      return c.json({ content });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Briefing failed" },
        500
      );
    }
  })

  .get("/brain/stats", async (c) => {
    try {
      const stats = await brain.stats();
      return c.json(stats);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Stats failed" },
        500
      );
    }
  })

  .get("/brain/stats/history", async (c) => {
    try {
      return c.json(await brain.statsHistory());
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Stats history failed" },
        500
      );
    }
  })

  .get("/brain/list", async (c) => {
    try {
      const results = await brain.list({
        type: c.req.query("type"),
        tag: c.req.query("tag"),
        status: c.req.query("status"),
        relevance: c.req.query("relevance"),
        limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
      });
      return c.json({ results });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "List failed" },
        500
      );
    }
  })

  .post("/brain/sync", async (c) => {
    // Stream sync output via SSE so the client sees live progress.
    // brain sync spawns a nested Claude Code process that can take minutes.

    const syncRoot = realpathSync(brainPath);
    const since = syncingRoots.get(syncRoot);
    if (since !== undefined) {
      const heldMs = Math.max(0, Date.now() - since);
      return c.json({ error: `A sync is already running (it has held the brain for ${Math.floor(heldMs / 1000)} s). Wait for it to finish before retrying.`, heldMs }, 409);
    }
    syncingRoots.set(syncRoot, Date.now());
    const run = startSyncRun(c.get("principal")?.id);
    return streamSSE(c, async (stream) => {
      let keepalive: ReturnType<typeof setInterval> | undefined;
      let disconnected = false;
      let output = "";
      let failure: string | undefined;
      let paused: string | undefined;
      stream.onAbort(() => { disconnected = true; });
      const send = (data: {
        type: string;
        text?: string;
        success?: boolean;
        reason?: string;
      } | ({ type: "policy_review" } & OwnerPolicyProposal)) => {
        if (data.type === "progress" && "text" in data && data.text) output = (output + data.text + "\n").slice(-SYNC_OUTPUT_TAIL_CHARS);
        return disconnected ? Promise.resolve() : stream.writeSSE({ data: JSON.stringify(data) })
          .catch(() => { disconnected = true; });
      };

      try {
        await send({ type: "start", text: "Starting brain sync..." });

        // The nested Claude process can be silent for minutes; without traffic
        // the socket gets cut by idle timeouts (Bun's own, or a proxy's). SSE
        // comment lines are ignored by EventSource and data-line parsers.
        keepalive = setInterval(() => {
          stream.write(": keepalive\n\n").catch(() => {});
        }, 15_000);

        // Merge stderr into stdout — brain sync spawns a nested Claude Code
        // process whose output goes to stderr. The command comes from
        // brain.cliCommand() (packaged bin or legacy vendored script), passed to
        // bash as positional args rather than interpolated into the script, so a
        // BRAIN_PATH containing spaces or shell metacharacters stays inert.
        const command = brain.cliCommand();
        // Everything before the process starts is bounded (#4257): a probe or
        // launch that never settles must not hold the brain until a restart.
        const launching = new AbortController();
        let incoming: IncomingPolicyChange | undefined;
        let markStarted!: () => void;
        const started = new Promise<void>(resolve => { markStarted = resolve; });
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let launched: StreamingExecution | undefined;
        const bound = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true; launching.abort();
            // A launch that returned but never started its work is stopped now.
            if (launched) { launched.kill("SIGTERM"); void launched.exited.catch(() => {}); }
            reject(new SyncLaunchTimeout(launchTimeoutMs));
          }, launchTimeoutMs);
        });
        const start = (async () => {
          if (deps.brainCliMinimum !== undefined) {
            await probeBrainCliVersion(brainPath, deps.log ?? { emit() {}, enabled: () => false }, { exec: deps.exec, minimumVersion: deps.brainCliMinimum, phase: "streaming sync invocation", command, boundary, signal: launching.signal });
          }
          launching.signal.throwIfAborted();
          const [cliBin, ...cliArgs] = command;
          // Through the host boundary (#1648): a credentialed maintenance worker
          // holding the writer gate exclusively while the boundary holds.
          const proc = await boundary.launch({
            // `--human`: stdout is a pipe, which would make it the JSON
            // result (#290); this route streams the readable report.
            argv: ["bash", "-c", '"$0" "$@" 2>&1', cliBin!, ...cliArgs, "sync", "--human"],
            env: subprocessEnv("brainCli", { NO_COLOR: "1" }),
            ...brainCommandClass(["sync"]),
            purpose: "brain sync",
            sync: true,
            signal: launching.signal,
            onExecute: () => markStarted(),
            ...(deps.policyReviews ? { onPolicyChange: (change: IncomingPolicyChange) => { incoming = change; } } : {}),
          });
          launched = proc;
          // A launch that settles after its bound was already refused: stop it.
          if (timedOut) { proc.kill("SIGTERM"); void proc.exited.catch(() => {}); return proc; }
          // A hosted sync's launch returns before its mirror lock, startup
          // view and origin probe: the bound holds until its first worker
          // starts, or the attempt ends before one does.
          await Promise.race([started, proc.exited.then(() => {}, () => {})]);
          return proc;
        })();
        start.catch(() => {});
        let proc: Awaited<typeof start>;
        try { proc = await Promise.race([start, bound]); }
        finally { clearTimeout(timer); }

        // Keep draining even when the SSE reader disconnects. The repository
        // stays reserved until the actual sync process has exited.
        const stdout = drainLines(proc.stdout, line => send({ type: "progress", text: line }));
        // stderr is sent as one block once it ends, as before.
        let stderrText = "";
        const stderr = drainLines(proc.stderr, line => { stderrText += `${line}\n`; });
        const stderrDone = stderr.done.then(() => stderrText.trim() ? send({ type: "progress", text: stderrText.trim() }) : undefined);

        const exitCode = await proc.exited;
        // A descendant that outlives the sync can hold its output pipes open
        // (#4257). Once the process has exited, the brain is released when
        // every unfinished pipe has sat open with nothing to read for the
        // grace period. Time spent delivering output to a slow reader never
        // counts, so nothing the sync wrote is cut off.
        const exitedAt = Date.now();
        await new Promise<void>(resolve => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const finish = () => { clearTimeout(timer); resolve(); };
          void Promise.all([stdout.done, stderrDone]).then(finish, finish);
          const check = () => {
            const idle = [stdout, stderr].filter(pipe => !pipe.finished()).map(pipe => pipe.idleSince());
            // Idle time counts from the exit at the earliest: a read that began
            // during a silent stretch before it says nothing about the pipe.
            if (idle.length && idle.every(since => since !== null && Date.now() - Math.max(since, exitedAt) >= outputGraceMs)) return finish();
            timer = setTimeout(check, Math.max(1, Math.min(250, outputGraceMs)));
          };
          check();
        });
        clearInterval(keepalive);
        // Never awaited: a boundary's cancel can itself drain to EOF, keeping
        // the writer gate until the descendant lets go (the next sync waits on
        // that gate within its own launch bound), but not this reservation.
        void stdout.cancel(); void stderr.cancel();

        // Rebuild voice keyterms cache after a successful sync.
        if (exitCode === 0) {
          try {
            const cache = buildKeyterms(keyterms);
            // writeCache never persists a degraded result.
            writeCache(keyterms, cache);
            await send({
              type: "progress",
              text: cache.degraded
                ? "[voice] Keyterm vocabulary unavailable; serving overrides only (not cached)"
                : `[voice] Rebuilt keyterms cache (${cache.count} terms)`,
            });
          } catch (err) {
            await send({
              type: "progress",
              text: `[voice] Keyterm rebuild failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            });
          }
        } else {
          const tail = lastLines(output, SYNC_ERROR_LINES);
          failure = `Sync failed (exit ${exitCode})${tail ? `: ${tail}` : ""}`;
        }

        // The pull changes the governance policy (#4256): nothing was
        // published. The owner who started this sync reviews the change.
        const principalId = c.get("principal")?.id;
        if (exitCode !== 0 && incoming && deps.policyReviews && principalId) {
          const opened = await openPolicyReview(principalId, incoming);
          if (opened.ok) {
            // Paused, not failed: the run records why it is waiting.
            failure = undefined;
            paused = `Paused for the owner's review of an incoming ${GOVERNANCE_POLICY_PATH} change (exit ${exitCode}).`;
            await send({ type: "policy_review", ...opened.proposal });
            await send({ type: "done", success: false, reason: "policy_review",
              text: "Sync paused: the pull changes the governance policy. Review it; after you approve, sync again." });
            return;
          }
          await send({ type: "progress", text: opened.message });
          // The run records the real cause, not the paused text of a review that never opened.
          failure = `Sync failed (exit ${exitCode}): ${opened.message}`;
        }

        await send({
          type: "done",
          success: exitCode === 0,
          text:
            exitCode === 0 ? "Sync completed" : `Sync failed (exit ${exitCode})`,
        });
      } catch (error) {
        const text = error instanceof Error ? error.message : "Sync failed";
        failure = text;
        await send({ type: "done", success: false, text, ...(error instanceof SyncLaunchTimeout ? { reason: "launch_timeout" } : {}) });
      } finally {
        clearInterval(keepalive);
        syncingRoots.delete(syncRoot);
        run.end(failure, output, paused);
      }
    });
  })

  // The owner's answer to a sync's incoming policy review (#4256).
  .post("/brain/sync/policy/:turnId/:requestId", requireJson(), async (c) => {
    if (!deps.policyReviews) return c.json({ error: "Policy reviews are not available on this server." }, 404);
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "A signed-in owner answers a policy review." }, 403);
    const { turnId, requestId } = c.req.param();
    if (turnId.length > 200 || requestId.length > 200) return c.json({ error: "Invalid request identity." }, 400);
    const result = await readJsonBody(c).catch(() => null);
    if (result instanceof Response) return result;
    const body = result as { approve?: unknown } | null;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "approve") || typeof body.approve !== "boolean")
      return c.json({ error: "Expected { approve } answering this review." }, 400);
    try { return c.json(await deps.policyReviews.decide(principal.id, turnId, requestId, body.approve)); }
    catch (error) {
      if (error instanceof OwnerPolicyReviewError) return c.json({ error: error.message, code: error.code }, error.status);
      throw error;
    }
  })

  // Recovery after a successful capture whose indexing failed. Coalesce
  // concurrent retries and never submit the captured content a second time.
  .post("/brain/index", requireJson(), async (c) => {
    try {
      if (!indexing) indexing = brain.index().finally(() => { indexing = null; });
      await indexing;
      return c.json({ success: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Indexing failed" }, 500);
    }
  })

  .post("/brain/add", requireJson(), async (c) => {
    let body: { content?: unknown; type?: unknown; title?: unknown; tags?: unknown };
    try {
      const result = await readJsonBody<typeof body>(c);
      if (result instanceof Response) return result;
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        return c.json({ error: "Invalid request body" }, 400);
      }
      body = result;
    } catch {
      return c.json({ error: "Invalid request body" }, 400);
    }
    if (typeof body.content !== "string" || !body.content) {
      return c.json({ error: "Field 'content' is required" }, 400);
    }
    if (body.type !== undefined && typeof body.type !== "string") {
      return c.json({ error: "Field 'type' must be a string" }, 400);
    }
    if (body.title !== undefined && typeof body.title !== "string") {
      return c.json({ error: "Field 'title' must be a string" }, 400);
    }
    if (body.tags !== undefined &&
        (!Array.isArray(body.tags) || !body.tags.every((tag) => typeof tag === "string"))) {
      return c.json({ error: "Field 'tags' must be an array of strings" }, 400);
    }
    try {
      const outcome = await brain.add(body.content, {
        type: body.type,
        title: body.title,
        tags: body.tags,
      });
      return c.json({ success: true, ...outcome });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Add failed" },
        500
      );
    }
  });
}
