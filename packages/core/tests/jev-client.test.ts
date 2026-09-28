import { describe, expect, test } from "bun:test";

import { resolveEnv } from "../src/config/env";
import { createJevClient, JEV_ENDPOINT, JEV_MODEL, type FetchLike, type JevRequest } from "../src/lib/jev";

const REQUEST: JevRequest = {
  model: JEV_MODEL,
  state: { f0: { path: "exports/search.csv", head: "rank,path\n1,a.md" } },
  questions: {
    "f0.kind": {
      type: "choice",
      instructions: "Is `f0` an artifact?",
      criteria: { artifact: "Output a tool made.", track: "Content the owner wrote." },
    },
  },
};

const GOOD_BODY = {
  model: "jev-1.13.0",
  answers: {
    "f0.kind": { type: "choice", choice: "artifact", probabilities: { artifact: 0.9, track: 0.1 }, confidence: 0.82 },
  },
  usage: { input_tokens: 120, output_tokens: 0 },
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** A fetch that replies from `replies` in turn and records every call. */
function scripted(replies: (() => Promise<Response>)[]): { fetch: FetchLike; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      const next = replies[calls.length - 1];
      if (!next) throw new Error(`unexpected call ${calls.length}`);
      return next();
    },
  };
}

describe("createJevClient", () => {
  test("no key: disabled, answers no_key, sends nothing", async () => {
    const { fetch, calls } = scripted([]);
    for (const apiKey of [null, undefined, "", "   "]) {
      const client = createJevClient({ apiKey, fetch });
      expect(client.enabled).toBe(false);
      const result = await client.ask(REQUEST);
      expect(result.outcome).toBe("no_key");
      expect(result.answers).toBeNull();
    }
    expect(calls).toHaveLength(0);
  });

  test("request shape: POST to the endpoint with the bearer key, and the body carries the questions", async () => {
    const { fetch, calls } = scripted([async () => json(GOOD_BODY)]);
    const client = createJevClient({ apiKey: " sk-test ", fetch });
    const result = await client.ask(REQUEST);
    expect(result.outcome).toBe("answered");
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(JEV_ENDPOINT);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    const body = JSON.parse(String(init.body)) as JevRequest;
    expect(body.model).toBe("jev-latest");
    // The field under test must not be empty by construction.
    expect(Object.keys(body.questions)).toEqual(["f0.kind"]);
    expect(body.questions["f0.kind"]!.type).toBe("choice");
    expect(Object.keys((body.questions["f0.kind"] as { criteria: object }).criteria)).toEqual(["artifact", "track"]);
    expect(body.state).toEqual(REQUEST.state);
  });

  test("answered: returns the answers, the versioned model and the billed tokens", async () => {
    const { fetch } = scripted([async () => json(GOOD_BODY)]);
    const result = await createJevClient({ apiKey: "k", fetch }).ask(REQUEST);
    expect(result.outcome).toBe("answered");
    expect(result.answers).toEqual({
      "f0.kind": { type: "choice", choice: "artifact", probabilities: { artifact: 0.9, track: 0.1 }, confidence: 0.82 },
    });
    expect(result.model).toBe("jev-1.13.0");
    expect(result.inputTokens).toBe(120);
    expect(result.status).toBe(200);
  });

  test("timeout: a fetch that never settles resolves to timeout inside the budget", async () => {
    const { fetch } = scripted([() => new Promise<Response>(() => {})]);
    const started = Date.now();
    const result = await createJevClient({ apiKey: "k", fetch, timeoutMs: 50 }).ask(REQUEST);
    expect(result.outcome).toBe("timeout");
    expect(result.answers).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("429 then answered: one retry", async () => {
    const { fetch, calls } = scripted([async () => json({}, 429), async () => json(GOOD_BODY)]);
    const result = await createJevClient({ apiKey: "k", fetch, retryDelayMs: 1 }).ask(REQUEST);
    expect(calls).toHaveLength(2);
    expect(result.outcome).toBe("answered");
  });

  test("529 twice: rate_limited after exactly one retry", async () => {
    const { fetch, calls } = scripted([async () => json({}, 529), async () => json({}, 529)]);
    const result = await createJevClient({ apiKey: "k", fetch, retryDelayMs: 1 }).ask(REQUEST);
    expect(calls).toHaveLength(2);
    expect(result.outcome).toBe("rate_limited");
    expect(result.status).toBe(529);
  });

  test("a retry-after the budget cannot hold is not waited for", async () => {
    const { fetch, calls } = scripted([async () => json({}, 429, { "retry-after": "30" })]);
    const result = await createJevClient({ apiKey: "k", fetch, timeoutMs: 1000 }).ask(REQUEST);
    expect(calls).toHaveLength(1);
    expect(result.outcome).toBe("rate_limited");
  });

  test("other statuses are not retried", async () => {
    const { fetch, calls } = scripted([async () => json({ detail: "bad" }, 422)]);
    const result = await createJevClient({ apiKey: "k", fetch }).ask(REQUEST);
    expect(calls).toHaveLength(1);
    expect(result.outcome).toBe("http_error");
    expect(result.status).toBe(422);
  });

  test("a network error resolves, never throws", async () => {
    const { fetch } = scripted([async () => Promise.reject(new TypeError("connection refused"))]);
    const result = await createJevClient({ apiKey: "k", fetch }).ask(REQUEST);
    expect(result.outcome).toBe("network_error");
  });

  const badBodies: [string, unknown][] = [
    ["not JSON", "<html>"],
    ["no answers", { model: "jev-1.13.0" }],
    ["no model", { answers: GOOD_BODY.answers }],
    ["an asked question missing", { model: "m", answers: {} }],
    ["a choice outside the options", { model: "m", answers: { "f0.kind": { ...GOOD_BODY.answers["f0.kind"], choice: "maybe" } } }],
    ["confidence above 1", { model: "m", answers: { "f0.kind": { ...GOOD_BODY.answers["f0.kind"], confidence: 1.5 } } }],
    ["a probability missing", { model: "m", answers: { "f0.kind": { ...GOOD_BODY.answers["f0.kind"], probabilities: { artifact: 1 } } } }],
    ["probabilities not summing to 1", { model: "m", answers: { "f0.kind": { ...GOOD_BODY.answers["f0.kind"], probabilities: { artifact: 0.9, track: 0.9 } } } }],
    ["the wrong type", { model: "m", answers: { "f0.kind": { type: "noul", noul: 0.9 } } }],
  ];
  for (const [name, body] of badBodies) {
    test(`bad body (${name}) is bad_response`, async () => {
      const { fetch } = scripted([
        async () =>
          typeof body === "string" ? new Response(body, { status: 200 }) : json(body),
      ]);
      const result = await createJevClient({ apiKey: "k", fetch }).ask(REQUEST);
      expect(result.outcome).toBe("bad_response");
      expect(result.answers).toBeNull();
    });
  }

  test("answers nobody asked for are dropped", async () => {
    const { fetch } = scripted([
      async () => json({ ...GOOD_BODY, answers: { ...GOOD_BODY.answers, "x.injected": { type: "noul", noul: 1 } } }),
    ]);
    const result = await createJevClient({ apiKey: "k", fetch }).ask(REQUEST);
    expect(result.outcome).toBe("answered");
    expect(Object.keys(result.answers!)).toEqual(["f0.kind"]);
  });
});

describe("TYPESAFE_API_KEY", () => {
  test("resolveEnv trims it and treats blank as unset", () => {
    expect(resolveEnv({ TYPESAFE_API_KEY: " sk " }).typesafeApiKey).toBe("sk");
    expect(resolveEnv({ TYPESAFE_API_KEY: "  " }).typesafeApiKey).toBeUndefined();
    expect(resolveEnv({}).typesafeApiKey).toBeUndefined();
  });
});
