/**
 * pi's `brain_read_many` (#3642): core's bounded multi-read behind the
 * curated roster. Direct execution, containment through the roster's own
 * resolver, no write receipt, the permission gate, and the real pi agent loop
 * (pi-agent-core's `runAgentLoop` with pi-ai's faux provider) for parallel
 * calls and cancellation. The faux provider's tool calls are scripted: they
 * prove runtime mechanics, not that a model would choose the tool.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runAgentLoop, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { compileConfirmPatterns, createKeyedLock, DEFAULT_CONFIRM_BASH_PATTERNS, type BackendBridge } from "@schlessera/brain-ui-sdk/server";

import { createBrainAccess } from "../src/brain-access";
import { createPermissionGate } from "../src/permission-gate";
import { createBrainTools, DEFAULT_PI_ALLOWED_TOOLS, TOOL_RISK, toolLockFromKeyed } from "../src/tools";
import { createTurnContext, type TurnContext } from "../src/turn-context";
import { makeIndexedBrain, resultText, type TempBrain } from "./helpers";
import { makeMockBridge } from "./mock-bridge";

const CTX = {} as never;
const IDENTITY = readFileSync(join(import.meta.dir, "../../core/fixtures/corpus/me/identity.md"), "utf-8");
const RAFT = "---\ntype: note\ntitle: \"Raft\"\nupdated: 2026-07-12\n---\n\n## Build\n\nTimber from Calypso's grove.\n\n## Launch\n\nSeventeen days to Scheria.\n";

let brain: TempBrain;
let outside: string;

beforeAll(async () => {
  brain = await makeIndexedBrain({ "me/identity.md": IDENTITY, "notes/raft.md": RAFT });
  outside = `${brain.root}-cave.md`;
  writeFileSync(outside, "Polyphemus keeps this cave closed.\n");
  symlinkSync(outside, join(brain.root, "notes/cave-link.md"));
});

afterAll(() => {
  brain.cleanup();
  rmSync(outside, { force: true });
});

function roster(turn: TurnContext = createTurnContext()): ToolDefinition[] {
  return createBrainTools({ brain: createBrainAccess(brain.root), turn, lock: toolLockFromKeyed(createKeyedLock()) });
}
const tool = (name: string, turn?: TurnContext) => roster(turn).find((t) => t.name === name)!;
const run = (t: ToolDefinition, params: Record<string, unknown>, signal?: AbortSignal) => t.execute("call-odysseus", params as never, signal, undefined, CTX);
type Envelope = { items: Array<Record<string, unknown> & { kind: string; code?: string }>; truncated: boolean; max_total_chars: number; warnings: string[] };
const envelope = async (params: Record<string, unknown>, turn?: TurnContext) => JSON.parse(resultText(await run(tool("brain_read_many", turn), params))) as Envelope;

describe("brain_read_many on the pi roster", () => {
  test("is listed after the single read tools, classed read and auto-allowed like brain_read", () => {
    const names = roster().map((t) => t.name);
    expect(names.indexOf("brain_read_many")).toBe(names.indexOf("brain_graph") + 1);
    expect(TOOL_RISK.brain_read_many).toBe("read");
    expect(DEFAULT_PI_ALLOWED_TOOLS).toContain("brain_read_many");
  });

  test("answers several documents in order, each full item what brain_read returns", async () => {
    const body = await envelope({ requests: [{ path: "me/identity.md" }, { path: "notes/raft.md", section: "launch" }, { path: "notes/missing.md" }, { path: "me/identity.md" }] });
    expect(body.items.map((i) => i.code ?? i.kind)).toEqual(["full", "full", "not_found", "duplicate"]);
    expect(body.items[0]!.content).toBe(await run(tool("brain_read"), { path: "me/identity.md" }).then(resultText));
    expect(body.items[1]!.content).toBe(await run(tool("brain_read"), { path: "notes/raft.md", section: "launch" }).then(resultText));
    expect(JSON.stringify(body).length).toBeLessThanOrEqual(body.max_total_chars);
    expect(body.warnings).toEqual([]);
  });

  test("refuses traversal, absolute paths and links out of the repository per item, with no host path", async () => {
    const body = await envelope({ requests: [{ path: "../outside.md" }, { path: "/etc/hosts" }, { path: "notes/cave-link.md" }, { path: "me/identity.md" }] });
    expect(body.items.map((i) => i.code ?? i.kind), "PI_CONTAINMENT").toEqual(["refused", "refused", "refused", "full"]);
    const text = JSON.stringify(body);
    expect(text).not.toContain("Polyphemus");
    expect(text).not.toContain(brain.root);
  });

  test("invalid input is a tool error, never clamped", async () => {
    for (const params of [{ requests: [] }, { requests: [{ path: "me/identity.md" }], max_total_chars: 50_000 }, { requests: [{ path: "me/identity.md", column: 1 }] }])
      await expect(run(tool("brain_read_many"), params)).rejects.toThrow(/^invalid /);
  });

  test("stops on the tool's abort signal and on the turn's", async () => {
    const aborted = new AbortController();
    aborted.abort(new Error("Odysseus stopped the read"));
    await expect(run(tool("brain_read_many"), { requests: [{ path: "me/identity.md" }] }, aborted.signal)).rejects.toThrow("Odysseus stopped the read");
    const turn = createTurnContext();
    const turnAbort = new AbortController();
    turn.signal = turnAbort.signal;
    turnAbort.abort(new Error("the turn ended"));
    await expect(run(tool("brain_read_many", turn), { requests: [{ path: "me/identity.md" }] })).rejects.toThrow("the turn ended");
  });

  test("leaves no write receipt: a routed edit after it still needs a base, unlike after brain_read", async () => {
    const turn = createTurnContext();
    const inputs: unknown[] = [];
    turn.bridge = { ...makeMockBridge({}).bridge, applyBrain: async (input) => { inputs.push(input); return { ok: true, message: "ok", changes: [] } as never; } } as BackendBridge;
    const tools = roster(turn);
    const edit = tools.find((t) => t.name === "edit_file")!;
    const params = { path: "notes/raft.md", old_string: "Timber", new_string: "Cedar" };
    await run(tools.find((t) => t.name === "brain_read_many")!, { requests: [{ path: "notes/raft.md" }] });
    await expect(run(edit, params), "NO_RECEIPT_FROM_READ_MANY").rejects.toThrow("Read brain_read_base or read_file first");
    await run(tools.find((t) => t.name === "brain_read")!, { path: "notes/raft.md" });
    await run(edit, params);
    expect(inputs).toHaveLength(1);
  });
});

describe("permission gate", () => {
  const CONFIRM = compileConfirmPatterns(DEFAULT_CONFIRM_BASH_PATTERNS, () => {});
  function gateHandler(opts: Parameters<typeof createPermissionGate>[0]) {
    let handler: ((event: { toolName: string; toolCallId: string; input: unknown }) => Promise<{ block: boolean } | undefined>) | undefined;
    const gate = createPermissionGate(opts);
    (typeof gate === "function" ? gate : gate.factory)({ on: (event: string, h: unknown) => { if (event === "tool_call") handler = h as typeof handler; } } as never);
    return handler!;
  }
  const input = { requests: [{ path: "me/identity.md" }] };

  test("the default allowlist runs it with no approval round-trip", async () => {
    const turn = createTurnContext();
    const mock = makeMockBridge({ decision: { behavior: "deny", message: "should not ask" } });
    turn.bridge = mock.bridge;
    expect(await gateHandler({ turn, allowedTools: new Set(DEFAULT_PI_ALLOWED_TOOLS), confirmPatterns: CONFIRM })({ toolName: "brain_read_many", toolCallId: "m", input })).toBeUndefined();
    expect(mock.permissionCalls).toHaveLength(0);
  });

  test("an enforced allowlist without it blocks it, though brain_read is allowed", async () => {
    for (const noGrantSurface of [false, true]) {
      const turn = createTurnContext();
      const mock = makeMockBridge({ decision: { behavior: "deny", message: "operator excluded batch reads" } });
      turn.bridge = mock.bridge;
      turn.enforceAllowedTools = true;
      turn.noGrantSurface = noGrantSurface;
      const handler = gateHandler({ turn, allowedTools: new Set(["brain_read"]), confirmPatterns: CONFIRM });
      expect(await handler({ toolName: "brain_read", toolCallId: "r", input: { path: "me/identity.md" } })).toBeUndefined();
      expect(await handler({ toolName: "brain_read_many", toolCallId: "m", input }), "POLICY_GATED").toMatchObject({ block: true });
      expect(mock.permissionCalls).toHaveLength(noGrantSurface ? 0 : 1);
    }
  });
});

/** A pi coding-agent tool definition in the agent core's shape, recording when it ran. */
function agentTool(def: ToolDefinition, spans: Array<{ name: string; start: number; end: number }>): AgentTool {
  return {
    name: def.name, label: def.label, description: def.description, parameters: def.parameters as never,
    async execute(id, params, signal, onUpdate) {
      const start = performance.now();
      try { return await (def.execute as (...a: unknown[]) => Promise<never>)(id, params, signal, onUpdate, CTX); }
      finally { spans.push({ name: def.name, start, end: performance.now() }); }
    },
  };
}

/** One agent-loop run: each step is one assistant message of tool calls, then a final answer. */
async function loop(steps: Array<Array<{ name: string; args: Record<string, unknown> }>>, opts: { signal?: AbortSignal; onStart?: () => void } = {}) {
  const faux = createFauxCore({});
  let final: Message[] = [];
  faux.setResponses([
    ...steps.map((calls, s) => () => fauxAssistantMessage(calls.map((c, i) => fauxToolCall(c.name, c.args as never, { id: `call_ithaca_${s}_${i}` })), { stopReason: "toolUse" })),
    (context: { messages: Message[] }) => { final = context.messages; return fauxAssistantMessage(fauxText("The raft is ready.")); },
  ]);
  const spans: Array<{ name: string; start: number; end: number }> = [];
  const tools = roster().filter((t) => t.name === "brain_read" || t.name === "brain_read_many").map((t) => agentTool(t, spans));
  const events: AgentEvent[] = [];
  const messages = await runAgentLoop(
    [{ role: "user", content: "Odysseus asks for the raft notes.", timestamp: 0 } as AgentMessage],
    { messages: [], tools },
    { model: faux.getModel(), convertToLlm: (m) => m as Message[] },
    (e) => { events.push(e); if (e.type === "tool_execution_start") opts.onStart?.(); },
    opts.signal,
    faux.streamSimple,
  );
  const results = final.filter((m) => m.role === "toolResult").map((m) => ({ name: (m as { toolName?: string }).toolName, text: (m.content as Array<{ text?: string }>).map((p) => p.text ?? "").join("") }));
  return { results, spans, events, messages, requests: faux.state.callCount };
}

describe("pi agent loop (faux provider, scripted calls)", () => {
  test("a multi-item call runs through the loop and its result reaches the next request whole", async () => {
    const run = await loop([[{ name: "brain_read_many", args: { requests: [{ path: "me/identity.md" }, { path: "notes/raft.md", section: "Build" }] } }]]);
    expect(run.requests).toBe(2);
    expect(run.results).toHaveLength(1);
    const body = JSON.parse(run.results[0]!.text) as Envelope;
    expect(body.items.map((i) => i.kind)).toEqual(["full", "full"]);
    expect(body.items[0]!.content).toBe(IDENTITY);
  });

  test("concurrent calls in one assistant message each answer in full", async () => {
    const many = { requests: [{ path: "me/identity.md" }, { path: "notes/raft.md" }] };
    const run = await loop([[
      { name: "brain_read_many", args: many },
      { name: "brain_read_many", args: many },
      { name: "brain_read", args: { path: "notes/raft.md" } },
      { name: "brain_read_many", args: { requests: [{ path: "notes/cave-link.md" }] } },
    ]]);
    expect(run.results.map((r) => r.name)).toEqual(["brain_read_many", "brain_read_many", "brain_read", "brain_read_many"]);
    expect(run.results[0]!.text).toBe(run.results[1]!.text);
    expect(JSON.parse(run.results[0]!.text).items[1].content).toBe(run.results[2]!.text);
    expect(JSON.parse(run.results[3]!.text).items[0]).toMatchObject({ kind: "error", code: "refused" });
    expect(run.spans.filter((s) => s.name === "brain_read_many")).toHaveLength(3);
  });

  test("aborting the turn as the call starts reads nothing and the loop settles aborted", async () => {
    const controller = new AbortController();
    const run = await loop([[{ name: "brain_read_many", args: { requests: [{ path: "me/identity.md" }, { path: "notes/raft.md" }] } }]], {
      signal: controller.signal,
      onStart: () => controller.abort(),
    });
    const ended = run.events.filter((e) => e.type === "tool_execution_end") as Extract<AgentEvent, { type: "tool_execution_end" }>[];
    // The call ends as an error result and its body never runs: nothing is read after the abort.
    expect(ended.map((e) => e.isError)).toEqual([true]);
    expect(run.spans).toHaveLength(0);
    expect(run.results).toHaveLength(1);
    const last = run.messages.filter((m) => (m as { role?: string }).role === "assistant").at(-1) as { stopReason?: string };
    expect(last.stopReason).toBe("aborted");
  });
});
