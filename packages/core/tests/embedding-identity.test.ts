import { describe, test, expect } from "bun:test";
import { embeddingIdentityMatches } from "../src/lib/db.js";

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
