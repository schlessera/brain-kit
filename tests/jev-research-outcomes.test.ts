// The shipped `jev` client's outcomes, reached through the candidate-extraction
// eval's request builder and research consumer (#1386 split these from the
// prototype tests in experiments/candidate-extraction-eval.test.ts): malformed
// choice keys (including "__proto__", "01" and "1.5") come back as
// bad_response, a missing key never touches the transport, and timeouts and
// transport failures stay unresolved.
import { describe, expect, test } from "bun:test";
import { createJevClient } from "../packages/core/src/lib/jev";
import { fixtures } from "../scripts/evals/candidate-extraction/fixtures";
import { authoredChoices, scriptedResult } from "../scripts/evals/candidate-extraction/run";
import { conferenceResearch, jobResearch, prepare } from "../scripts/evals/candidate-extraction/prototype";

describe("private exact-span extraction controls", () => {
  test.each(["999", "-1", "1.5", "01", "NaN", "__proto__", "unlisted"]) ("malformed selected index %s reaches real parser and abstains", async (choice) => {
    const prepared = prepare(fixtures[1].source, "job");
    const good = authoredChoices(fixtures[1], prepared); expect(good.salary).not.toBe("unclear");
    const result = await scriptedResult(prepared, { ...good, salary: choice });
    expect(result.outcome).toBe("bad_response");
    expect(jobResearch(prepared, result).fields.salary!.status).toBe("unresolved");
  });

  test("missing key never touches even an available transport", async () => {
    const prepared = prepare(fixtures[1].source, "job"); let calls = 0;
    const client = createJevClient({ apiKey: null, fetch: async () => { calls++; throw new Error("unexpected transport"); } });
    const result = await client.ask(prepared.request);
    expect(result.outcome).toBe("no_key"); expect(calls).toBe(0);
    expect(jobResearch(prepared, result).fields.salary!.reason).toBe("no_key");
  });

  test("real client timeout and failure remain unresolved without losing raw input", async () => {
    const prepared = prepare(fixtures[0].source, "cfp");
    for (const fetch of [async () => new Promise<Response>(() => {}), async () => { throw new Error("fixture failure"); }]) {
      const client = createJevClient({ apiKey: "fixture-only", timeoutMs: 5, fetch });
      const result = await client.ask(prepared.request);
      expect(["timeout", "network_error"]).toContain(result.outcome);
      expect(conferenceResearch(prepared, result).fields.deadline!.status).toBe("unresolved");
      expect(prepared.source).toBe(fixtures[0].source);
    }
  });
});
