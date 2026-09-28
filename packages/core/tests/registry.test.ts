import { describe, expect, test } from "bun:test";

import type { AgentRunner, CompletionProvider, EmbeddingProvider, Reranker } from "../src/lib/seams";
import {
  RERANKERS,
  rerankerKeyEnv,
  rerankSetup,
  resolveAgentRunner,
  resolveCompletionProvider,
  resolveEmbeddingProvider,
  resolveReranker,
  selectReranker,
} from "../src/lib/registry";

describe("resolveEmbeddingProvider", () => {
  test("string 'gemini' resolves the built-in with defaults", () => {
    const p = resolveEmbeddingProvider({ provider: "gemini" });
    expect(p.id).toBe("gemini:gemini-embedding-2");
    expect(p.dimensions).toBe(1536);
  });

  test("no config defaults to gemini", () => {
    const p = resolveEmbeddingProvider();
    expect(p.id).toBe("gemini:gemini-embedding-2");
  });

  test("model/dimensions overrides flow through to id + dimensions", () => {
    const p = resolveEmbeddingProvider({ provider: "gemini", model: "custom-embed", dimensions: 768 });
    expect(p.id).toBe("gemini:custom-embed");
    expect(p.dimensions).toBe(768);
  });

  test("a passed-in value is used as-is", () => {
    const custom: EmbeddingProvider = {
      id: "custom:x",
      dimensions: 42,
      embed: async () => [],
      embedQuery: async () => new Float32Array(),
    };
    expect(resolveEmbeddingProvider({ provider: custom })).toBe(custom);
  });

  test("unknown built-in throws listing available names", () => {
    expect(() => resolveEmbeddingProvider({ provider: "nope" })).toThrow(/Unknown embedding provider "nope"/);
    expect(() => resolveEmbeddingProvider({ provider: "nope" })).toThrow(/gemini/);
  });
});

describe("resolveCompletionProvider", () => {
  test("defaults to gemini-flash with vision", () => {
    const p = resolveCompletionProvider();
    expect(p.id).toBe("gemini:gemini-3-flash-preview");
    expect(p.capabilities.vision).toBe(true);
  });

  test("anthropic-haiku built-in resolves", () => {
    const p = resolveCompletionProvider({ provider: "anthropic-haiku" });
    expect(p.id).toBe("anthropic:claude-haiku-4-5-20251001");
  });

  test("a fallback wraps the primary", () => {
    const p = resolveCompletionProvider({ provider: "gemini-flash", fallback: "anthropic-haiku" });
    expect(p.id).toContain("+fallback:");
    expect(p.id).toContain("gemini:gemini-3-flash-preview");
    expect(p.id).toContain("anthropic:claude-haiku-4-5-20251001");
  });

  test("fallback is invoked when the primary throws", async () => {
    const primary: CompletionProvider = {
      id: "primary",
      capabilities: { vision: true },
      complete: async () => {
        throw new Error("primary down");
      },
    };
    const fallback: CompletionProvider = {
      id: "fallback",
      capabilities: { vision: false },
      complete: async () => "from fallback",
    };
    const p = resolveCompletionProvider({ provider: primary, fallback });
    expect(await p.complete({ prompt: "hi" })).toBe("from fallback");
    // Advertised capability follows the primary.
    expect(p.capabilities.vision).toBe(true);
  });

  test("a passed-in value is used as-is (no fallback)", () => {
    const custom: CompletionProvider = {
      id: "custom",
      capabilities: { vision: false },
      complete: async () => "",
    };
    expect(resolveCompletionProvider({ provider: custom })).toBe(custom);
  });

  test("unknown built-in throws listing available names", () => {
    expect(() => resolveCompletionProvider({ provider: "nope" })).toThrow(
      /Unknown completion provider "nope"/
    );
    expect(() => resolveCompletionProvider({ provider: "nope" })).toThrow(/anthropic-haiku, gemini-flash/);
  });
});

describe("resolveAgentRunner", () => {
  test("defaults to claude", () => {
    const r = resolveAgentRunner();
    expect(r.id).toBe("claude");
    expect(r.capabilities.streaming).toBe(true);
  });

  test("named built-ins resolve", () => {
    expect(resolveAgentRunner("codex").id).toBe("codex");
    expect(resolveAgentRunner("gemini").id).toBe("gemini");
    expect(resolveAgentRunner("pi").id).toBe("pi");
  });

  test("a passed-in value is used as-is", () => {
    const custom: AgentRunner = {
      id: "omp",
      capabilities: { streaming: false, skills: true },
      run: async () => "",
    };
    expect(resolveAgentRunner(custom)).toBe(custom);
  });

  test("unknown built-in throws listing available names", () => {
    expect(() => resolveAgentRunner("nope")).toThrow(/Unknown agent runner "nope"/);
    expect(() => resolveAgentRunner("nope")).toThrow(/claude, codex, gemini, pi/);
  });
});

describe("rerankers", () => {
  const KEY_ENV = "BRAIN_TEST_JEV_KEY_REGISTRY";
  const custom: Reranker = { id: "custom:r", capabilities: { modes: ["fts"], network: false }, rerank: async () => [] };
  function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    const apply = (entries: Record<string, string | undefined>) => {
      for (const [k, v] of Object.entries(entries)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };
    apply(vars);
    try {
      return fn();
    } finally {
      apply(saved);
    }
  }
  const keyed = <T>(fn: () => T) => withEnv({ [KEY_ENV]: "k", BRAIN_RERANK_MODE: undefined }, fn);
  const keyless = <T>(fn: () => T) => withEnv({ [KEY_ENV]: undefined, BRAIN_RERANK_MODE: undefined }, fn);
  const cfg = { provider: "jev", apiKeyEnv: KEY_ENV };

  test("jev is the one built-in judgment reranker", () => {
    expect(Object.keys(RERANKERS)).toEqual(["jev"]);
  });

  test("resolveReranker: jev resolves with its pinned model, heuristic and none resolve to nothing, values pass through", () => {
    expect(resolveReranker({ provider: "jev", model: "jev-1.2.3" })!.id).toBe("jev:jev-1.2.3");
    expect(resolveReranker({ provider: "heuristic" })).toBeUndefined();
    expect(resolveReranker({ provider: "none" })).toBeUndefined();
    expect(resolveReranker({ provider: custom })).toBe(custom);
    expect(() => resolveReranker({ provider: "title" })).toThrow(/Unknown reranker "title"/);
  });

  test("the configured default is jev with a key and the lifecycle ordering without, silently", () => {
    const withKey = keyed(() => selectReranker(cfg));
    expect(withKey.rerank).toBe("jev");
    expect(withKey.reranker!.id).toMatch(/^jev:/);
    expect(keyless(() => selectReranker(cfg))).toEqual({ rerank: "heuristic", warning: undefined });
  });

  test("an explicit jev without a key keeps the lifecycle ordering and says so", () => {
    const s = keyless(() => selectReranker(cfg, "jev"));
    expect(s.rerank).toBe("heuristic");
    expect(s.reranker).toBeUndefined();
    expect(s.warning).toMatch(new RegExp(`rerank "jev" unavailable: ${KEY_ENV} not set`));
  });

  test("an explicit request wins over BRAIN_RERANK_MODE, which wins over config", () => {
    withEnv({ [KEY_ENV]: "k", BRAIN_RERANK_MODE: "none" }, () => {
      expect(selectReranker(cfg).rerank).toBe("none");
      expect(selectReranker(cfg, "heuristic").rerank).toBe("heuristic");
      expect(selectReranker({ provider: "heuristic", apiKeyEnv: KEY_ENV }, "jev").rerank).toBe("jev");
    });
  });

  test("an invalid BRAIN_RERANK_MODE is reported and ignored; an unknown request throws", () => {
    const s = withEnv({ [KEY_ENV]: undefined, BRAIN_RERANK_MODE: "title" }, () => selectReranker({ provider: "heuristic" }));
    expect(s.rerank).toBe("heuristic");
    expect(s.warning).toMatch(/BRAIN_RERANK_MODE="title" is not one of none, heuristic, jev/);
    expect(() => selectReranker(cfg, "title")).toThrow(/Unknown rerank mode "title"/);
  });

  test("a custom value is the default and needs no key; named modes still override it", () => {
    keyless(() => {
      expect(selectReranker({ provider: custom })).toEqual({ rerank: "jev", reranker: custom, warning: undefined });
      expect(selectReranker({ provider: custom }, "heuristic").rerank).toBe("heuristic");
    });
  });

  test("rerankSetup carries the configured bounds only when a reranker runs", () => {
    const full = { ...cfg, exclude: ["career"], timeoutMs: 1500, depth: 30, skipMargin: 0.02 };
    const on = keyed(() => rerankSetup(full));
    expect(on.rerank).toBe("jev");
    expect(on.deps.rerankTimeoutMs).toBe(1500);
    expect(on.deps.rerankDepth).toBe(30);
    expect(on.deps.rerankSkipMargin).toBe(0.02);
    expect(on.deps.rerankExclude!("career/x.md")).toBe(true);
    expect(on.deps.rerankExclude!("notes/x.md")).toBe(false);
    expect(keyless(() => rerankSetup(full)).deps).toEqual({});
  });

  test("rerankerKeyEnv honours apiKeyEnv and defaults to TYPESAFE_API_KEY", () => {
    expect(rerankerKeyEnv(undefined)).toBe("TYPESAFE_API_KEY");
    expect(rerankerKeyEnv({ provider: "jev", apiKeyEnv: "X" })).toBe("X");
  });
});

