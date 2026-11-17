import { expect, test } from "bun:test";
import { connect } from "node:net";
import { EgressAdmissionRefused, startEgressProxy, type EgressRecord } from "../src/server/egress-proxy";

const github = new URL("https://github.com/odysseus/ithaca");
const options = (records: EgressRecord[]) => ({ mode: "record" as const, allow: [], deny: [], maxBytes: 32, outwardHosts: [], observe: (r: EgressRecord) => records.push(r) });

test("managed reference shares the real turn counter with inference and refuses the exhausted turn", async () => {
  const records: EgressRecord[] = [], proxy = await startEgressProxy(options(records)), signal = new AbortController().signal;
  try {
    const inference = proxy.inference("POST", new URL("https://api.anthropic.com/v1/messages"), signal);
    expect(await inference.admit()).toBe(true); expect(inference.charge(10)).toBe(true); inference.finish("completed");
    const reference = proxy.managedReference(github, signal);
    expect(await reference.admit()).toBe(true); expect(reference.charge(22)).toBe(true); reference.finish("completed");
    expect(proxy.usedBytes(), "REFERENCE_SHARES_TURN_WIRE_COUNTER").toBe(32);
    const refused = proxy.managedReference(github, signal);
    expect(await refused.admit(), "REFERENCE_EXHAUSTED_TURN_REFUSED").toBe(false);
    expect(records[1]).toMatchObject({ managedReference: true, accounting: "opaque_bytes", bytes: 22, outcome: "completed" });
    expect(records[2]).toMatchObject({ managedReference: true, reason: "max_bytes_per_turn", bytes: 0 });
  } finally { proxy.stop(); }
});

test("managed reference retains independent restricted-recipient admission while provider routing retains G5", async () => {
  const records: EgressRecord[] = [], proxy = await startEgressProxy({ ...options(records),
    taint: { allow: [], tainted: () => true, contacted: () => false } }), signal = new AbortController().signal;
  try {
    const reference = proxy.managedReference(github, signal);
    expect(await reference.admit(), "REFERENCE_TRUST_NEVER_AUTHORIZES_RESTRICTED_RECIPIENT").toBe(false);
    const provider = proxy.relayed("POST", new URL("https://api.anthropic.com/v1/messages"), signal);
    expect(await provider.admit()).toBe(true); provider.finish("completed");
    expect(records[0]).toMatchObject({ managedReference: true, reason: "taint_not_allowed" });
  } finally { proxy.stop(); }
});

test("managed reference rechecks narrowing after its own final wait and still honors deny and outward refusal", async () => {
  for (const mode of ["deny", "outward", "final"] as const) {
    let restricted = false;
    const records: EgressRecord[] = [], proxy = await startEgressProxy({ ...options(records), deny: mode === "deny" ? ["github.com"] : [],
      outwardHosts: mode === "outward" ? ["github.com"] : [], approveOutward: async () => false,
      taint: { allow: [], tainted: () => restricted, contacted: () => false } });
    try {
      const ref = proxy.managedReference(github, new AbortController().signal);
      if (mode === "final") { expect(await ref.admit()).toBe(true); restricted = true; expect(ref.commit(), "REFERENCE_FINAL_RECIPIENT_FENCE").toBe(false); }
      else expect(await ref.admit(), "REFERENCE_ORDINARY_EGRESS_POLICY_RETAINS_AUTHORITY").toBe(false);
      expect(records.at(-1)?.outcome).toBe("denied");
    } finally { proxy.stop(); }
  }
});

test("raw Unix CONNECT headers cannot claim the host managed-reference channel", async () => {
  const records: EgressRecord[] = [], admitted: boolean[] = [];
  const proxy = await startEgressProxy({ ...options(records), admitted: destination => {
    admitted.push(destination.managedReference); throw new EgressAdmissionRefused("No worker authority");
  } });
  try {
    const text = await new Promise<string>((resolve, reject) => {
      const socket = connect(proxy.socketPath); let text = "";
      socket.once("connect", () => socket.end("CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\nX-Brain-Managed-Reference: true\r\n\r\n"));
      socket.on("data", chunk => { text += chunk; }); socket.once("close", () => resolve(text)); socket.once("error", reject);
    });
    expect(text).toContain("403"); expect(admitted, "REFERENCE_CHANNEL_IS_HOST_OWNED").toEqual([false]);
    expect(records[0]).not.toHaveProperty("managedReference");
  } finally { proxy.stop(); }
});

test("managed reference refuses other protocols, credentials, recipients, queries and ports", async () => {
  const proxy = await startEgressProxy(options([]));
  try {
    for (const input of ["http://github.com/odysseus/ithaca", "https://token@github.com/odysseus/ithaca", "https://github.com.evil.example/odysseus/ithaca",
      "https://api.github.com:444/repos/odysseus/ithaca", "https://github.com/odysseus/ithaca?probe=1", "https://github.com/odysseus/ithaca#fragment"])
      expect(() => proxy.managedReference(new URL(input), new AbortController().signal), "REFERENCE_FIXED_WIRE_RECIPIENT").toThrow();
  } finally { proxy.stop(); }
});
