/**
 * The ws web slice (#3685): only Pi's governed and strict interactive turns
 * get `webAccess`, and the scope it hands the broker is the turn's own.
 */
import { expect, test } from "bun:test";
import type { WebBroker, WebCallScope } from "../src/web-tools/broker.js";
import { createWebAccess } from "../src/ws/bridge-capabilities/web.js";

function slice(overrides: Record<string, unknown> = {}, collected: string | null = "s-ithaca") {
  const scopes: WebCallScope[] = [];
  const broker = { call: async (scope: WebCallScope, call: { tool: string }) => { scopes.push(scope); return { ok: true, tool: call.tool, text: "" }; } } as unknown as WebBroker;
  const ctx = { host: { webTools: broker }, turn: { sessionId: null }, turnId: "t-voyage", principalId: "p-penelope", signal: new AbortController().signal,
    backendId: "pi", workerProfile: { origin: "interactive", actualProfile: "strict" }, work: undefined, current: () => true, recordingAvailable: () => true, ...overrides };
  return { scopes, web: createWebAccess(ctx as never, { collectedSessionId: collected }, { policy: { hash: "rev-7", policy: { providers: [] } } } as never) };
}

test("the slice exists only for Pi's turns, typed or voice, on a host with a broker", () => {
  expect(slice().web.webAccess, "WEB_SLICE_PI").toBeFunction();
  expect(slice({ backendId: "claude" }).web.webAccess, "WEB_SLICE_NOT_CLAUDE").toBeUndefined();
  expect(slice({ work: { posture: "voice" } }).web.webAccess, "WEB_SLICE_VOICE_TOO").toBeFunction();
  expect(slice({ host: {} }).web.webAccess, "WEB_SLICE_NEEDS_BROKER").toBeUndefined();
});

test("the scope is the turn's, and a turn without a profile or session is refused", async () => {
  const { web, scopes } = slice();
  await web.webAccess!({ tool: "web_search", input: { query: "Odysseus", principalId: "p-antinous" }, toolCallId: "call-1" });
  expect(scopes, "WEB_SLICE_SCOPE_FROM_TURN").toEqual([{ principalId: "p-penelope", sessionId: "s-ithaca", turnId: "t-voyage", toolCallId: "call-1", profile: "strict", policyRevision: "rev-7" }]);
  for (const [label, made] of [["profile", slice({ workerProfile: undefined })], ["session", slice({}, null)]] as const) {
    expect(await made.web.webAccess!({ tool: "web_search", input: { query: "Odysseus" }, toolCallId: "call-2" }), `WEB_SLICE_NEEDS_${label}`)
      .toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(made.scopes).toEqual([]);
  }
});
