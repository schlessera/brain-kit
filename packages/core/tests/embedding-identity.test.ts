import { afterAll, describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { embeddingIdentityMatches, getMeta, openDatabase } from "../src/lib/db.js";
import { geminiEmbeddings } from "../src/providers/embeddings/gemini.js";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("the schema default embedding identity", () => {
  test("a fresh database is built for the vectors the default Gemini embedder returns", () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-embedding-identity-"));
    dirs.push(dir);
    const db = openDatabase(join(dir, "brain.db"));
    try {
      const provider = geminiEmbeddings();
      expect(Number(getMeta(db, "embedding_dimensions"))).toBe(provider.dimensions);
      expect(embeddingIdentityMatches(getMeta(db, "embedding_model"), provider.id)).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe("embeddingIdentityMatches", () => {
  test("an exact id matches", () => {
    expect(
      embeddingIdentityMatches("gemini:gemini-embedding-2", "gemini:gemini-embedding-2")
    ).toBe(true);
  });

  test("a legacy bare model name matches the same model namespaced", () => {
    // What a brain last embedded before the indexer recorded provider.id
    // carries — good vectors under the pre-namespace name.
    expect(
      embeddingIdentityMatches("gemini-embedding-2", "gemini:gemini-embedding-2")
    ).toBe(true);
  });

  test("a legacy bare name does NOT match a different model", () => {
    expect(
      embeddingIdentityMatches("gemini-embedding-2", "gemini:gemini-embedding-3")
    ).toBe(false);
    expect(embeddingIdentityMatches("text-embedding-3", "openai:text-embedding-4")).toBe(
      false
    );
  });

  test("two namespaced ids must match exactly — no cross-provider leniency", () => {
    // Same model name under a different provider is a different vector space.
    expect(
      embeddingIdentityMatches("openai:gemini-embedding-2", "gemini:gemini-embedding-2")
    ).toBe(false);
    expect(embeddingIdentityMatches("fake:A", "fake:B")).toBe(false);
  });

  test("the leniency is one-directional: a bare current id matches nothing but itself", () => {
    expect(embeddingIdentityMatches("gemini:gemini-embedding-2", "gemini-embedding-2")).toBe(
      false
    );
    expect(embeddingIdentityMatches("gemini-embedding-2", "gemini-embedding-2")).toBe(true);
  });

  test("no stored identity never matches", () => {
    expect(embeddingIdentityMatches(null, "gemini:gemini-embedding-2")).toBe(false);
    expect(embeddingIdentityMatches("", "gemini:gemini-embedding-2")).toBe(false);
  });
});
