import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeyedLock, type StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import type { PiSessionLike } from "../src/backend-options.js";
import { createBrainAccess } from "../src/brain-access.js";
import { createSessionResources } from "../src/session-resources.js";
import { createSessionPool } from "../src/session-pool.js";
import { createPiTurnRunner } from "../src/turn-runner.js";
import { toolLockFromKeyed } from "../src/tools.js";

test("Pi's real toolkit and runner checkpoint before abort, drain the actual writer, then admit interactive work", async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-pi-yield-"));
  const callbacks = new Map<number, { at: number; fn: () => void }>();
  let time = 0, sequence = 0, signals = 0, writes = 0;
  const lock = createKeyedLock({ now: () => time,
    setTimeout: (fn, ms) => { const id = ++sequence; callbacks.set(id, { at: time + ms, fn }); return id as unknown as ReturnType<typeof setTimeout>; },
    clearTimeout: (id) => { callbacks.delete(id as unknown as number); },
  });
  let held!: () => void, releaseBody!: () => void;
  const acquired = new Promise<void>((resolve) => { held = resolve; });
  const body = new Promise<void>((resolve) => { releaseBody = resolve; });
  const brain = createBrainAccess(root);
  const resources = createSessionResources({ backend: { brainPath: root, loadExtensions: false },
    brain: { ...brain, add: async () => {
      writes++;
      if (writes === 1) { held(); await body; }
      writeFileSync(join(root, "harbor.md"), `Odysseus ${writes}`);
      return { action: "created", path: "harbor.md", title: "Odysseus", type: "note", indexed: true };
    } }, lock: toolLockFromKeyed(lock), allowedTools: new Set(["brain_add"]), confirmPatterns: [], loadExtensions: false,
  });
  let sessions = 0, interactive = "pending";
  const pool = createSessionPool({
    async newSession(_profile, env) {
      const toolkit = resources.buildToolkit(env.caps);
      const previous = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = join(root, "agent-config");
      let loaded: Awaited<ReturnType<typeof resources.build>>;
      try { loaded = await resources.build(toolkit, env); }
      finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; }
      let abort!: () => void;
      const cancelled = new Promise<void>((resolve) => { abort = resolve; });
      const session: PiSessionLike = { sessionId: `session-${++sessions}`, subscribe: () => () => {},
        async prompt() {
          const input = { content: "Odysseus" };
          for (const extension of loaded.loader.getExtensions().extensions) {
            for (const handler of extension.handlers.get("tool_call") ?? []) {
              const result = await handler({ type: "tool_call", toolName: "brain_add", toolCallId: "call", input }, {} as never) as { block?: boolean } | undefined;
              if (result?.block) { if (!env.autonomous) interactive = "denied"; return; }
            }
          }
          const tool = toolkit.tools.find((candidate) => candidate.name === "brain_add")!;
          const work = tool.execute("call", input, undefined, undefined, {} as never).then(() => {
            if (!env.autonomous) interactive = "executed";
          }, () => { if (!env.autonomous) interactive = "denied"; });
          // Mirror the SDK abort race: the prompt stops before its tool body.
          await Promise.race([work, cancelled]);
        }, abort: async () => { abort(); }, getSessionStats: () => ({ cost: 0 }), dispose() {},
      };
      return { session, turnContext: toolkit.turnContext };
    }, openSession: async () => { throw new Error("fixture does not resume"); },
  });
  const start = createPiTurnRunner(pool, { brainPath: root });
  const hostAbort = new AbortController();
  const request: StartTurnRequest = { prompt: "Odysseus", signal: hostAbort.signal,
    bridge: { emit: () => {}, checkpointPermission: () => {}, requestPermission: async () => ({ behavior: "deny", message: "No grant surface" }) } };
  let autonomousFinished = false;
  const autonomous = start({ ...request, enforceAllowedTools: true, noGrantSurface: true,
    autonomous: { origin: "autonomous", persistence: "none", allowedTools: ["brain_add"], systemPromptAppend: "",
      onYield: () => { signals++; expect(lock.locked).toBe(true); } } }).then(() => { autonomousFinished = true; });
  await acquired;
  const foreground = start(request); await Bun.sleep(20);
  try {
    time = 20_000;
    for (const [id, timer] of callbacks) if (timer.at <= time) { callbacks.delete(id); timer.fn(); }
    await Bun.sleep(0);
    expect(lock.locked).toBe(true); expect(interactive).toBe("pending");
    expect(autonomousFinished).toBe(false);
    releaseBody(); await Bun.sleep(0);
    time = 30_000;
    for (const [id, timer] of callbacks) if (timer.at <= time) { callbacks.delete(id); timer.fn(); }
    await foreground;
    expect(interactive).toBe("executed"); expect(signals).toBe(1);
    await autonomous; expect(lock.locked).toBe(false);
    expect(readFileSync(join(root, "harbor.md"), "utf8")).toBe("Odysseus 2");
    expect(pool.sessions.size).toBe(1);
    // The first run is ephemeral; the one retained session is interactive.
    const recovery: StartTurnRequest = { ...request, enforceAllowedTools: true, noGrantSurface: true,
      autonomous: { origin: "autonomous", persistence: "none", allowedTools: ["brain_add"], systemPromptAppend: "",
        completedToolCalls: [{ toolName: "brain_add", input: { content: "Odysseus" } }] } };
    await start(recovery); expect(writes).toBe(2);
    await start({ ...recovery, autonomous: { ...recovery.autonomous!, completedToolCalls: [] } });
    expect(writes).toBe(3);
  } finally {
    releaseBody(); hostAbort.abort(); await Promise.allSettled([autonomous, foreground]);
    rmSync(root, { recursive: true, force: true });
  }
});
