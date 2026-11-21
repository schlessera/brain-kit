import { expect, spyOn, test } from "bun:test";
import { resolveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import type { BackendBridge } from "@schlessera/brain-ui-sdk/server";
import * as transport from "../../ui-sdk/src/server/egress-proxy";
import * as binding from "../src/ws/bridge-session-binding";
import { prepareTurnEgress } from "../src/brain/turn-egress";
import type { GovernanceEventInput } from "../src/governance/events";
const inputs = (controller: AbortController) => ({ controller,
  policy: resolveGovernancePolicy({ schema_version: 1, egress: { mode: "allowlist", allow: [] } }),
  turnId: "turn-ithaca", sessionId: () => null, model: () => null, profile: "governed" as const, origin: "interactive" as const,
  bridge: { emit() {}, async requestPermission() { return { behavior: "deny" }; } } as unknown as BackendBridge });

test("stop and settled cannot outrun a denied inference audit", async () => {
  const original = transport.startEgressProxy;
  let inference!: Awaited<ReturnType<typeof original>>["inference"];
  const capture = spyOn(transport, "startEgressProxy").mockImplementation(async options => {
    const proxy = await original(options); inference = proxy.inference; return proxy;
  });
  const controller = new AbortController(), audit = Promise.withResolvers<void>(); let submitted = 0, drained = false;
  const proxy = await prepareTurnEgress({ ...inputs(controller), record(event) {
    if (event.kind === "egress_connection") { submitted++; return audit.promise; }
  } });
  try {
    const operation = inference("POST", new URL("https://api.anthropic.com/v1/messages"), new AbortController().signal);
    const admitting = operation.admit(); proxy.stop();
    const settling = proxy.settled().then(() => { drained = true; });
    await Promise.resolve();
    expect(submitted, "DENIED_AUDIT_SUBMITTED_BEFORE_STOP_RETURNS").toBe(1);
    expect(drained, "SETTLED_JOINS_DENIED_ADMISSION_AUDIT").toBe(false);
    audit.reject(Error("audit unavailable")); await admitting; await settling;
    expect(proxy.recordingFailure()).toBeDefined(); expect(controller.signal.aborted).toBe(true);
  } finally { audit.resolve(); capture.mockRestore(); proxy.stop(); await proxy.settled(); }
});

test("a session-binding refusal includes its completed admission clock", async () => {
  let now = 1000;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const ready = Promise.withResolvers<binding.SessionBindingRefusal | null>(), entered = Promise.withResolvers<void>();
  const bindingWait = spyOn(binding, "settleTurnSessionBinding").mockImplementation(async () => { entered.resolve(); return ready.promise; });
  const records: GovernanceEventInput[] = [];
  const proxy = await prepareTurnEgress({ ...inputs(new AbortController()), record(event) { if (event.kind === "egress_connection") records.push(event); } });
  try {
    const op = proxy.inference("POST", new URL("https://api.anthropic.com/v1/messages"), new AbortController().signal);
    const admission = op.admit(); await entered.promise; now += 250; ready.resolve("session_binding_unavailable");
    expect(await admission).toBe(false); await proxy.settled();
    expect(records[0]?.payload, "BINDING_REFUSAL_RETAINS_ADMISSION_CLOCK").toMatchObject({ outcome: "denied", reason: "session_binding_unavailable", admitMs: 250 });
  } finally { ready.resolve("session_binding_unavailable"); proxy.stop(); bindingWait.mockRestore(); clock.mockRestore(); }
});
