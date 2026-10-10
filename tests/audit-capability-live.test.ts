import { expect, test } from "bun:test";
import { completion, priceUsage, Spend, type PhysicalCall } from "../scripts/evals/audit-capabilities/live";
import { tokenTotal } from "../scripts/evals/audit-capabilities/analyze";
import { MODEL } from "../scripts/evals/audit-capabilities/protocol";

// The shipped text-block parsing and real-command assertions this file used to
// hold live in tests/audit-provider-completions.test.ts (#1386).

test("physical baseline attempt persists before HTTP, retains selectors/raw TTL usage, and uses independent official arithmetic", async () => {
  const calls: PhysicalCall[] = []; let saves = 0; let body: any;
  const spend = new Spend(15, calls, () => { saves++; });
  const provider = completion(spend, "raft-board", 0, "offline-credential", async (_url, init) => {
    expect(calls).toHaveLength(1); expect(calls[0]!.outcome).toBe("pending"); expect(saves).toBe(1);
    body = JSON.parse(String(init.body));
    return Response.json({ model: MODEL, stop_reason: "end_turn", content: [{ type: "text", text: "[]" }], usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 }, service_tier: "standard", inference_geo: "global" } }, { headers: { "request-id": "offline-attempt" } });
  });
  expect(await provider.complete({ prompt: "One detected finding", maxTokens: 2000 })).toBe("[]");
  expect(body).toMatchObject({ model: MODEL, service_tier: "standard_only", inference_geo: "global", max_tokens: 2000 });
  // 100 input at $2/M, 10 output at $10/M, 20 reads at $0.10/M, 10 5m at $2.50/M, 20 1h at $4/M.
  expect(calls[0]!.cost).toEqual({ lowerUsd: .000407, upperUsd: .000407 });
  expect(calls[0]!.returnedTier).toBe("standard"); expect(calls[0]!.returnedGeo).toBe("global");
  expect(calls[0]!.headers["request-id"]).toBe("offline-attempt"); expect(spend.stopped).toBe(false);
});

test("lost raw usage stops every later admission and preserves the attempted response", async () => {
  const calls: PhysicalCall[] = []; let physical = 0;
  const spend = new Spend(15, calls, () => {});
  const provider = completion(spend, "raft-board", 0, "offline-credential", async () => {
    physical++; return Response.json({ model: MODEL, stop_reason: "end_turn", content: [{ type: "text", text: "[]" }] });
  });
  await expect(provider.complete({ prompt: "A real finding", maxTokens: 2000 })).rejects.toThrow("Raw usage missing");
  expect(calls).toHaveLength(1); expect(calls[0]!.response).toMatchObject({ model: MODEL });
  expect(calls[0]!.cost).toBeNull(); expect(spend.stopped).toBe(true);
  await expect(provider.complete({ prompt: "Another real finding", maxTokens: 2000 })).rejects.toThrow("before physical dispatch");
  expect(physical).toBe(1);
});

test("budget reservation and full runtime mismatch refuse before any physical request", async () => {
  let physical = 0; const http = async () => { physical++; throw Error("should never dispatch"); };
  const low = new Spend(.001, [], () => {});
  let budgetError = "";
  try { await completion(low, "raft-board", 0, "offline-credential", http).complete({ prompt: "real finding", maxTokens: 2000 }); } catch (error) { budgetError = String(error); }
  expect(physical).toBe(0);
  expect(budgetError).toContain("before physical dispatch");
  const changed = new Spend(15, [], () => {});
  await expect(completion(changed, "raft-board", 0, "offline-credential", http, () => { throw Error("Runtime changed"); }).complete({ prompt: "real finding", maxTokens: 2000 })).rejects.toThrow("Runtime changed");
  expect(physical).toBe(0); expect(changed.stopped).toBe(true);
});

test("missing cache TTL remains a nonzero interval rather than an invented exact bill", () => {
  expect(priceUsage({ input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 })).toEqual({ lowerUsd: .000377, upperUsd: .000422 });
  expect(priceUsage({ input_tokens: 100, output_tokens: 10 })).toBeNull();
});

test("known subtotal stays separate from unknown aggregate after a lost physical receipt", async () => {
  const calls: PhysicalCall[] = []; const spend = new Spend(15, calls, () => {}); let physical = 0;
  const provider = completion(spend, "raft-board", 0, "offline-credential", async () => {
    physical++;
    return Response.json({ model: MODEL, content: [{ type: "text", text: "[]" }], ...(physical === 1 ? { usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } : {}) });
  });
  await provider.complete({ prompt: "First finding", maxTokens: 2000 });
  expect(spend.usedUpper).toBe(.0003); expect(spend.aggregateUpperUsd).toBe(.0003);
  await expect(provider.complete({ prompt: "Second finding", maxTokens: 2000 })).rejects.toThrow("Raw usage missing");
  expect(spend.usedUpper).toBe(.0003); expect(spend.unknownCostAttempts).toBe(1); expect(spend.aggregateUpperUsd).toBeNull();
  expect(tokenTotal(calls, "input_tokens")).toBeNull(); expect(tokenTotal([calls[0]!], "input_tokens")).toBe(100);
  await expect(provider.complete({ prompt: "Third finding", maxTokens: 2000 })).rejects.toThrow("before physical dispatch"); expect(physical).toBe(2);
});

