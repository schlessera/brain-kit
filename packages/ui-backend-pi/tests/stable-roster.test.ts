import { expect, test } from "bun:test";
import { createSessionPool } from "../src/session-pool.js";
import { createPiBridgeTools } from "../src/bridge-tools.js";
import { createTurnContext } from "../src/turn-context.js";
import { decidePiToolPermission } from "../src/permission-gate.js";
import type { SessionEnv } from "../src/backend-options.js";

const names = ["request_image_mask", "ask_user_list", "ask_user_rank", "ask_user_form", "propose_policy_change", "inbox_add", "resolve_action", "complete_share"];
test("Pi production session acquisition builds one full roster even voice-first with no handlers", async () => {
  const rosters: string[] = [];
  for (const mode of ["voice", "typed", "missing", "no-grant"]) {
    let observed: SessionEnv | undefined;
    const make = async (_id: unknown, env: SessionEnv) => { observed = env; return { session: { sessionId: "voyage", dispose() {} } as never, turnContext: createTurnContext() }; };
    const pool = createSessionPool({ newSession: make, openSession: make } as never, false);
    const bridge: any = { emit() {}, requestPermission: async () => ({ behavior: "allow" }) };
    if (mode === "typed") bridge.proposePolicyChange = async () => {};
    const { entry } = await pool.acquire({ prompt: "Return to Ithaca", signal: new AbortController().signal, bridge,
      ...(mode === "voice" ? { posture: "voice" } : {}), noGrantSurface: mode !== "typed" });
    const tools = createPiBridgeTools({ brainPath: "/tmp/odysseus", turn: entry.turnContext, capabilities: observed!.caps });
    rosters.push(JSON.stringify(tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))));
    for (const name of names) expect(tools.some(tool => tool.name === name), `PI_FULL_ROSTER_${mode}_${name}`).toBe(true);
    pool.finish(entry);
  }
  for (const roster of rosters.slice(1)) expect(roster, "PI_FIXED_VOICE_FIRST_ROSTER").toBe(rosters[0]);
});
for (const mode of ["voice", "no-grant", "missing"]) for (const name of names) test(`Pi ${mode} gate refuses ${name} without approval`, async () => {
  const turn = createTurnContext(); let cards = 0;
  const bridge: any = { emit() {}, requestPermission: async () => { cards++; return { behavior: "allow" }; } };
  if (mode !== "missing") for (const handler of ["requestMask", "askUserList", "askUserRank", "askUserForm", "proposePolicyChange", "inboxAdd", "resolveAction", "completeShare"])
    bridge[handler] = async () => { throw new Error("PRIVILEGED_HANDLER_EXECUTED"); };
  turn.bridge = bridge; turn.posture = mode === "voice" ? "voice" : undefined; turn.noGrantSurface = mode === "no-grant";
  const decision = await decidePiToolPermission({ turn, allowedTools: new Set([name]), confirmPatterns: [] }, name, {}, "raft");
  expect(decision, `PI_GATE_REFUSAL_${mode}_${name}`).toMatchObject({ behavior: "deny" }); expect(cards).toBe(0);
});
