/**
 * post-sync dirt policy.
 *
 * The reindex at the end of a sync rewrites the derived sidecar caches, which
 * dirties the working tree *after* the push. post-sync commits that dirt
 * itself; this pins down what it may and may not touch.
 */

import { describe, expect, test } from "bun:test";
import { classifyPostSyncDirt } from "../src/cli/commands/sync.js";

describe("classifyPostSyncDirt", () => {
  test("a clean tree yields nothing to do", () => {
    expect(classifyPostSyncDirt([])).toEqual({ caches: [], other: [] });
  });

  test("both derived sidecars are auto-committable", () => {
    const { caches, other } = classifyPostSyncDirt([
      ".context-cache.jsonl",
      ".asset-cache.jsonl",
    ]);
    expect(caches).toEqual([".context-cache.jsonl", ".asset-cache.jsonl"]);
    expect(other).toEqual([]);
  });

  test("content files are never auto-committed", () => {
    const { caches, other } = classifyPostSyncDirt(["me/identity.md", "notes/scratch.md"]);
    expect(caches).toEqual([]);
    expect(other).toEqual(["me/identity.md", "notes/scratch.md"]);
  });

  test("caches are still committable alongside unrelated dirt", () => {
    // Staging is by explicit path, so leftover content dirt must not block the
    // cache commit — it is reported separately instead.
    const { caches, other } = classifyPostSyncDirt([
      ".context-cache.jsonl",
      "notes/unfinished.md",
    ]);
    expect(caches).toEqual([".context-cache.jsonl"]);
    expect(other).toEqual(["notes/unfinished.md"]);
  });

  test("only the exact sidecar paths qualify, not lookalikes elsewhere", () => {
    // A same-named file in a subdirectory is not the repo-root sidecar.
    const { caches, other } = classifyPostSyncDirt([
      "vendor/.context-cache.jsonl",
      ".context-cache.jsonl.bak",
      "asset-cache.jsonl",
    ]);
    expect(caches).toEqual([]);
    expect(other).toHaveLength(3);
  });
});
