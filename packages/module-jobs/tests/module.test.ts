import { describe, expect, test } from "bun:test";
import { resolve } from "path";
import { buildTaxonomy } from "@brainform/core";
import type { LoadedModule } from "@brainform/core";
import manifest, { configSchema } from "../src/module";

const loaded: LoadedModule = {
  key: "@brainform/module-jobs",
  manifest,
  dir: resolve(import.meta.dir, ".."),
  config: {},
};

describe("module manifest", () => {
  test("declares the jobs command, opportunity type, anchor, and cron", () => {
    expect(manifest.name).toBe("jobs");
    expect(manifest.taxonomy?.types?.opportunity?.dir).toBe("career/opportunities");
    expect(manifest.commands).toHaveProperty("jobs");
    expect(manifest.indexRules?.dirAnchors).toContain("status.md");
    expect(manifest.cron?.[0]?.command).toContain("scrape");
  });

  test("configSchema requires criteria and fills defaults", () => {
    const cfg = configSchema.parse({ criteria: "career/opportunities/search-criteria.md" });
    expect(cfg.opportunitiesDir).toBe("career/opportunities");
    expect(cfg.boards).toEqual(["remoteok"]);
    expect(cfg.queries.length).toBeGreaterThan(0);
    expect(() => configSchema.parse({})).toThrow(); // criteria is required
  });
});

describe("taxonomy roundtrip", () => {
  test("typeForPath(dirForType('opportunity') + '/x.md') === 'opportunity'", () => {
    const tax = buildTaxonomy({ modules: [loaded] });
    const dir = tax.dirForType("opportunity");
    expect(dir).toBe("career/opportunities");
    expect(tax.typeForPath(`${dir}/x.md`)).toBe("opportunity");
  });
});
