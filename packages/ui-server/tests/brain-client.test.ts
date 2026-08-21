import { describe, test, expect } from "bun:test";
import { createBrainClient } from "../src/brain/client";

// These tests require the brain repo at ~/brain
const BRAIN_AVAILABLE = Bun.spawnSync(["test", "-d", `${process.env.HOME}/brain/.git`]).exitCode === 0;

const client = createBrainClient({ brainPath: `${process.env.HOME}/brain` });
const brainSearch = client.search;
const brainBriefing = client.briefing;
const brainStats = client.stats;
const brainList = client.list;
const brainRead = client.read;
const brainValidate = client.validate;

describe.skipIf(!BRAIN_AVAILABLE)("brain CLI client", () => {
  describe("brainSearch", () => {
    test("returns results for a known query", async () => {
      const { results, warnings } = await brainSearch("identity");
      expect(results).toBeArray();
      expect(results.length).toBeGreaterThan(0);
      expect(warnings).toBeArray();
    });

    test("results have expected shape", async () => {
      const { results } = await brainSearch("identity", { limit: 1 });
      const result = results[0];
      expect(result).toHaveProperty("path");
      expect(result).toHaveProperty("title");
      expect(result).toHaveProperty("type");
      expect(result).toHaveProperty("score");
    });

    test("respects limit option", async () => {
      const { results } = await brainSearch("identity", { limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    test("respects type filter", async () => {
      const { results } = await brainSearch("identity", {
        type: "identity",
        limit: 5,
      });
      for (const r of results) {
        expect(r.type).toBe("identity");
      }
    });

    test("returns empty array for nonsense query", async () => {
      const { results } = await brainSearch("xyzzyplughfoo123nonsense");
      expect(results).toBeArray();
      // Might still return fuzzy results, but should be empty or very few
    });
  });

  describe("brainStats", () => {
    test("returns document count", async () => {
      const stats = await brainStats();
      expect(stats.documents).toBeGreaterThan(0);
    });

    test("returns type breakdown", async () => {
      const stats = await brainStats();
      expect(stats.byType).toBeDefined();
      expect(typeof stats.byType).toBe("object");
      expect(Object.keys(stats.byType).length).toBeGreaterThan(0);
    });

    test("returns status breakdown", async () => {
      const stats = await brainStats();
      expect(stats.byStatus).toBeDefined();
    });

    test("includes expected types", async () => {
      const stats = await brainStats();
      expect(stats.byType.identity).toBeGreaterThan(0);
      expect(stats.byType.talk).toBeGreaterThan(0);
    });
  });

  describe("brainBriefing", () => {
    test("returns non-empty string", async () => {
      const content = await brainBriefing();
      expect(typeof content).toBe("string");
      expect(content.length).toBeGreaterThan(0);
    });
  });

  describe("brainList", () => {
    test("returns documents", async () => {
      const results = await brainList({ limit: 3 });
      expect(results).toBeArray();
      expect(results.length).toBeGreaterThan(0);
    });

    test("documents have expected fields", async () => {
      const results = await brainList({ limit: 1 });
      const doc = results[0];
      expect(doc).toHaveProperty("path");
      expect(doc).toHaveProperty("title");
      expect(doc).toHaveProperty("type");
    });

    test("filters by type", async () => {
      const results = await brainList({ type: "identity", limit: 5 });
      for (const doc of results) {
        expect(doc.type).toBe("identity");
      }
    });

    test("respects limit", async () => {
      const results = await brainList({ limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });
  });

  describe("brainRead", () => {
    test("reads a known document", async () => {
      const content = await brainRead("me/identity.md");
      expect(typeof content).toBe("string");
      expect(content.length).toBeGreaterThan(0);
    });

    test("throws for nonexistent path", async () => {
      await expect(brainRead("nonexistent/file.md")).rejects.toThrow();
    });
  });

  describe("brainValidate", () => {
    test("returns validation output", async () => {
      const output = await brainValidate();
      expect(typeof output).toBe("string");
    });
  });
});
