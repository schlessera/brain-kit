// The shipped `jev` client's outcomes over a choice request for one job notice
// (#1386 split these from the candidate-extraction prototype tests; the
// request lives in tests/fixtures/candidate-extraction/): malformed choice
// keys (including "__proto__", "01" and "1.5") come back as bad_response with
// no answers, a missing key never touches the transport, and timeouts and
// transport failures come back without answers and leave the request intact.
import { describe, expect, test } from "bun:test";
import { createJevClient, type JevRequest } from "../packages/core/src/lib/jev";
import { GOOD_CHOICES, jobRequest, scriptedBody } from "./fixtures/candidate-extraction/jev-request";

const scripted = (request: JevRequest, choices: Record<string, string>) =>
  createJevClient({ apiKey: "fictional-fixture-key", fetch: async () => Response.json(scriptedBody(request, choices)) }).ask(request);

describe("private exact-span extraction controls", () => {
  test.each(["999", "-1", "1.5", "01", "NaN", "__proto__", "unlisted"]) ("malformed selected index %s reaches real parser and abstains", async (choice) => {
    const request = jobRequest();
    const good = await scripted(request, GOOD_CHOICES);
    expect(good.outcome).toBe("answered");
    const result = await scripted(request, { ...GOOD_CHOICES, salary: choice });
    expect(result.outcome).toBe("bad_response");
    expect(result.answers).toBeNull();
  });

  test("missing key never touches even an available transport", async () => {
    const request = jobRequest(); let calls = 0;
    const client = createJevClient({ apiKey: null, fetch: async () => { calls++; throw new Error("unexpected transport"); } });
    const result = await client.ask(request);
    expect(result.outcome).toBe("no_key"); expect(calls).toBe(0);
    expect(result.answers).toBeNull();
  });

  test("real client timeout and failure remain unresolved without losing raw input", async () => {
    const request = jobRequest(); const before = JSON.stringify(request);
    for (const fetch of [async () => new Promise<Response>(() => {}), async () => { throw new Error("fixture failure"); }]) {
      const client = createJevClient({ apiKey: "fixture-only", timeoutMs: 5, fetch });
      const result = await client.ask(request);
      expect(["timeout", "network_error"]).toContain(result.outcome);
      expect(result.answers).toBeNull();
      expect(JSON.stringify(request)).toBe(before);
    }
  });
});
