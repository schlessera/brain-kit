import { expect, test } from "bun:test";
import { completion, Spend, type PhysicalCall } from "../scripts/evals/audit-capabilities/live";
import { MODEL } from "../scripts/evals/audit-capabilities/protocol";

const prompt = "Review the unresolved Odysseus raft-board finding.";
const response = (usage: Record<string, unknown>, status = 200) => Response.json({
  model: MODEL, stop_reason: "end_turn", content: [{ type: "text", text: "[]" }], usage,
}, { status });
const validUsage = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

test("short-wire actual baseline refuses below full-context allowance before lowest HTTP forwarding", async () => {
  let forwarded = 0; const calls: PhysicalCall[] = [];
  const spend = new Spend(3, calls, () => {});
  const provider = completion(spend, "raft-board", 0, "offline-credential", async () => {
    forwarded++; return response(validUsage);
  });
  let failure = "";
  try { await provider.complete({ prompt, maxTokens: 2000 }); } catch (error) { failure = String(error); }
  // Assert the actual transport first: the old byte estimate forwards a request.
  expect(forwarded).toBe(0);
  expect(failure).toContain("before physical dispatch");
  expect(calls).toHaveLength(0);
  expect(spend.stopped).toBe(true);
});

test("complete counters above wire length settle full-context hold without inventing an invoice", async () => {
  const calls: PhysicalCall[] = []; const spend = new Spend(15, calls, () => {});
  const provider = completion(spend, "raft-board", 0, "offline-credential", async (_url, init) => {
    const call = calls[0]!; const request = JSON.parse(String(init.body));
    expect(request.messages).toEqual([{ role: "user", content: [{ type: "text", text: prompt }] }]);
    expect(request).toMatchObject({ model: MODEL, max_tokens: 2000, service_tier: "standard_only", inference_geo: "global" });
    expect(call.requestBytes).toBe(Buffer.byteLength(String(init.body)));
    expect(call.requestBytes).toBeLessThan(5000);
    expect(call.inputTokenUpperBound).toBe(1_000_000); expect(call.outputTokenUpperBound).toBe(2000);
    expect(call.reservedUpperUsd).toBe(8.04); expect(call.retainedReservationUpperUsd).toBe(8.04);
    expect(spend.reservedUpperUsd).toBe(8.04); expect(call.actualInvoiceUsd).toBeNull();
    return response({ ...validUsage, input_tokens: 5000 });
  });
  expect(await provider.complete({ prompt, maxTokens: 2000 })).toBe("[]");
  expect(calls).toHaveLength(1); expect(calls[0]!.response).toMatchObject({ usage: { input_tokens: 5000 } });
  expect(calls[0]!.chargeDebitUpperUsd).toBe(.0402);
  expect(spend.knownChargeDebitUpperUsd).toBe(.0402); expect(spend.usedUpper).toBe(.0101);
  expect(spend.reservedUpperUsd).toBe(0); expect(calls[0]!.retainedReservationUpperUsd).toBe(0);
  expect(calls[0]!.actualInvoiceUsd).toBeNull(); expect(spend.stopped).toBe(false);
});

const unresolvedUsage = [
  ["missing output", { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }],
  ["over input", { ...validUsage, input_tokens: 1_000_001 }],
  ["over combined input/cache", { ...validUsage, input_tokens: 500_000, cache_read_input_tokens: 500_001 }],
  ["over output", { ...validUsage, output_tokens: 2001 }],
  ["negative cache", { ...validUsage, cache_read_input_tokens: -1 }],
  ["fractional output", { ...validUsage, output_tokens: 10.5 }],
  ["contradictory TTL", { ...validUsage, cache_creation_input_tokens: 20, cache_creation: { ephemeral_5m_input_tokens: 21, ephemeral_1h_input_tokens: 0 } }],
  ["TTL writes despite zero total", { ...validUsage, cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 0 } }],
  ["malformed TTL object", { ...validUsage, cache_creation_input_tokens: 20, cache_creation: "unknown" }],
] as const;
for (const [name, usage] of unresolvedUsage) test(`${name} receipt retains full hold and refuses next actual HTTP attempt`, async () => {
  let forwarded = 0; const calls: PhysicalCall[] = []; const spend = new Spend(15, calls, () => {});
  const provider = completion(spend, "raft-board", 0, "offline-credential", async () => {
    forwarded++; return response(forwarded === 1 ? usage : validUsage);
  });
  let firstFailure = "", secondFailure = "";
  try { await provider.complete({ prompt, maxTokens: 2000 }); } catch (error) { firstFailure = String(error); }
  try { await provider.complete({ prompt: "Review the next Odysseus finding.", maxTokens: 2000 }); } catch (error) { secondFailure = String(error); }
  // The next-attempt witness comes first so guard-removal mutations cannot be
  // masked by diagnostic/outcome assertions about the initial response.
  expect(forwarded).toBe(1);
  expect(firstFailure).toContain("Raw usage"); expect(secondFailure).toContain("before physical dispatch");
  expect(calls).toHaveLength(1); expect(calls[0]!.response).toMatchObject({ usage });
  expect(calls[0]!.cost).toBeNull(); expect(calls[0]!.chargeDebitUpperUsd).toBeNull();
  expect(spend.reservedUpperUsd).toBe(8.04); expect(calls[0]!.retainedReservationUpperUsd).toBe(8.04);
  expect(spend.knownChargeDebitUpperUsd).toBe(0); expect(spend.aggregateUpperUsd).toBeNull();
  expect(spend.unknownCostAttempts).toBe(1); expect(spend.stopped).toBe(true); expect(calls[0]!.actualInvoiceUsd).toBeNull();
});

test("single in-flight actual provider holds the allowance until its owned response settles", async () => {
  let forwarded = 0; let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const calls: PhysicalCall[] = []; const spend = new Spend(15, calls, () => {});
  const provider = completion(spend, "raft-board", 0, "offline-credential", async () => {
    forwarded++; if (forwarded === 1) await pending; return response(validUsage);
  });
  const first = provider.complete({ prompt, maxTokens: 2000 });
  let secondFailure = "";
  try { await provider.complete({ prompt: "Concurrent Odysseus finding.", maxTokens: 2000 }); } catch (error) { secondFailure = String(error); }
  const forwardsBeforeRelease = forwarded;
  release(); await first;
  expect(forwardsBeforeRelease).toBe(1); expect(secondFailure).toContain("before physical dispatch");
  expect(calls).toHaveLength(1); expect(calls[0]!.chargeDebitUpperUsd).toBe(.001);
  expect(spend.reservedUpperUsd).toBe(0);
});

test("shipped transient retry reaches admission but never forwards after unresolved HTTP failure", async () => {
  let forwarded = 0; const calls: PhysicalCall[] = []; const spend = new Spend(15, calls, () => {});
  const provider = completion(spend, "raft-board", 0, "offline-credential", async () => {
    forwarded++;
    return forwarded === 1 ? Response.json({ error: { type: "overloaded_error", message: "Controlled failure" } }, { status: 503 }) : response(validUsage);
  });
  let failure = "";
  try { await provider.complete({ prompt, maxTokens: 2000 }); } catch (error) { failure = String(error); }
  expect(forwarded).toBe(1); expect(failure).toContain("before physical dispatch");
  expect(calls).toHaveLength(1); expect(calls[0]!.status).toBe(503); expect(calls[0]!.outcome).toBe("http_error");
  expect(spend.reservedUpperUsd).toBe(8.04); expect(spend.aggregateUpperUsd).toBeNull();
  expect(calls[0]!.response).toMatchObject({ error: { type: "overloaded_error" } });
  expect(calls[0]!.actualInvoiceUsd).toBeNull();
});

test("completed attempts debit shared remaining allowance before the next full-context request", async () => {
  let forwarded = 0; const calls: PhysicalCall[] = []; const spend = new Spend(8.06, calls, () => {});
  const provider = completion(spend, "raft-board", 0, "offline-credential", async () => {
    forwarded++; return response({ ...validUsage, input_tokens: 5000 });
  });
  await provider.complete({ prompt, maxTokens: 2000 });
  let failure = "";
  try { await provider.complete({ prompt, maxTokens: 2000 }); } catch (error) { failure = String(error); }
  expect(forwarded).toBe(1); expect(failure).toContain("before physical dispatch");
  expect(spend.knownChargeDebitUpperUsd).toBe(.0402); expect(spend.reservedUpperUsd).toBe(0);
  expect(calls).toHaveLength(1);
});

test("over-bound raw input keeps the full hold even when its diagnostic price fits the reserved dollars", async () => {
  const calls: PhysicalCall[] = []; const spend = new Spend(15, calls, () => {});
  const provider = completion(spend, "raft-board", 0, "offline-credential", async () => response({ ...validUsage, input_tokens: 1_000_001 }));
  let failure = "";
  try { await provider.complete({ prompt, maxTokens: 2000 }); } catch (error) { failure = String(error); }
  expect(spend.reservedUpperUsd).toBe(8.04);
  expect(failure).toContain("admitted input/output bounds"); expect(calls[0]!.outcome).toBe("over_bound_usage");
  expect(calls[0]!.cost).toBeNull(); expect(calls[0]!.chargeDebitUpperUsd).toBeNull();
  expect(spend.knownChargeDebitUpperUsd).toBe(0);
});
