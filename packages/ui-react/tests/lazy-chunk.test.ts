import { describe, expect, test } from "bun:test";
import { isStaleChunk, markReload, readReloadMarker, RELOAD_LOOP_MS, RELOAD_MARKER_KEY, StaleChunkError, staleChunkReloadDecision } from "../src/lib/lazy-chunk.js";
import { componentNames } from "../src/components/layout/page-boundary.js";

describe("isStaleChunk", () => {
  test("recognises every browser's failed dynamic import and the helper's own error", () => {
    for (const message of [
      "Failed to fetch dynamically imported module: https://example.test/assets/graph-page-3f2a.js",
      "error loading dynamically imported module: https://example.test/assets/graph-page-3f2a.js",
      "Importing a module script failed.",
      "Unable to preload CSS for /assets/graph-page-3f2a.css",
      "Loading chunk graph-page failed.",
    ]) expect(isStaleChunk(new TypeError(message)), message).toBe(true);
    expect(isStaleChunk(new StaleChunkError(new TypeError("anything")))).toBe(true);
  });
  test("an ordinary render error is not a stale chunk", () => {
    expect(isStaleChunk(new TypeError("Cannot read properties of undefined (reading 'nodes')"))).toBe(false);
    expect(isStaleChunk("Failed to fetch dynamically imported module")).toBe(false);
    expect(isStaleChunk(null)).toBe(false);
  });
});

describe("staleChunkReloadDecision", () => {
  const now = Date.UTC(2026, 6, 12, 9, 41);
  test("reloads by itself only when online, unheld and with no recent reload", () => {
    expect(staleChunkReloadDecision({ online: true, held: false, marker: null, now })).toBe("auto");
    expect(staleChunkReloadDecision({ online: true, held: false, marker: now - RELOAD_LOOP_MS, now }), "an expired marker").toBe("auto");
  });
  test("a reload within the loop window stops the loop", () => {
    expect(staleChunkReloadDecision({ online: true, held: false, marker: now - RELOAD_LOOP_MS + 1, now })).toBe("looped");
    expect(staleChunkReloadDecision({ online: true, held: true, marker: now, now }), "the loop wins over unsent work").toBe("looped");
  });
  test("unsent work, unreadable storage and being offline wait for a tap", () => {
    expect(staleChunkReloadDecision({ online: true, held: true, marker: null, now })).toBe("held");
    expect(staleChunkReloadDecision({ online: true, held: false, marker: "unreadable", now })).toBe("manual");
    expect(staleChunkReloadDecision({ online: true, held: true, marker: "unreadable", now }), "unsent work is named first").toBe("held");
    expect(staleChunkReloadDecision({ online: false, held: false, marker: null, now })).toBe("offline");
  });
});

describe("reload marker", () => {
  test("round-trips through storage and fails safe when storage throws", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
    expect(readReloadMarker(storage)).toBeNull();
    markReload(storage, 1234);
    expect(values.get(RELOAD_MARKER_KEY)).toBe("1234");
    expect(readReloadMarker(storage)).toBe(1234);
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(readReloadMarker(broken)).toBe("unreadable");
    expect(() => markReload(broken)).not.toThrow();
    expect(readReloadMarker(null)).toBe("unreadable");
  });
});

describe("componentNames", () => {
  test("keeps identifiers and drops URLs, paths and positions", () => {
    const stack = "\n    at GraphCanvas (https://brain.example.test/assets/graph-3f2a.js:12:3456)\n    at Suspense\n    at GraphPage (http://localhost:5173/src/graph-page.tsx:4:1)\n    at main\n    at GraphCanvas (https://brain.example.test/assets/graph-3f2a.js:12:3456)";
    const names = componentNames(stack);
    expect(names).toEqual(["GraphCanvas", "Suspense", "GraphPage", "main"]);
    expect(names.join(" ")).not.toMatch(/[/:]/);
    expect(componentNames("\n    in Odyssey (created by Ithaca)\n    in Ithaca")).toEqual(["Odyssey", "Ithaca"]);
    expect(componentNames(null)).toEqual([]);
  });
});
