// Isolate the fake adapter execution from the rest of the jobs suite. Keep the
// actual module contribution, CLI argument handling, runner and SQLite log.
import { spyOn } from "bun:test";
import { buildTaxonomy } from "@schlessera/brain/module";
import type { LoadedModule } from "@schlessera/brain";
import type { AdapterResult } from "@schlessera/brain-scrape";
import { BaseAdapter } from "../../src/adapters/base.js";
import manifest, { configSchema } from "../../src/module.js";
import { getAdapter } from "../../src/scrape.js";
import { ALL_SOURCES, type RawJob } from "../../src/types.js";

const [root, boardsJson] = process.argv.slice(2);
const config = configSchema.parse({ criteria: "criteria.md", boards: JSON.parse(boardsJson!) });
const contribution = manifest.setup(config);
const cron = contribution.cron!.find((entry) => entry.name === "scrape")!;
const [namespace, ...args] = cron.command.split(/\s+/);
const loaded: LoadedModule = {
  key: "@schlessera/brain-module-jobs",
  dir: new URL("../..", import.meta.url).pathname,
  config,
  manifest: { name: manifest.name, ...contribution },
};
const observed: Array<{ source: string; needsBrowser: boolean; hasBrowser: boolean }> = [];
const scrape = BaseAdapter.prototype.scrape;
BaseAdapter.prototype.scrape = function (ctx, options) {
  observed.push({ source: this.source, needsBrowser: this.needsBrowser, hasBrowser: !!ctx.browser });
  return scrape.call(this, ctx, options);
};
for (const source of ALL_SOURCES) {
  // Replace every adapter, including those an incorrect selection would add.
  // The real runner still constructs them and supplies their browser context.
  const prototype = Object.getPrototypeOf(getAdapter(source));
  prototype.scrapePages = async function (): Promise<AdapterResult<RawJob>> {
    return { items: [], errors: [], status: "empty" };
  };
}
const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() => {
  throw new Error("scheduled-selection fixture must not fetch");
}) as unknown as typeof fetch);
const spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => {
  throw new Error("scheduled-selection fixture must not launch a subprocess");
});
const output: string[] = [];
const logSpy = spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
const imported = await contribution.commands![namespace!]!();
const command = "default" in imported ? imported.default : imported;
const code = await command.run(args, {
  root: root!, json: true, config, taxonomy: buildTaxonomy({ modules: [loaded] }),
});
const fetchCalls = fetchSpy.mock.calls.length;
const spawnCalls = spawnSpy.mock.calls.length;
logSpy.mockRestore();
fetchSpy.mockRestore();
spawnSpy.mockRestore();
console.log(JSON.stringify({
  code, command: cron.command, schedule: cron.schedule,
  report: JSON.parse(output[0]!).report, observed, fetchCalls, spawnCalls,
}));
