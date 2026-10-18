import { expect, test } from "bun:test";
import { request } from "node:http";
import { resolveGovernancePolicy, type GovernancePolicyInput } from "@schlessera/brain-common/internal/governance-policy";
import type { BackendBridge, PermissionDecision } from "@schlessera/brain-ui-sdk/server";
import { createUiDb } from "../src/db/client.js";
import { queryGovernanceEvents, recordGovernanceEvent } from "../src/governance/events.js";
import { prepareTurnEgress } from "../src/brain/turn-egress.js";

function get(socketPath: string, target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = request({ socketPath, path: target }, response => {
      response.resume(); response.once("end", () => resolve(response.statusCode!));
      response.once("error", reject);
    });
    child.once("error", reject); child.end();
  });
}
const bridge = (requestPermission: BackendBridge["requestPermission"]): BackendBridge => ({ requestPermission }) as BackendBridge;
const inputs = (controller: AbortController, policy: GovernancePolicyInput = { schema_version: 1 }) => ({
  controller, policy: resolveGovernancePolicy(policy), turnId: "turn-ithaca", sessionId: () => null,
  model: () => "claude-haiku-4-5", profile: "governed" as const, origin: "interactive" as const,
  bridge: bridge(async () => ({ behavior: "deny", message: "Odysseus declines" })),
});

test("a real turn proxy durably records bounded connection facts without the query", async () => {
  const db = createUiDb(":memory:");
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Ithaca") });
  const proxy = await prepareTurnEgress({ ...inputs(new AbortController()), record: event => recordGovernanceEvent(db, event) });
  try {
    expect(await get(proxy.socketPath, `${origin.url}voyage?private=odysseus-query`)).toBe(200);
    proxy.stop();
    const rows = queryGovernanceEvents(db, { kinds: ["egress_connection"], limit: 10 });
    expect(rows, "TURN_EGRESS_DURABLE_CONNECTION").toHaveLength(1);
    expect(rows[0]).toMatchObject({ turnId: "turn-ithaca", actor: "interactive", profile: "governed",
      payload: { host: "127.0.0.1", port: origin.port, path: "/voyage", method: "GET", outcome: "completed" } });
    expect(JSON.stringify(rows)).not.toContain("odysseus-query");
    expect(proxy.recordingFailure()).toBeUndefined();
  } finally { proxy.stop(); origin.stop(true); db.close(); }
});

const refusalCases: Array<[string, NonNullable<GovernancePolicyInput["egress"]>]> = [
  ["denied_host", { mode: "allowlist", allow: ["127.0.0.1"], deny: ["127.0.0.1"] }],
  ["not_allowlisted", { mode: "allowlist", allow: ["ithaca.invalid"] }],
  ["byte_cap", { max_bytes_per_turn: 1 }],
];
for (const [reason, egress] of refusalCases) test(`a real turn refusal durably retains ${reason} before contacting the origin`, async () => {
  const db = createUiDb(":memory:"); let calls = 0;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return new Response("Ithaca"); } });
  const proxy = await prepareTurnEgress({ ...inputs(new AbortController(), { schema_version: 1, egress }),
    record: event => recordGovernanceEvent(db, event) });
  try {
    expect(await get(proxy.socketPath, origin.url.href)).toBe(403);
    expect(calls, "TURN_EGRESS_REFUSAL_BEFORE_CONTACT").toBe(0);
    expect(queryGovernanceEvents(db, { kinds: ["egress_denial"], limit: 10 }), "TURN_EGRESS_DURABLE_DENIAL").toMatchObject([
      { payload: { host: "127.0.0.1", port: origin.port, method: "GET", reason, bytes: 0 } },
    ]);
    expect(proxy.recordingFailure()).toBeUndefined();
  } finally { proxy.stop(); origin.stop(true); db.close(); }
});

for (const failingKind of ["egress_connection", "egress_denial"] as const) test(`a failed ${failingKind} recorder aborts the owning turn and retains its failure`, async () => {
  const controller = new AbortController(); let attempts = 0;
  const proxy = await prepareTurnEgress({ ...inputs(controller, { schema_version: 1, egress: { mode: "allowlist", allow: [] } }),
    record(event) { attempts++; if (event.kind === failingKind) throw new Error("Fictional unavailable ledger"); } });
  try {
    await get(proxy.socketPath, "http://127.0.0.1:1/voyage").catch(() => undefined);
    expect(controller.signal.aborted, "TURN_EGRESS_FAILED_RECORD_ABORTS").toBe(true);
    expect(proxy.recordingFailure()?.message).toBe("Turn egress recording is unavailable");
    expect(controller.signal.reason).toBe(proxy.recordingFailure());
    expect(attempts).toBe(failingKind === "egress_connection" ? 1 : 2);
  } finally { proxy.stop(); }
});

test("a turn's outward connection waits for its bridge decision before contact", async () => {
  let calls = 0, approve!: (value: PermissionDecision) => void, observed!: () => void;
  let refuseMissingCard!: (error: Error) => void;
  const permission = new Promise<void>((resolve, reject) => { observed = resolve; refuseMissingCard = reject; });
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return new Response("Ithaca"); } });
  const proxy = await prepareTurnEgress({ ...inputs(new AbortController(), { schema_version: 1, outward: { hosts: ["127.0.0.1"] } }),
    bridge: bridge(() => { observed(); return new Promise(resolve => { approve = resolve; }); }), record() {} });
  const response = get(proxy.socketPath, origin.url.href);
  const deadline = setTimeout(() => refuseMissingCard(new Error("TURN_EGRESS_OUTWARD_CARD_REQUIRED")), 5_000);
  try {
    await permission;
    expect(calls, "TURN_EGRESS_OUTWARD_WAITS_FOR_CARD").toBe(0);
    approve({ behavior: "allow" });
    expect(await response).toBe(200); expect(calls).toBe(1);
  } finally { clearTimeout(deadline); approve?.({ behavior: "deny", message: "Fixture cleanup" }); proxy.stop(); await response.catch(() => undefined); origin.stop(true); }
});

test("voice without a grant surface refuses the outward connection", async () => {
  let calls = 0, asks = 0;
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return new Response("Ithaca"); } });
  const proxy = await prepareTurnEgress({ ...inputs(new AbortController(), { schema_version: 1, outward: { hosts: ["127.0.0.1"] } }),
    origin: "voice", bridge: bridge(async () => { asks++; return { behavior: "allow" }; }), record() {} });
  try {
    expect(await get(proxy.socketPath, origin.url.href)).toBe(403);
    expect(calls).toBe(0); expect(asks, "TURN_EGRESS_VOICE_NO_APPROVAL_SURFACE").toBe(0);
  } finally { proxy.stop(); origin.stop(true); }
});
