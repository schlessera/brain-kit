import { describe, expect, test } from "bun:test";
import { resolve } from "path";
import { buildTaxonomy } from "@brainform/core";
import type { LoadedModule } from "@brainform/core";
import manifest, { configSchema } from "../src/module";

// Two-phase manifest: the contribution comes out of setup(validatedConfig).
const cfg = configSchema.parse({ criteria: "career/opportunities/search-criteria.md" });
const contribution = manifest.setup(cfg);

const loaded: LoadedModule = {
  key: "@brainform/module-jobs",
  manifest: { name: manifest.name, ...contribution },
  dir: resolve(import.meta.dir, ".."),
  config: cfg,
};

describe("module manifest", () => {
  test("declares the jobs command, opportunity type, anchor, and cron", () => {
    expect(manifest.name).toBe("jobs");
    expect(contribution.taxonomy?.types?.opportunity?.dir).toBe("career/opportunities");
    expect(contribution.commands).toHaveProperty("jobs");
    expect(contribution.indexRules?.dirAnchors).toContain("status.md");
    expect(contribution.cron?.[0]?.command).toContain("scrape");
  });

  test("setup shapes the opportunity dir from config", () => {
    const custom = manifest.setup(
      configSchema.parse({ criteria: "c.md", opportunitiesDir: "work/pipeline" })
    );
    expect(custom.taxonomy?.types?.opportunity?.dir).toBe("work/pipeline");
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
