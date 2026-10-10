// Shipped provider and command behaviour the audit-capability live harness
// first exercised (#1386 split it from the harness's spend and pricing tests
// in experiments/audit-capability-live.test.ts). The scripted HTTP and the
// harness `completion` wrapper are drivers around the shipped
// `anthropicCompletions` text-block parsing and the real `audit --fix` command.
import { expect, test } from "bun:test";
import { completion, Spend, type PhysicalCall } from "../scripts/evals/audit-capabilities/live";
import { MODEL } from "../scripts/evals/audit-capabilities/protocol";

test("shipped Anthropic text-block request and newline parsing retain max-token answer behavior", async () => {
  const calls: PhysicalCall[] = []; const spend = new Spend(15, calls, () => {});
  const provider = completion(spend, "watch-with-todo", 0, "offline-credential", async (_url, init) => {
    const request = JSON.parse(String(init.body));
    expect(request.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Two findings" }] }]);
    return Response.json({ model: MODEL, stop_reason: "max_tokens", content: [{ type: "thinking", thinking: "not returned as completion text" }, { type: "text", text: "first" }, { type: "text", text: "second" }], usage: { input_tokens: 100, output_tokens: 2000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, service_tier: "standard", inference_geo: "global" } });
  });
  expect(await provider.complete({ prompt: "Two findings", maxTokens: 2000 })).toBe("first\nsecond");
  expect((calls[0]!.response as any).stop_reason).toBe("max_tokens");
  expect(spend.stopped).toBe(false);
});

test("real command ignores malformed provider responses while direct provider controls retain physical receipts", async () => {
  const { cases, commandOutput, detect, prepareBenchmark } = await import("../scripts/evals/audit-capabilities/benchmark");
  const f = cases.find(f => f.id === "menelaus-quoted-order")!;
  for (const text of ["[null]", '["Odysseus",13]']) {
    const p = await prepareBenchmark(f); const calls: PhysicalCall[] = [], spend = new Spend(15, calls, () => {});
    try {
      const detected = await detect(p); expect(detected.report.issues.length).toBeGreaterThan(0);
      const provider = completion(spend, f.id, 0, "offline-credential", async () => Response.json({ model: MODEL, content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }));
      const output = await commandOutput(p, true, provider) as any[];
      expect(calls).toHaveLength(0);
      expect(output).toEqual(detected.report.issues.map(issue => ({ path: issue.path, issue: issue.message, suggestion: issue.suggestion || "Manual review needed.", canAutoFix: false })));
      expect(await provider.complete({ prompt: "Offline parser control", maxTokens: 2000 })).toBe(text);
      expect(calls).toHaveLength(1); expect(calls[0]!.completionText).toBe(text); expect(calls[0]!.cost!.upperUsd).toBeGreaterThan(0);
      expect(spend.stopped).toBe(false);
      if (text === "[null]") {
        expect(calls[0]!.parserDiagnostic).toEqual({ kind: "manual-fallback", reason: "entry-normalization-error", rawEntries: 1 });
        expect(output.length).toBe(detected.report.issues.length); expect(output.every(row => row.canAutoFix === false)).toBe(true);
      } else {
        expect(calls[0]!.parserDiagnostic).toEqual({ kind: "parsed-array", reason: null, rawEntries: 2, nonObjectEntries: 2 });
      }
    } finally { p.close(); }
  }
});
