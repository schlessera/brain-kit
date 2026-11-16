/**
 * A module's config block may name the repositories its cron jobs ask the host
 * to fetch (#3380). The key belongs to core, like `enabled`: the module's own
 * strict schema never sees it, and `brain module list --json` reports it so the
 * cron runner can map a job to its request without a credential.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) cleanup(root); });

function fixture(beacon: Record<string, unknown>): string {
  const root = makeTempBrain({ empty: true });
  roots.push(root);
  mkdirSync(join(root, "modules/beacon"), { recursive: true });
  // A strict domain schema: an unstripped core key would fail validation.
  writeFileSync(join(root, "modules/beacon/module.ts"), `
import { z } from "zod";
export default {
  name: "beacon",
  configSchema: z.object({ watch: z.string() }).strict(),
  setup: (config) => ({
    commands: { beacon: async () => ({ summary: "Light the beacon for " + config.watch, async run() { return 0; } }) },
    cron: [{ name: "run", schedule: "*/30 * * * *", command: "beacon run" }],
  }),
};
`);
  writeFileSync(join(root, "brain.config.json"), JSON.stringify({
    exclude: { dirs: ["modules"] },
    modules: { "./modules/beacon": beacon },
  }, null, 2) + "\n");
  return root;
}

test("module list reports the repositories a module's config declares, outside its domain config", async () => {
  const root = fixture({ watch: "Ithaca", repositories: ["https://github.com/ithaca/watchtower", "https://github.com/ithaca/watchtower"] });
  const result = await runCli(root, ["module", "list", "--json"]);
  expect(result.code, result.stderr + result.stdout).toBe(0);
  const beacon = JSON.parse(result.stdout).enabled.find((m: { name: string }) => m.name === "beacon");
  expect(beacon.cron).toEqual([{ name: "run", schedule: "*/30 * * * *", command: "beacon run" }]);
  expect(beacon.repositories, "MODULE_LIST_REPOSITORIES: declared once, deduplicated").toEqual(["https://github.com/ithaca/watchtower"]);
});

test("a module without repositories lists an empty array", async () => {
  const root = fixture({ watch: "Ithaca" });
  const result = await runCli(root, ["module", "list", "--json"]);
  expect(result.code, result.stderr + result.stdout).toBe(0);
  expect(JSON.parse(result.stdout).enabled[0].repositories).toEqual([]);
});

for (const bad of [
  "https://x-access-token:secret@github.com/ithaca/watchtower",
  "https://github.com/ithaca/watchtower?ref=main",
  "https://github.com/ithaca/../treasury",
  "http://github.com/ithaca/watchtower",
  "file:///srv/ithaca/watchtower",
  "git@github.com:ithaca/watchtower.git",
  "--upload-pack=touch",
]) {
  test(`a repository the host could not fetch safely is refused at load: ${bad}`, async () => {
    const root = fixture({ watch: "Ithaca", repositories: [bad] });
    const result = await runCli(root, ["module", "list", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    const [beacon] = JSON.parse(result.stdout).enabled;
    expect(beacon.state, "MODULE_REPOSITORY_SHAPE_REFUSED").toBe("unavailable");
    expect(beacon.error).toContain('Invalid repositories for module "beacon"');
    expect(beacon.repositories, "a refused declaration lists no repository").toBeUndefined();
  });
}
