/**
 * The host GitHub read tools in Pi's roster and gate (#3797): every
 * interactive session lists both, with the contract's exact schemas, whether
 * or not this turn has a host handler; no autonomous session lists them; the
 * gate auto-allows them only when the host can run them; a call forwards the
 * parsed input only, and a refusal is a tool error.
 */
import { expect, test } from "bun:test";
import { GITHUB_READ_TOOL_CONTRACTS, GITHUB_READ_TOOL_NAMES, toolInputJsonSchema } from "@schlessera/brain-ui-sdk/server";
import { createSessionPool } from "../src/session-pool.js";
import { createPiBridgeTools } from "../src/bridge-tools.js";
import { createTurnContext } from "../src/turn-context.js";
import { decidePiToolPermission } from "../src/permission-gate.js";
import { DEFAULT_PI_ALLOWED_TOOLS, TOOL_RISK } from "../src/tools.js";
import type { SessionEnv } from "../src/backend-options.js";

const github = async () => ({ ok: false as const, tool: "brain_github_issue_read" as const, error: { code: "unavailable" as const, reason: "no_credential", message: "none" } });

async function acquiredTools(request: Record<string, unknown>, bridgeExtras: Record<string, unknown> = {}) {
  let observed: SessionEnv | undefined;
  const make = async (_id: unknown, env: SessionEnv) => { observed = env; return { session: { sessionId: "voyage", dispose() {} } as never, turnContext: createTurnContext() }; };
  const pool = createSessionPool({ newSession: make, openSession: make } as never, false);
  const bridge = { emit() {}, requestPermission: async () => ({ behavior: "allow" }), ...bridgeExtras };
  const { entry } = await pool.acquire({ prompt: "Look up the suitors issue", signal: new AbortController().signal, bridge, ...request } as never);
  const tools = createPiBridgeTools({ brainPath: "/tmp/odysseus", turn: entry.turnContext, capabilities: observed!.caps });
  pool.finish(entry);
  return tools;
}

test("every interactive session lists both read tools with the contract's schemas, with or without a host handler", async () => {
  for (const [label, request, extras] of [
    ["typed", {}, { github }], ["missing-handler", {}, {}], ["voice", { posture: "voice" }, {}], ["no-grant", { noGrantSurface: true }, { github }],
  ] as const) {
    const tools = (await acquiredTools(request, extras)).filter(tool => tool.name.startsWith("brain_github_"));
    expect(tools.map(tool => tool.name), `PI_GITHUB_STABLE_ROSTER_${label}`).toEqual([...GITHUB_READ_TOOL_NAMES]);
    for (const contract of GITHUB_READ_TOOL_CONTRACTS) {
      const tool = tools.find(tool => tool.name === contract.name)!;
      expect(tool.description).toBe(contract.description);
      expect(JSON.parse(JSON.stringify(tool.parameters)), `PI_GITHUB_EXACT_SCHEMA_${label}_${contract.name}`).toEqual(JSON.parse(JSON.stringify(toolInputJsonSchema(contract))));
    }
  }
});

test("no autonomous session lists a GitHub tool, restricted or not, even with a handler", async () => {
  for (const containment of ["restricted", undefined]) {
    const autonomous = { origin: "autonomous", persistence: "none", allowedTools: [...GITHUB_READ_TOOL_NAMES], systemPromptAppend: "", ...(containment ? { containment } : {}) };
    const names = (await acquiredTools({ autonomous }, { github })).map(tool => tool.name);
    expect(names.filter(name => name.startsWith("brain_github_")), `PI_GITHUB_AUTONOMOUS_${containment ?? "governed"}`).toEqual([]);
  }
});

test("the gate auto-allows a read tool only when the host can run it", async () => {
  for (const name of GITHUB_READ_TOOL_NAMES) {
    expect(TOOL_RISK[name], `PI_GITHUB_RISK_${name}`).toBe("read");
    expect(DEFAULT_PI_ALLOWED_TOOLS, `PI_GITHUB_ALLOWED_${name}`).toContain(name);
    let cards = 0;
    const turn = createTurnContext();
    turn.bridge = { emit() {}, requestPermission: async () => { cards++; return { behavior: "allow" }; }, github } as never;
    expect(await decidePiToolPermission({ turn, allowedTools: new Set(DEFAULT_PI_ALLOWED_TOOLS), confirmPatterns: [] }, name, {}, "loom"), `PI_GITHUB_AUTO_ALLOW_${name}`)
      .toMatchObject({ behavior: "allow" });
    turn.bridge = { emit() {}, requestPermission: async () => { cards++; return { behavior: "allow" }; } } as never;
    expect(await decidePiToolPermission({ turn, allowedTools: new Set(DEFAULT_PI_ALLOWED_TOOLS), confirmPatterns: [] }, name, {}, "loom"), `PI_GITHUB_NO_HANDLER_REFUSED_${name}`)
      .toMatchObject({ behavior: "deny" });
    expect(cards, `PI_GITHUB_NO_CARD_${name}`).toBe(0);
  }
});

test("a call forwards the parsed input only, and a refusal is a tool error", async () => {
  const calls: unknown[] = [];
  const turn = createTurnContext();
  turn.bridge = { emit() {}, github: async (call: unknown) => { calls.push(call); return github(); } } as never;
  const read = createPiBridgeTools({ brainPath: "/tmp/odysseus", turn, capabilities: { github: true } }).find(tool => tool.name === "brain_github_issue_read")!;
  await expect(read.execute("loom", { repository: "odysseus/ithaca", number: 7 }, new AbortController().signal, undefined, undefined as never)).rejects.toThrow(/no_credential/);
  expect(calls, "PI_GITHUB_FORWARDS_PARSED_INPUT").toEqual([{ tool: "brain_github_issue_read", input: { repository: "odysseus/ithaca", number: 7 } }]);
});
