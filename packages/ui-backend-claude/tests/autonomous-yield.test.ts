import { mockWorkerHostForSdkStream } from "./helpers/worker-host.js";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import { createKeyedLock, type StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { createClaudeBackend } from "../src/backend.js";
import { runToolCall } from "./helpers/run-tool-call.js";

/** An autonomous turn needs a credential its relay can hold (#676). */
const profiles = [{ id: "fixture", label: "Fixture", billing: "api" as const, requiredEnvKeys: [],
  buildEnv: () => ({ ANTHROPIC_API_KEY: "offline-fixture" }) }];

test("Claude's actual hook/runner yields a long autonomous write and releases it before interactive denial", async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-claude-yield-"));
  const callbacks = new Map<number, { at: number; fn: () => void }>();
  let time = 0, sequence = 0, signals = 0;
  const lock = createKeyedLock({ now: () => time,
    setTimeout: (fn, ms) => { const id = ++sequence; callbacks.set(id, { at: time + ms, fn }); return id as unknown as ReturnType<typeof setTimeout>; },
    clearTimeout: (id) => { callbacks.delete(id as unknown as number); },
  });
  let held!: () => void;
  const acquired = new Promise<void>((resolve) => { held = resolve; });
  let interactive = "pending";
  const queryFn = ((params: { prompt: string; options: Options }) => (async function* () {
    const autonomous = params.options.persistSession === false;
    yield { type: "system", subtype: "init", session_id: autonomous ? "autonomous" : "interactive" };
    const result = await runToolCall(params.options, "Write", { file_path: join(root, "harbor.md"), content: "Odysseus" }, autonomous ? "auto-tool" : "interactive-tool", true);
    if (autonomous && result.executed) {
      held();
      await new Promise<void>((resolve) => params.options.abortController!.signal.addEventListener("abort", () => resolve(), { once: true }));
    } else {
      interactive = result.executed ? "executed" : "denied";
      if (result.executed) writeFileSync(join(root, "harbor.md"), "Odysseus");
    }
    yield { type: "result", subtype: "success", session_id: autonomous ? "autonomous" : "interactive", total_cost_usd: 0.3, duration_ms: 1, num_turns: 1 };
  })()) as unknown as typeof query;
  const backend = createClaudeBackend({ brainPath: root, writeLock: lock, queryFn, profiles, log: () => {} });
  const hostAbort = new AbortController();
  const request = { prompt: "Odysseus", signal: hostAbort.signal,
    bridge: { emit: () => {}, checkpointPermission: () => {}, requestPermission: async () => ({ behavior: "deny" as const, message: "No grant surface" }) } };
  const autonomous = backend.startTurn({ ...request, enforceAllowedTools: true, noGrantSurface: true,
    autonomous: { origin: "autonomous", persistence: "none", allowedTools: ["Write"], systemPromptAppend: "",
      onYield: () => { signals++; expect(lock.locked).toBe(true); } } });
  await acquired;
  const foreground = backend.startTurn(request);
  await Bun.sleep(0);
  try {
    time = 19_999;
    expect(signals).toBe(0); expect(interactive).toBe("pending");
    time = 20_000;
    for (const [id, timer] of callbacks) if (timer.at <= time) { callbacks.delete(id); timer.fn(); }
    await Bun.sleep(0);
    // A missing yield must reach the real timeout/deny assertion, never hang.
    time = 30_000;
    for (const [id, timer] of callbacks) if (timer.at <= time) { callbacks.delete(id); timer.fn(); }
    await foreground;
    expect(interactive).toBe("executed");
    expect(signals).toBe(1);
    expect(readFileSync(join(root, "harbor.md"), "utf8")).toBe("Odysseus");
    await autonomous; expect(lock.locked).toBe(false); expect(callbacks.size).toBe(0);
  } finally {
    hostAbort.abort(); await Promise.allSettled([autonomous, foreground]);
    rmSync(root, { recursive: true, force: true });
  }
});

for (const toolName of ["Write", "Agent"] as const) test(`Claude refuses a completed ${toolName} call even through runtime auto-approval and input rewrite`, async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-claude-no-replay-"));
  let executions = 0;
  const input: Record<string, unknown> = toolName === "Write"
    ? { file_path: join(root, "harbor.md"), content: "Odysseus" }
    : { prompt: "Odysseus", description: "Fixture", run_in_background: false };
  const requested = toolName === "Write" ? { content: "Odysseus", file_path: input.file_path }
    : { prompt: "Odysseus", description: "Fixture", run_in_background: true };
  const queryFn = ((params: { options: Options }) => (async function* () {
    yield { type: "system", subtype: "init", session_id: "recovered" };
    const outcome = await runToolCall(params.options, toolName, requested, "new-id", true);
    if (outcome.executed) executions++;
    yield { type: "result", subtype: "success", session_id: "recovered", total_cost_usd: 0, duration_ms: 1, num_turns: 1 };
  })()) as unknown as typeof query;
  try {
    const backend = createClaudeBackend({ brainPath: root, queryFn, profiles, log: () => {} });
    const req: StartTurnRequest = { prompt: "Resume Odysseus work", signal: new AbortController().signal,
      enforceAllowedTools: true, noGrantSurface: true, bridge: { emit: () => {}, checkpointPermission: () => {}, requestPermission: async () => ({ behavior: "deny", message: "No grant surface" }) },
      autonomous: { origin: "autonomous", persistence: "none", allowedTools: [toolName], systemPromptAppend: "",
        completedToolCalls: [{ toolName, input }] } };
    await backend.startTurn(req);
    expect(executions).toBe(0);
    await backend.startTurn({ ...req, autonomous: { ...req.autonomous!, completedToolCalls: [] } });
    expect(executions).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

mockWorkerHostForSdkStream();
