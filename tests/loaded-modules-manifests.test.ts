/**
 * What a first-party module manifest loads when core imports it (#4797). Core
 * imports the manifest of every configured module in every `brain` process, so
 * a manifest holds loaders: the jobs manifest must not reach the scrape stack
 * or the YAML parser, and the diagrams manifest must not reach its hygiene
 * check, the SVG model or the YAML parser. Observed with
 * `tests/helpers/loaded-modules.ts`; each case first proves the manifest
 * itself was listed, so an absence is evidence.
 */
import { describe, expect, test } from "bun:test";
import { runLoadedModules } from "./helpers/loaded-modules";

const cwd = `${import.meta.dir}/..`;
const env = { PATH: process.env.PATH ?? "" };

async function manifestModules(manifest: string): Promise<string[]> {
  const result = await runLoadedModules(["-e", `await import(${JSON.stringify(`./${manifest}`)})`], { cwd, env });
  expect(result.code).toBe(0);
  expect(result.modules).toContain(manifest);
  return result.modules;
}

const underPackage = (modules: string[], name: string) => modules.filter((path) => path.includes(`node_modules/${name}/`));

describe("first-party manifests load no runtime", () => {
  test("the jobs manifest loads neither the scrape stack nor yaml", async () => {
    const modules = await manifestModules("packages/module-jobs/src/module.ts");
    expect(modules).not.toContain("packages/module-jobs/src/scrape.ts");
    expect(modules.filter((path) => path.startsWith("packages/module-jobs/src/adapters/"))).toEqual([]);
    expect(modules.filter((path) => path.startsWith("packages/scrape/"))).toEqual([]);
    expect(underPackage(modules, "cheerio")).toEqual([]);
    expect(underPackage(modules, "robots-parser")).toEqual([]);
    expect(underPackage(modules, "yaml")).toEqual([]);
  });

  test("the diagrams manifest loads neither its hygiene check, the SVG model nor yaml", async () => {
    const modules = await manifestModules("packages/module-diagrams/src/module.ts");
    for (const file of ["hygiene.ts", "check.ts", "svg-model.ts"]) expect(modules).not.toContain(`packages/module-diagrams/src/${file}`);
    expect(underPackage(modules, "yaml")).toEqual([]);
  });
});
