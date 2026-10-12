import { expect, test } from "bun:test";
import type { SessionEnv } from "../src/backend-options.js";
import { createSessionPool } from "../src/session-pool.js";
import { createTurnContext } from "../src/turn-context.js";
import { createPiBridgeTools } from "../src/bridge-tools.js";
import { DEFAULT_PI_ALLOWED_TOOLS } from "../src/tools.js";
import type { StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
for (const mode of ["interactive", "voice", "autonomous"] as const) test(`pi policy tool's production session roster: ${mode}`, async () => {
  let observed: SessionEnv | undefined;
  const make = async (_id: unknown, env: SessionEnv) => { observed = env; return { session: { sessionId: "policy-session", dispose() {} } as never, turnContext: createTurnContext() }; };
  const pool = createSessionPool({ newSession: make, openSession: make } as never, false);
  const bridge = { emit() {}, requestPermission: async () => ({ behavior: "deny" as const, message: "Refused" }), proposePolicyChange: async () => { throw new Error("Must only be invoked after native approval"); } };
  const req: StartTurnRequest = { prompt: "Review the policy", signal: new AbortController().signal, bridge,
    ...(mode === "voice" ? { posture: "voice", noGrantSurface: true, enforceAllowedTools: true } : {}),
    ...(mode === "autonomous" ? { autonomous: { allowedTools: [], systemPromptAppend: "Autonomous." } as never } : {}) };
  const { entry } = await pool.acquire(req);
  const names = createPiBridgeTools({ brainPath: ".", turn: entry.turnContext, capabilities: observed!.caps }).map(tool => tool.name);
  expect(names.includes("propose_policy_change")).toBe(mode === "interactive");
  expect(DEFAULT_PI_ALLOWED_TOOLS).not.toContain("propose_policy_change"); pool.finish(entry);
});
