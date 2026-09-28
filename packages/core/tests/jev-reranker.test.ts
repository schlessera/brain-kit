/**
 * Keyless contract tests for the built-in jev reranker: the network is a
 * stubbed fetch, the key is a throwaway env name set for the test only.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { buildJevRequest, jevReranker, orderFromAnswer } from "../src/providers/rerankers/jev";
import { JEV_MODEL } from "../src/lib/llm-defaults";
import type { RerankCandidate } from "../src/lib/seams";

const KEY_ENV = "BRAIN_TEST_JEV_KEY";

function candidate(i: number, overrides: Partial<RerankCandidate> = {}): RerankCandidate {
  return {
    id: `docs/${i}.md`,
    source: "brain",
    title: `Doc ${i}`,
    type: "note",
    tags: "a, b",
    summary: `Summary ${i}`,
    excerpt: `>>>match<<< text ${i}`,
    score: 1 / (i + 1),
    ...overrides,
  };
}

type Call = { url: string; init: RequestInit };

function stubFetch(
  respond: (body: unknown, call: Call) => Response | Promise<Response>
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return respond(JSON.parse(String(init?.body ?? "{}")), call);
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

function answer(probabilities: Record<string, number>, extra: Record<string, unknown> = {}): Response {
  return Response.json({
    model: JEV_MODEL,
    answers: { ranking: { type: "choice", choice: "C001", confidence: 0.5, probabilities, ...extra } },
    usage: { input_tokens: 10, output_tokens: 0 },
  });
}

const savedKey = process.env[KEY_ENV];
beforeEach(() => {
  process.env[KEY_ENV] = "test-key";
});
afterEach(() => {
  if (savedKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = savedKey;
});

describe("jevReranker", () => {
  test("identity carries the pinned model and declares every lane + network", () => {
    const r = jevReranker({ apiKeyEnv: KEY_ENV });
    expect(r.id).toBe(`jev:${JEV_MODEL}`);
    expect(r.capabilities).toEqual({ modes: ["fts", "vector", "hybrid"], network: true });
    expect(jevReranker({ apiKeyEnv: KEY_ENV, model: "jev-9.9.9" }).id).toBe("jev:jev-9.9.9");
  });

  test("sends one Choice over candidate ids with bearer auth and the evidence fields, markers stripped", async () => {
    const { fetch, calls } = stubFetch((body) => {
      const ids = Object.keys((body as any).questions.ranking.criteria);
      return answer(Object.fromEntries(ids.map((id, i) => [id, i === 1 ? 0.7 : 0.15])));
    });
    const r = jevReranker({ apiKeyEnv: KEY_ENV, fetch });
    const cands = [candidate(0), candidate(1), candidate(2)];
    const ranked = await r.rerank({ query: "match", candidates: cands, mode: "hybrid" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.typesafe.ai/v1/systemone");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe(JEV_MODEL);
    expect(body.state.query).toBe("match");
    expect(body.state.candidates).toHaveLength(3);
    expect(body.state.candidates[0]).toEqual({
      id: "C001",
      title: "Doc 0",
      type: "note",
      tags: "a, b",
      summary: "Summary 0",
      excerpt: "match text 0",
    });
    expect(body.questions.ranking.type).toBe("choice");
    expect(body.questions.ranking.criteria).toEqual({ C001: "Doc 0", C002: "Doc 1", C003: "Doc 2" });
    // No document paths, no raw scores leave the machine — only what the model needs.
    expect(JSON.stringify(body)).not.toContain("docs/");

    expect(ranked.map((x) => x.item.id)).toEqual(["docs/1.md", "docs/0.md", "docs/2.md"]);
    expect(ranked[0].score).toBe(0.7);
    expect(ranked[0].item).toBe(cands[1]);
  });

  test("names the source per candidate only when the pool spans several stores", () => {
    const single = buildJevRequest(JEV_MODEL, { query: "q", candidates: [candidate(0), candidate(1)] }).body;
    expect(single.state.candidates.every((c) => !("source" in c))).toBe(true);
    expect(single.questions.ranking.instructions.situation).not.toContain("`source`");

    const union = buildJevRequest(JEV_MODEL, {
      query: "q",
      candidates: [candidate(0), candidate(1, { source: "calendar" })],
    }).body;
    expect(union.state.candidates.map((c) => c.source)).toEqual(["brain", "calendar"]);
    expect(union.questions.ranking.instructions.situation).toContain("`source`");
  });

  test("sends attributes as flat fields, bounded, never over the reserved ones", () => {
    const { body } = buildJevRequest(JEV_MODEL, {
      query: "q",
      candidates: [
        candidate(0, { attributes: { status: "draft", updated: "2026-01-01", title: "hijack", id: "C999", note: "x".repeat(500) } }),
        candidate(1),
      ],
    });
    const c = body.state.candidates[0];
    expect(c).toMatchObject({ id: "C001", title: "Doc 0", status: "draft", updated: "2026-01-01" });
    expect(String(c.note).length).toBeLessThanOrEqual(100);
    expect(body.state.candidates[1]).not.toHaveProperty("status");
  });

  test("forwards the caller's abort signal", async () => {
    const { fetch, calls } = stubFetch(() => answer({ C001: 0.5, C002: 0.5 }));
    const controller = new AbortController();
    await jevReranker({ apiKeyEnv: KEY_ENV, fetch }).rerank({
      query: "q",
      candidates: [candidate(0), candidate(1)],
      signal: controller.signal,
    });
    expect(calls[0].init.signal).toBe(controller.signal);
  });

  test("a missing key throws before any network call", async () => {
    delete process.env[KEY_ENV];
    const { fetch, calls } = stubFetch(() => answer({}));
    await expect(
      jevReranker({ apiKeyEnv: KEY_ENV, fetch }).rerank({ query: "q", candidates: [candidate(0), candidate(1)] })
    ).rejects.toThrow(new RegExp(KEY_ENV));
    expect(calls).toHaveLength(0);
  });

  test("fewer than two candidates is a no-op without a call", async () => {
    const { fetch, calls } = stubFetch(() => answer({}));
    const one = candidate(0);
    const ranked = await jevReranker({ apiKeyEnv: KEY_ENV, fetch }).rerank({ query: "q", candidates: [one] });
    expect(ranked).toEqual([{ item: one, score: 1 }]);
    expect(calls).toHaveLength(0);
  });

  test("non-2xx responses throw with the status attached", async () => {
    const { fetch } = stubFetch(() => new Response("Too many choices", { status: 400 }));
    let err: (Error & { status?: number }) | undefined;
    try {
      await jevReranker({ apiKeyEnv: KEY_ENV, fetch }).rerank({ query: "q", candidates: [candidate(0), candidate(1)] });
    } catch (e) {
      err = e as Error & { status?: number };
    }
    expect(err?.message).toMatch(/400.*Too many choices/);
    expect(err?.status).toBe(400);
  });

  test("a partial or malformed distribution is an error, not a partial ranking", async () => {
    const partial = stubFetch(() => answer({ C001: 0.9 }));
    await expect(
      jevReranker({ apiKeyEnv: KEY_ENV, fetch: partial.fetch }).rerank({ query: "q", candidates: [candidate(0), candidate(1)] })
    ).rejects.toThrow(/no probability for candidate C002/);

    const wrongType = stubFetch(() => Response.json({ answers: { ranking: { type: "noul", noul: 0.4 } } }));
    await expect(
      jevReranker({ apiKeyEnv: KEY_ENV, fetch: wrongType.fetch }).rerank({ query: "q", candidates: [candidate(0), candidate(1)] })
    ).rejects.toThrow(/malformed answer/);

    expect(() => orderFromAnswer([candidate(0)], { type: "choice", probabilities: { C001: Number.NaN } })).toThrow();
    expect(() => orderFromAnswer([candidate(0)], { type: "choice", probabilities: { C001: 1.5 } })).toThrow();
  });

  test("beyond 255 options the rest stays in retrieval order after the judged block", async () => {
    const cands = Array.from({ length: 300 }, (_, i) => candidate(i));
    const { fetch } = stubFetch((body) => {
      const ids = Object.keys((body as any).questions.ranking.criteria);
      expect(ids).toHaveLength(255);
      // Put the last judged candidate first, everything else flat.
      return answer(Object.fromEntries(ids.map((id) => [id, id === "C255" ? 0.9 : 0.001])));
    });
    const ranked = await jevReranker({ apiKeyEnv: KEY_ENV, fetch }).rerank({ query: "q", candidates: cands });
    expect(ranked).toHaveLength(300);
    expect(ranked[0].item.id).toBe("docs/254.md");
    expect(ranked.slice(255).map((x) => x.item.id)).toEqual(cands.slice(255).map((c) => c.id));
    expect(ranked[299].score).toBe(-1);
  });

  test("preview returns the exact request with the key's env name, and sends nothing", () => {
    const { fetch, calls } = stubFetch(() => answer({}));
    const r = jevReranker({ apiKeyEnv: KEY_ENV, fetch });
    const preview = r.preview!({ query: "q", candidates: [candidate(0), candidate(1)] }) as any;
    expect(calls).toHaveLength(0);
    expect(preview.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(preview.apiKeyEnv).toBe(KEY_ENV);
    expect(preview.state.candidates).toHaveLength(2);
    expect(JSON.stringify(preview)).not.toContain("test-key");
    expect(preview).toMatchObject(buildJevRequest(JEV_MODEL, { query: "q", candidates: [candidate(0), candidate(1)] }).body);
  });

  test("long fields are clipped so a 146k-character body cannot blow the request budget", () => {
    const huge = candidate(0, { summary: "s".repeat(10_000), excerpt: "e".repeat(10_000), title: "t".repeat(1_000) });
    const { body } = buildJevRequest(JEV_MODEL, { query: "q", candidates: [huge, candidate(1)] });
    expect(body.state.candidates[0].summary.length).toBeLessThanOrEqual(300);
    expect(body.state.candidates[0].excerpt.length).toBeLessThanOrEqual(400);
    expect(body.state.candidates[0].title.length).toBeLessThanOrEqual(200);
  });
});
