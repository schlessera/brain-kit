import { expect, test } from "bun:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { BackendActivityEvent } from "@schlessera/brain-ui-sdk/server";
import { createPiTurnRunner } from "../src/turn-runner.js";
import { createSessionPool } from "../src/session-pool.js";
import { createTurnContext } from "../src/turn-context.js";
import type { PiSessionLike } from "../src/backend-options.js";

for (const reason of ["aborted", "error"] as const) test(`pi excludes ${reason} answers from completed-response receipts`, async () => {
  const events: BackendActivityEvent[] = [];
  let listener: (event: AgentSessionEvent) => void = () => {};
  const event = (type: string, stopReason: string, input: number) => ({ type, message: { role: "assistant", model: "fixture", stopReason,
    content: [], usage: { input, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } } } } as unknown as AgentSessionEvent);
  const session: PiSessionLike = { sessionId: "fixture", subscribe: fn => { listener = fn; return () => {}; },
    async prompt() {
      listener(event("message_end", "toolUse", 10));
      listener(event("message_start", "stop", 100));
      listener(event("message_end", reason, 100));
    }, abort: async () => {}, getSessionStats: () => ({ cost: 0 }), dispose() {} };
  const pool = createSessionPool({ newSession: async () => ({ session, turnContext: createTurnContext() }),
    openSession: async () => { throw new Error("fixture cannot resume"); } });
  const start = createPiTurnRunner(pool, { brainPath: "/brain" });
  await start({ prompt: "Odysseus", signal: new AbortController().signal, enforceAllowedTools: true, noGrantSurface: true,
    autonomous: { origin: "autonomous", persistence: "none", containment: "restricted", allowedTools: [], systemPromptAppend: "" },
    bridge: { emit: () => {}, activity: e => events.push(e), checkpointPermission: () => {}, requestPermission: async () => ({ behavior: "deny", message: "Fixture denial" }) } });
  const receipts = events.filter(e => e.kind === "autonomous_usage");
  expect(receipts).toHaveLength(3);
  expect(receipts[0]).toMatchObject({ atToolBoundary: true, usage: { inputTokens: 10, outputTokens: 5 } });
  expect(receipts[1]).toMatchObject({ atToolBoundary: false, usage: { inputTokens: 10, outputTokens: 5 } });
  expect(receipts[2]).toMatchObject({ atToolBoundary: false, usage: { inputTokens: 10, outputTokens: 5 } });
});
