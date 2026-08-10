import { describe, expect, test } from "bun:test";

import type { AgentRunner, CompletionProvider, EmbeddingProvider } from "../src/lib/seams";
import {
  resolveAgentRunner,
  resolveCompletionProvider,
  resolveEmbeddingProvider,
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
