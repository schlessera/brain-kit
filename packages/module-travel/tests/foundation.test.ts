import { describe, expect, test } from "bun:test";
import { buildTaxonomy } from "@schlessera/brain/module";
import { loadModules } from "../../core/src/lib/module-loader.js";
import { mkdtempSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import speaking, { configSchema as speakingConfig } from "../../module-speaking/src/module.js";
import { planTravelConfigMigration } from "../src/migration.js";

const SPEAKING = "@schlessera/brain-module-speaking";
const TRAVEL = "@schlessera/brain-module-travel";
const party = [
  { name: "Odysseus", role: "traveler" },
  { name: "Penelope", role: "partner", requirementsDoc: "people/penelope.md" },
];

describe("travel ownership", () => {
  test("speaking retains talks and conferences while travel ownership moves", () => {
    const types = speaking.setup(speakingConfig.parse({})).taxonomy?.types;
    expect(types?.talk?.dir).toBe("talks");
    expect(types?.conference?.dir).toBe("conferences");
    expect(types).toEqual({ talk: { dir: "talks" }, conference: { dir: "conferences" } });
  });

  test("real loader permits speaking plus travel with one travel owner", async () => {
    const root = mkdtempSync(join(tmpdir(), "brain-travel-loader-"));
    symlinkSync(resolve(import.meta.dir, "../../../node_modules"), join(root, "node_modules"));
    try {
      const modules = await loadModules({ modules: { [SPEAKING]: {}, [TRAVEL]: {} } }, root);
      expect(modules.map((m) => m.manifest.name)).toEqual(["speaking", "travel"]);
      expect(() => buildTaxonomy({ modules })).not.toThrow();
      const taxonomy = buildTaxonomy({ modules });
      expect(taxonomy.types.travel?.owner).toBe("module:travel");
      expect(taxonomy.typeForPath("travel/ithaca/itinerary.md")).toBe("travel");
      expect(taxonomy.typeForPath("trips/ithaca-headland.md")).toBe("trip");
      expect(taxonomy.typeForPath("places/ithaca.md")).toBe("place");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("travel settings migration", () => {
  test("moves every legacy party field and preserves unrelated JSON settings", () => {
    expect(party.length).toBeGreaterThan(0);
    expect(party[1].requirementsDoc).toBe("people/penelope.md");
    const original = { modules: { [SPEAKING]: { travelParty: party } }, ignore: ["drafts/**"] };
    const plan = planTravelConfigMigration(JSON.stringify(original), "json");
    const result = JSON.parse(plan.source);
    expect(result.modules[TRAVEL]?.travelParty).toEqual(party);
    expect(result.modules[SPEAKING]).toEqual({});
    expect(result.ignore).toEqual(original.ignore);
    expect(plan.changed).toBe(true);
    const again = planTravelConfigMigration(plan.source, "json");
    expect(again).toEqual({ source: plan.source, changed: false });
  });

  test("reports conflicting party settings and preserves the source", () => {
    const source = JSON.stringify({ modules: {
      [SPEAKING]: { travelParty: party }, [TRAVEL]: { travelParty: [{ name: "Telemachus" }] },
    } });
    expect(() => planTravelConfigMigration(source, "json")).toThrow(/conflict/i);
    expect(JSON.parse(source).modules[SPEAKING].travelParty).toEqual(party);
  });

  test("moves literal TypeScript settings without changing surrounding logic", () => {
    const source = `import { defineConfig } from "@schlessera/brain";
const unrelated = () => "keep me";
export default defineConfig({
  modules: { "${SPEAKING}": { travelParty: ${JSON.stringify(party)} } },
});
`;
    const plan = planTravelConfigMigration(source, "ts");
    expect(plan.changed).toBe(true);
    expect(plan.source).toContain('const unrelated = () => "keep me";');
    expect(plan.source).toContain(TRAVEL);
    expect(plan.source).toContain('"requirementsDoc":"people/penelope.md"');
    expect(planTravelConfigMigration(plan.source, "ts")).toEqual({ source: plan.source, changed: false });
  });

  test("refuses dynamic module construction rather than guessing at an edit", () => {
    const source = `export default { modules: { ...otherModules, "${SPEAKING}": { travelParty: party } } };`;
    expect(() => planTravelConfigMigration(source, "ts")).toThrow(/literal|dynamic|manual/i);
    expect(source).toContain("...otherModules");
    const dynamicParty = `const party = [{name:"Odysseus"}]; export default {modules:{"${SPEAKING}":{travelParty:party}}};`;
    expect(() => planTravelConfigMigration(dynamicParty, "ts")).toThrow(/dynamic|literal|manual/i);
  });

  test("equal party values consolidate safely and retain unrelated target properties", () => {
    const source = JSON.stringify({ modules: {
      [SPEAKING]: { travelParty: party, retained: "speaking-owned" },
      [TRAVEL]: { travelParty: party, retained: "travel-owned" },
    } });
    const result = JSON.parse(planTravelConfigMigration(source, "json").source);
    expect(result.modules[SPEAKING]).toEqual({ retained: "speaking-owned" });
    expect(result.modules[TRAVEL]).toEqual({ travelParty: party, retained: "travel-owned" });
  });

  test("duplicate JSON keys are ambiguous even when JSON.parse accepts them", () => {
    const source = `{"modules":{"${SPEAKING}":{"travelParty":[],"travelParty":${JSON.stringify(party)}}}}`;
    expect(JSON.parse(source).modules[SPEAKING].travelParty).toEqual(party);
    expect(() => planTravelConfigMigration(source, "json")).toThrow(/duplicate/i);
  });

  test("TypeScript property separators and comments survive owned-field removal", () => {
    for (const block of [
      `travelParty: ${JSON.stringify(party)}, retained: "yes"`,
      `retained: "yes", /* retain this */ travelParty: ${JSON.stringify(party)}`,
      `travelParty: ${JSON.stringify(party)},`,
    ]) {
      const source = `export default {modules:{"${SPEAKING}":{${block}},"${TRAVEL}":{retained:"target",}}};`;
      const plan = planTravelConfigMigration(source, "ts");
      expect(plan.changed).toBe(true);
      expect(plan.source).toContain('retained:"target"');
      if (block.includes('retained: "yes"')) expect(plan.source).toContain('retained: "yes"');
      if (block.includes('/* retain this */')) expect(plan.source).toContain('/* retain this */');
      expect(planTravelConfigMigration(plan.source, "ts")).toEqual({ source: plan.source, changed: false });
    }
  });
});
