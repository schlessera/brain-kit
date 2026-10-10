import { expect, test } from "bun:test";
import { captureSurface } from "../scripts/capture-turn-surface";
import { attributeTokenCounts, tokenGroupPayloads } from "../scripts/turn-surface-token-groups";
import { countSurfaceTokens } from "../scripts/measure-turn-surface-tokens";

// The installed-CLI tool-surface assertions this test used to open with live
// in tests/installed-turn-surface.test.ts (#1386); this file keeps the
// token-group measurement over the same capture.
test("token groups partition the captured request and reject missing classification evidence", async () => {
  const capture = await captureSurface();
  const payloads = tokenGroupPayloads(capture.request);
  expect(payloads[0]!.body.tools).toHaveLength(0);
  expect(JSON.stringify(payloads[0]!.body.messages)).not.toContain("voyage-plan:");
  expect(payloads[1]!.body.tools.length).toBeGreaterThan(0);
  expect(payloads[2]!.body.tools.length - payloads[1]!.body.tools.length).toBe(0);
  expect(JSON.stringify(payloads[0]!.body.messages)).not.toContain("mcp__brain__brain_read");
  expect(JSON.stringify(payloads[1]!.body.messages)).not.toContain("mcp__brain__brain_read");
  expect(JSON.stringify(payloads[1]!.body.messages)).toContain("WebFetch");
  expect(JSON.stringify(payloads[2]!.body.messages)).toContain("mcp__brain__brain_read");
  expect(payloads[3]!.body.tools.length - payloads[2]!.body.tools.length).toBe(12);
  expect(payloads[4]!.body.tools).toEqual(capture.request.tools);
  expect(payloads[4]!.body.messages).toEqual(capture.request.messages);
  // Missing classification/listing evidence must reject the measurement.
  expect(() => tokenGroupPayloads({ ...capture.request, messages: JSON.parse(JSON.stringify(capture.request.messages)
    .replace(/mcp__brain__brain_[a-z]+\\n/g, "")) })).toThrow("Missing tool category");
  expect(() => tokenGroupPayloads({ ...capture.request, messages: [{ role: "user", content: "No skill listing." }] })).toThrow("deferred-tool listing");
});

test("ordered marginals retain tokenizer interactions and reject missing counts", () => {
  const counts = [
    { group: "everythingElse" as const, inputTokens: 100 }, { group: "builtinTools" as const, inputTokens: 143 },
    { group: "brainMcpTools" as const, inputTokens: 190 }, { group: "bridgeTools" as const, inputTokens: 250 },
    { group: "skillListing" as const, inputTokens: 247 },
  ];
  expect(attributeTokenCounts(counts).map(row => row.marginalTokens)).toEqual([100, 43, 47, 60, -3]);
  expect(() => attributeTokenCounts(counts.slice(0, 4))).toThrow("Missing or invalid");
  expect(() => attributeTokenCounts(counts.map(row => ({ ...row, inputTokens: NaN })))).toThrow("Missing or invalid");
});

test("token instrument records provider receipts and stops at a failed request", async () => {
  const received: Array<Record<string, unknown>> = [];
  const tokens = [10, 25, 44, 100, 120];
  const report = await countSurfaceTokens("offline-fixture-key", (async (url, init) => {
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages/count_tokens");
    received.push(JSON.parse(String(init?.body)));
    return Response.json({ input_tokens: tokens[received.length - 1] });
  }));
  expect(received).toHaveLength(5);
  expect(received.every(body => body.model === "claude-sonnet-5-5")).toBe(true);
  expect(report.rows.map(row => row.marginalTokens)).toEqual([10, 15, 19, 56, 20]);
  let failedRequests = 0;
  await expect(countSurfaceTokens("offline-fixture-key", (async () => {
    failedRequests++;
    return new Response("controlled rejection", { status: 503 });
  }))).rejects.toThrow("everythingElse: HTTP 503");
  expect(failedRequests).toBe(1);
});
