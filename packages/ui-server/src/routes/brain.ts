import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { probeBrainCliVersion, type BrainClient } from "../brain/client.js";
import type { Logger } from "@opentelemetry/api-logs";
import { execConfig, subprocessEnv } from "../config/env.js";
import { execWrapperSpawnOptions, wrapCommand } from "@schlessera/brain-ui-sdk/server";
import {
  buildKeyterms,
  writeCache,
  type KeytermSettings,
} from "../voice/keyterm-builder.js";
import { existsSync, realpathSync } from "fs";
import { join } from "path";
import { readJsonBody } from "../middleware/body-limit.js";
import { requireJson } from "../middleware/origin.js";

// Shared across route instances, keyed by the canonical brain root.
const syncingRoots = new Set<string>();

export interface BrainRoutesDeps {
  brainCliMinimum?: string;
  log?: Logger;
  brain: BrainClient;
  brainPath: string;
  keyterms: KeytermSettings;
}

/**
 * Locate the brain repo's `whatsup` script, relative to the repo root.
 *
 * Unlike the commands in brain/client.ts, whatsup is NOT part of the packaged
 * @schlessera/brain CLI (it is absent from CORE_COMMAND_NAMES) — it stays a
 * repo-local script. A brain repo migrated onto the published packages deletes
 * the vendored `scripts/` tree and keeps whatsup at `private/whatsup.ts`; the
 * legacy layout has it at `scripts/whatsup.ts`. Try both, newest layout first.
 *
 * Returns null when neither exists, so the route can report that plainly
 * instead of surfacing bun's "module not found" through the SSE stream.
 */
function findWhatsupScript(brainPath: string): string | null {
  for (const rel of ["private/whatsup.ts", "scripts/whatsup.ts"]) {
    if (existsSync(join(brainPath, rel))) return rel;
  }
  return null;
}

export function createBrainRoutes(deps: BrainRoutesDeps): Hono {
  const { brain, brainPath, keyterms } = deps;
  let indexing: Promise<void> | null = null;

  return new Hono()
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

  .post("/brain/whatsup", async (c) => {
    // Defeat reverse-proxy buffering for SSE
    c.header("X-Accel-Buffering", "no");

    return streamSSE(c, async (stream) => {
      const send = (data: {
        type: string;
        text?: string;
        success?: boolean;
      }) => stream.writeSSE({ data: JSON.stringify(data) });

      // Heartbeat keeps the proxy from idling out the connection while
      // the upstream LLM call is in flight (~5-15s with no stdout)
      const heartbeat = setInterval(() => {
        stream
          .writeSSE({ event: "ping", data: "" })
          .catch(() => {});
      }, 3000);

      try {
        await send({ type: "start", text: "Running whatsup briefing..." });

        const script = findWhatsupScript(brainPath);
        if (!script) {
          // Terminate with the frames the client actually handles: it only
          // reads "progress" and "done", so an "error" type would leave the
          // panel spinning on an empty body.
          await send({
            type: "progress",
            text: "whatsup script not found in the brain repo (looked for private/whatsup.ts and scripts/whatsup.ts).",
          });
          await send({ type: "done", success: false, text: "Not available" });
          return;
        }

        // --gemini: the default backend needs ANTHROPIC_API_KEY, which is no
        // longer set (Claude runs on subscription auth, and the script's
        // --claude backend uses --bare mode, which can't read the
        // CLAUDE_CODE_OAUTH_TOKEN either).
        // Through the exec wrapper like every other child: this one runs a
        // script that lives IN the brain repository, which makes it the least
        // appropriate spawn in the package to leave unwrapped.
        const whatsup = execConfig();
        const proc = Bun.spawn(wrapCommand(["bun", script, "--gemini"], whatsup.wrapper), {
          cwd: brainPath,
          stdout: "pipe",
          stderr: "pipe",
          env: subprocessEnv("brainCli", { NO_COLOR: "1" }),
          ...execWrapperSpawnOptions(whatsup.wrapper),
        });

        // Start draining stderr NOW, not after the process exits.
        //
        // The stdout loop below can run for minutes. Meanwhile stderr fills an
        // OS pipe buffer that nothing is reading — and once it is full the
        // child blocks on write, never exits, and `await proc.exited` never
        // resolves. A chatty run deadlocked the request; a quiet one looked
        // fine, which is why this survived.
        const stderrText = new Response(proc.stderr).text();

        const reader = proc.stdout.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              await send({ type: "progress", text: line });
            }
          }
          if (buffer.trim()) {
            await send({ type: "progress", text: buffer });
          }
        } catch {}

        const exitCode = await proc.exited;

        const stderr = await stderrText;
        if (stderr.trim()) {
          for (const line of stderr.split("\n")) {
            if (line.trim()) await send({ type: "progress", text: line });
          }
        }

        await send({
          type: "done",
          success: exitCode === 0,
          text:
            exitCode === 0
              ? "Briefing complete"
              : `Failed (exit ${exitCode})`,
        });
      } catch (error) {
        // Anything that throws before the last send — a spawn that cannot
        // start, for one — still ends on the frame the panel waits for. The
        // send itself may be what failed, so neither can throw again. The panel
        // renders only progress text, so the reason goes there too.
        const text = error instanceof Error ? error.message : "Briefing failed";
        await send({ type: "progress", text }).catch(() => {});
        await send({ type: "done", success: false, text }).catch(() => {});
      } finally {
        clearInterval(heartbeat);
      }
    });
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
    if (syncingRoots.has(syncRoot)) {
      return c.json({ error: "A sync is already running. Wait for it to finish before retrying." }, 409);
    }
    syncingRoots.add(syncRoot);
    return streamSSE(c, async (stream) => {
      let keepalive: ReturnType<typeof setInterval> | undefined;
      let disconnected = false;
      stream.onAbort(() => { disconnected = true; });
      const send = (data: {
        type: string;
        text?: string;
        success?: boolean;
      }) => disconnected ? Promise.resolve() : stream.writeSSE({ data: JSON.stringify(data) })
        .catch(() => { disconnected = true; });

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
        if (deps.brainCliMinimum !== undefined) {
          await probeBrainCliVersion(brainPath, deps.log ?? { emit() {}, enabled: () => false }, { minimumVersion: deps.brainCliMinimum, phase: "streaming sync invocation", command });
        }
        const [cliBin, ...cliArgs] = command;
        const sync = execConfig();
        const proc = Bun.spawn(
          wrapCommand(
            // `--human`: stdout is a pipe, which would make it the JSON
            // result (#290); this route streams the readable report.
            ["bash", "-c", '"$0" "$@" 2>&1', cliBin!, ...cliArgs, "sync", "--human"],
            sync.wrapper
          ),
          {
            cwd: brainPath,
            stdout: "pipe",
            stderr: "pipe",
            env: subprocessEnv("brainCli", { NO_COLOR: "1" }),
            ...execWrapperSpawnOptions(sync.wrapper),
          }
        );

        // Keep draining even when the SSE reader disconnects. The repository
        // stays reserved until the actual sync process has exited.
        const stderrDone = new Response(proc.stderr).text().catch(() => "");
        const reader = proc.stdout.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              if (line.trim()) {
                await send({ type: "progress", text: line });
              }
            }
          }
          if (buffer.trim()) {
            await send({ type: "progress", text: buffer });
          }
        } catch {} finally {
          clearInterval(keepalive);
        }

        const exitCode = await proc.exited;
        await stderrDone;

        // Rebuild voice keyterms cache after a successful sync.
        if (exitCode === 0) {
          try {
            const cache = buildKeyterms(keyterms);
            writeCache(keyterms, cache);
            await send({
              type: "progress",
              text: `[voice] Rebuilt keyterms cache (${cache.count} terms)`,
            });
          } catch (err) {
            await send({
              type: "progress",
              text: `[voice] Keyterm rebuild failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            });
          }
        }

        await send({
          type: "done",
          success: exitCode === 0,
          text:
            exitCode === 0 ? "Sync completed" : `Sync failed (exit ${exitCode})`,
        });
      } catch (error) {
        await send({ type: "done", success: false, text: error instanceof Error ? error.message : "Sync failed" });
      } finally {
        clearInterval(keepalive);
        syncingRoots.delete(syncRoot);
      }
    });
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
    const result = await readJsonBody<{
      content: string;
      type?: string;
      title?: string;
      tags?: string[];
    }>(c);
    if (result instanceof Response) return result;
    const body = result;
    if (!body.content) {
      return c.json({ error: "Field 'content' is required" }, 400);
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
