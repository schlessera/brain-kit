/**
 * The host Gmail tools in Pi's roster and gate (#4207): every interactive
 * session lists all six, reads and writes, with the contract's exact schemas
 * and order, whether or not this turn has a host handler; no autonomous
 * session lists them; the gate auto-allows each one whenever the host can run
 * it, posture included, because the host decides every call (ruling 6); a call
 * forwards the parsed input only, and a refusal is a tool error.
 */
import { expect, test } from "bun:test";
import * as sdk from "@schlessera/brain-ui-sdk/server";
import { toolInputJsonSchema } from "@schlessera/brain-ui-sdk/server";
import { createSessionPool } from "../src/session-pool.js";
import { createPiBridgeTools } from "../src/bridge-tools.js";
import { createTurnContext } from "../src/turn-context.js";
import { decidePiToolPermission } from "../src/permission-gate.js";
import { DEFAULT_PI_ALLOWED_TOOLS, TOOL_RISK } from "../src/tools.js";
import type { SessionEnv } from "../src/backend-options.js";

// Read from the namespace, so a missing export fails an assertion rather than the module load.
const CONTRACTS = ((sdk as Record<string, unknown>).GOOGLE_TOOL_CONTRACTS ?? []) as readonly { name: string; description: string }[];
const NAMES = ["brain_google_gmail_search", "brain_google_gmail_read", "brain_google_gmail_modify", "brain_google_gmail_trash",
  "brain_google_gmail_draft", "brain_google_gmail_send"];
const google = async () => ({ ok: false as const, tool: "brain_google_gmail_search" as const, error: { code: "unavailable" as const, reason: "not_enabled", message: "none" } });

async function acquiredTools(request: Record<string, unknown>, bridgeExtras: Record<string, unknown> = {}) {
  let observed: SessionEnv | undefined;
  const make = async (_id: unknown, env: SessionEnv) => { observed = env; return { session: { sessionId: "voyage", dispose() {} } as never, turnContext: createTurnContext() }; };
  const pool = createSessionPool({ newSession: make, openSession: make } as never, false);
  const bridge = { emit() {}, requestPermission: async () => ({ behavior: "allow" }), ...bridgeExtras };
  const { entry } = await pool.acquire({ prompt: "Find what Penelope wrote", signal: new AbortController().signal, bridge, ...request } as never);
  const tools = createPiBridgeTools({ brainPath: "/tmp/odysseus", turn: entry.turnContext, capabilities: observed!.caps });
  pool.finish(entry);
  return tools;
}

test("every interactive session lists all six Gmail tools with the contract's schemas, with or without a host handler", async () => {
  let first: string | undefined;
  for (const [label, request, extras] of [
    ["typed", {}, { google }], ["missing-handler", {}, {}], ["voice", { posture: "voice" }, { google }], ["no-grant", { noGrantSurface: true }, { google }],
  ] as const) {
    const tools = (await acquiredTools(request, extras)).filter(tool => tool.name.startsWith("brain_google_"));
    expect(tools.map(tool => tool.name), `PI_GOOGLE_STABLE_ROSTER_${label}`).toEqual(NAMES);
    // Byte-identical definitions in every interactive mode: posture and handler never change them.
    const definitions = JSON.stringify(tools.map(tool => [tool.name, tool.description, tool.parameters]));
    first ??= definitions;
    expect(definitions, `PI_GOOGLE_ROSTER_IDENTICAL_${label}`).toBe(first);
    for (const contract of CONTRACTS) {
      const tool = tools.find(tool => tool.name === contract.name)!;
      expect(tool.description).toBe(contract.description);
      expect(JSON.parse(JSON.stringify(tool.parameters)), `PI_GOOGLE_EXACT_SCHEMA_${label}_${contract.name}`).toEqual(JSON.parse(JSON.stringify(toolInputJsonSchema(contract as never))));
    }
  }
});

test("no autonomous session lists a Gmail tool, restricted or not, even with a handler", async () => {
  for (const containment of ["restricted", undefined]) {
    const autonomous = { origin: "autonomous", persistence: "none", allowedTools: NAMES, systemPromptAppend: "", ...(containment ? { containment } : {}) };
    const names = (await acquiredTools({ autonomous }, { google })).map(tool => tool.name);
    expect(names.filter(name => name.startsWith("brain_google_")), `PI_GOOGLE_AUTONOMOUS_${containment ?? "governed"}`).toEqual([]);
  }
});

test("the gate auto-allows every Gmail tool in every interactive posture when the host can run it, and never shows a runtime card", async () => {
  for (const name of NAMES) {
    expect(TOOL_RISK[name], `PI_GOOGLE_RISK_${name}`).toBe(NAMES.indexOf(name) < 2 ? "read" : "mutate");
    expect(DEFAULT_PI_ALLOWED_TOOLS, `PI_GOOGLE_ALLOWED_${name}`).toContain(name);
    for (const [label, posture, noGrantSurface, handler, expected] of [
      ["typed", undefined, false, true, "allow"], ["voice", "voice", false, true, "allow"], ["no-grant", undefined, true, true, "allow"], ["missing-handler", undefined, false, false, "deny"],
    ] as const) {
      let cards = 0;
      const turn = createTurnContext();
      Object.assign(turn, { ...(posture ? { posture } : {}), noGrantSurface });
      turn.bridge = { emit() {}, requestPermission: async () => { cards++; return { behavior: "allow" }; }, ...(handler ? { google } : {}) } as never;
      expect(await decidePiToolPermission({ turn, allowedTools: new Set(DEFAULT_PI_ALLOWED_TOOLS), confirmPatterns: [] }, name, {}, "loom"), `PI_GOOGLE_GATE_${label}_${name}`)
        .toMatchObject({ behavior: expected });
      expect(cards, `PI_GOOGLE_NO_RUNTIME_CARD_${label}_${name}`).toBe(0);
    }
  }
});

test("a call forwards the parsed input only, and a refusal is a tool error", async () => {
  const calls: unknown[] = [];
  const turn = createTurnContext();
  turn.bridge = { emit() {}, google: async (call: unknown) => { calls.push(call); return google(); } } as never;
  const search = createPiBridgeTools({ brainPath: "/tmp/odysseus", turn, capabilities: { google: true } as never }).find(tool => tool.name === "brain_google_gmail_search");
  expect(search, "PI_GOOGLE_REGISTERED").toBeDefined();
  const error = await search!.execute("loom", { query: "from:penelope" }, new AbortController().signal, undefined, undefined as never).then(() => null, (failure: unknown) => failure);
  expect(String(error), "PI_GOOGLE_REFUSAL_IS_TOOL_ERROR").toContain("not_enabled");
  expect(calls, "PI_GOOGLE_FORWARDS_PARSED_INPUT").toEqual([{ tool: "brain_google_gmail_search", input: { query: "from:penelope", view: "content" } }]);
});

test("google write forwarding returns the bounded receipt without a second runtime card", async () => {
  const turn = createTurnContext(), calls: unknown[] = [];
  let cards = 0;
  const result = { ok: true, tool: "brain_google_gmail_modify", operation: "gmail.modify", effect: "reversible", admission: "card",
    result: { message_ids: ["19a0c3d2e4f50601"], add_label_ids: [], remove_label_ids: ["INBOX"] } };
  turn.bridge = { emit() {}, requestPermission: async () => { cards++; return { behavior: "allow" }; },
    google: async (call: unknown) => { calls.push(call); return result; } } as never;
  const tool = createPiBridgeTools({ brainPath: "/tmp/odysseus", turn, capabilities: { google: true } as never }).find(tool => tool.name === result.tool)!;
  const input = { message_ids: ["19a0c3d2e4f50601"], remove_label_ids: ["INBOX"] };
  expect(await decidePiToolPermission({ turn, allowedTools: new Set(DEFAULT_PI_ALLOWED_TOOLS), confirmPatterns: [] }, tool.name, input, "google-modify")).toMatchObject({ behavior: "allow" });
  const answer = await tool.execute("google-modify", input, new AbortController().signal, undefined, undefined as never);
  expect(calls).toEqual([{ tool: result.tool, input }]);
  expect(JSON.parse((answer.content[0] as { text: string }).text)).toEqual(result);
  expect(cards, "GOOGLE_PI_NO_SECOND_CARD").toBe(0);
});
