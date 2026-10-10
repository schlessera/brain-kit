// Shipped provider and command behaviour the audit-capability live harness
// first exercised (#1386 split it from the harness's spend and pricing tests).
// A scripted `fetch` at the lowest HTTP boundary drives the shipped
// `anthropicCompletions` text-block request and parsing and the real
// `audit --fix` command; the brains are local fixtures in tests/fixtures/audit-fix/.
import { expect, spyOn, test } from "bun:test";
import { anthropicCompletions } from "../packages/core/src/providers/completions/anthropic";
import { cases, commandOutput, detect, prepareBenchmark } from "./fixtures/audit-fix/prepare";

const MODEL = "claude-sonnet-5-5";
const KEY_ENV = "BRAIN_AUDIT_TEST_KEY";

/** The shipped provider with a scripted HTTP boundary; every request is recorded. */
async function withScriptedProvider(reply: (request: any) => Response, run: (provider: ReturnType<typeof anthropicCompletions>, requests: any[]) => Promise<void>) {
  const requests: any[] = [];
  const previousKey = process.env[KEY_ENV];
  process.env[KEY_ENV] = "offline-credential";
  const http = spyOn(globalThis, "fetch").mockImplementation((async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
    const request = JSON.parse(String(init!.body));
    requests.push(request);
    return reply(request);
  }) as typeof fetch);
  try { await run(anthropicCompletions({ model: MODEL, apiKeyEnv: KEY_ENV }), requests); }
  finally {
    http.mockRestore();
    if (previousKey === undefined) delete process.env[KEY_ENV]; else process.env[KEY_ENV] = previousKey;
  }
}

test("shipped Anthropic text-block request and newline parsing retain max-token answer behavior", async () => {
  await withScriptedProvider(request => {
    expect(request.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Two findings" }] }]);
    expect(request.model).toBe(MODEL);
    expect(request.max_tokens).toBe(2000);
    return Response.json({ model: MODEL, stop_reason: "max_tokens", content: [{ type: "thinking", thinking: "not returned as completion text" }, { type: "text", text: "first" }, { type: "text", text: "second" }], usage: { input_tokens: 100, output_tokens: 2000 } });
  }, async (provider, requests) => {
    expect(await provider.complete({ prompt: "Two findings", maxTokens: 2000 })).toBe("first\nsecond");
    expect(requests).toHaveLength(1);
  });
});

test("real command ignores malformed provider responses while direct provider controls return the raw text", async () => {
  const f = cases.find(f => f.id === "menelaus-quoted-order")!;
  for (const text of ["[null]", '["Odysseus",13]']) {
    const p = await prepareBenchmark(f);
    try {
      const detected = await detect(p); expect(detected.issues.length).toBeGreaterThan(0);
      await withScriptedProvider(() => Response.json({ model: MODEL, content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 10 } }), async (provider, requests) => {
        const output = await commandOutput(p, true, provider) as any[];
        expect(requests).toHaveLength(0);
        expect(output).toEqual(detected.issues.map(issue => ({ path: issue.path, issue: issue.message, suggestion: issue.suggestion || "Manual review needed.", canAutoFix: false })));
        expect(await provider.complete({ prompt: "Offline parser control", maxTokens: 2000 })).toBe(text);
        expect(requests).toHaveLength(1);
        if (text === "[null]") {
          expect(output.length).toBe(detected.issues.length); expect(output.every(row => row.canAutoFix === false)).toBe(true);
        }
      });
    } finally { p.close(); }
  }
});
