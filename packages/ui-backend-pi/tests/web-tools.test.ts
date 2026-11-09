/**
 * The host-owned web tools in Pi's roster and gate (#3685): every ordinary
 * interactive session lists the four forwarding tools whether or not this
 * turn has a host handler, no autonomous session lists them, and the gate
 * auto-allows them only when the host can run them.
 */
import { expect, test } from "bun:test";
import { WEB_TOOL_NAME_LIST } from "@schlessera/brain-ui-sdk/server";
import { createSessionPool } from "../src/session-pool.js";
import { createPiBridgeTools } from "../src/bridge-tools.js";
import { createTurnContext } from "../src/turn-context.js";
import { decidePiToolPermission } from "../src/permission-gate.js";
import { DEFAULT_PI_ALLOWED_TOOLS, TOOL_RISK } from "../src/tools.js";
import type { SessionEnv } from "../src/backend-options.js";

const webAccess = async () => ({ ok: true as const, tool: "web_search" as const, text: "" });

async function acquiredTools(request: Record<string, unknown>, bridgeExtras: Record<string, unknown> = {}) {
  let observed: SessionEnv | undefined;
  const make = async (_id: unknown, env: SessionEnv) => { observed = env; return { session: { sessionId: "voyage", dispose() {} } as never, turnContext: createTurnContext() }; };
  const pool = createSessionPool({ newSession: make, openSession: make } as never, false);
  const bridge = { emit() {}, requestPermission: async () => ({ behavior: "allow" }), ...bridgeExtras };
  const { entry } = await pool.acquire({ prompt: "Find the mast", signal: new AbortController().signal, bridge, ...request } as never);
  const names = createPiBridgeTools({ brainPath: "/tmp/odysseus", turn: entry.turnContext, capabilities: observed!.caps }).map(tool => tool.name);
  pool.finish(entry);
  return names;
}

test("every interactive session lists the four web tools, with or without a host handler", async () => {
  for (const [label, request, extras] of [
    ["typed", {}, { webAccess }], ["missing-handler", {}, {}], ["voice", { posture: "voice" }, {}], ["no-grant", { noGrantSurface: true }, { webAccess }],
  ] as const) {
    const names = await acquiredTools(request, extras);
    for (const name of WEB_TOOL_NAME_LIST) expect(names, `PI_WEB_INTERACTIVE_${label}_${name}`).toContain(name);
  }
});

test("no autonomous session lists a web tool, restricted or not, even with a handler", async () => {
  for (const containment of ["restricted", undefined]) {
    const autonomous = { origin: "autonomous", persistence: "none", allowedTools: [...WEB_TOOL_NAME_LIST], systemPromptAppend: "", ...(containment ? { containment } : {}) };
    const names = await acquiredTools({ autonomous }, { webAccess });
    expect(names.filter(name => (WEB_TOOL_NAME_LIST as readonly string[]).includes(name)), `PI_WEB_AUTONOMOUS_${containment ?? "governed"}`).toEqual([]);
  }
});

test("the gate auto-allows a web tool only when the host can run it", async () => {
  for (const name of WEB_TOOL_NAME_LIST) {
    expect(TOOL_RISK[name], `PI_WEB_RISK_${name}`).toBe("read");
    expect(DEFAULT_PI_ALLOWED_TOOLS, `PI_WEB_ALLOWED_${name}`).toContain(name);
    let cards = 0;
    const turn = createTurnContext();
    turn.bridge = { emit() {}, requestPermission: async () => { cards++; return { behavior: "allow" }; }, webAccess } as never;
    expect(await decidePiToolPermission({ turn, allowedTools: new Set(DEFAULT_PI_ALLOWED_TOOLS), confirmPatterns: [] }, name, {}, "mast"), `PI_WEB_AUTO_ALLOW_${name}`)
      .toMatchObject({ behavior: "allow" });
    turn.bridge = { emit() {}, requestPermission: async () => { cards++; return { behavior: "allow" }; } } as never;
    const refused = await decidePiToolPermission({ turn, allowedTools: new Set(DEFAULT_PI_ALLOWED_TOOLS), confirmPatterns: [] }, name, {}, "mast");
    expect(refused, `PI_WEB_NO_HANDLER_REFUSED_${name}`).toMatchObject({ behavior: "deny" });
    expect(cards, `PI_WEB_NO_CARD_${name}`).toBe(0);
  }
});
