import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BRAIN_BIN, keylessEnv, runCli } from "../../core/tests/cli-harness";
import { httpContractApp } from "./helpers/http-contract-app";

const curated = ["remoteok", "weworkremotely", "workingnomads", "remotelyde"];

for (const scenario of [
  { name: "omitted boards", configured: undefined, saved: undefined, expected: curated, provenance: "default" },
  { name: "TypeScript boards", configured: ["workingnomads"], saved: undefined, expected: ["workingnomads"], provenance: "brain-config" },
  { name: "JSON replaces TypeScript boards", configured: ["workingnomads"], saved: { boards: ["remoteok", "remotelyde"] }, expected: ["remoteok", "remotelyde"], provenance: "saved" },
  { name: "JSON omits the boards key", configured: ["weworkremotely"], saved: { queries: ["fixture query"] }, expected: ["weworkremotely"], provenance: "brain-config" },
]) {
  test(`jobs ${scenario.name} agree in settings HTTP, CLI and actual scraping`, async () => {
    const t = await httpContractApp();
    try {
      symlinkSync(resolve(import.meta.dir, "../../../node_modules/@schlessera"), join(t.brainPath, "node_modules/@schlessera"));
      mkdirSync(join(t.brainPath, "career"));
      writeFileSync(join(t.brainPath, "career/criteria.md"), readFileSync(resolve(import.meta.dir, "../../module-jobs/tests/fixtures/criteria.md"), "utf8"));
      const config = `export default ${JSON.stringify({ modules: { "@schlessera/brain-module-jobs": { criteria: "career/criteria.md", boards: scenario.configured } } })};\n`;
      writeFileSync(join(t.brainPath, "brain.config.ts"), config);
      if (scenario.saved) {
        mkdirSync(join(t.brainPath, "settings"));
        writeFileSync(join(t.brainPath, "settings/jobs.json"), JSON.stringify(scenario.saved));
      }
      writeFileSync(join(t.brainPath, "node_modules/.bin/brain"), `#!${process.execPath}\nprocess.env.BRAIN_ROOT=${JSON.stringify(t.brainPath)}; await import(${JSON.stringify(BRAIN_BIN)});\n`, { mode: 0o755 });
      expect(scenario.expected.length).toBeGreaterThan(0);
      if (scenario.configured) expect(scenario.configured.length).toBeGreaterThan(0);
      if (scenario.saved && "boards" in scenario.saved) {
        expect(scenario.saved.boards!.length).toBeGreaterThan(0);
        expect(scenario.saved.boards).not.toEqual(scenario.configured);
      }
      const cli = await runCli(t.brainPath, ["module", "settings", "jobs", "--json"]);
      expect(cli.code, cli.stderr + cli.stdout).toBe(0);
      const snapshot = JSON.parse(cli.stdout);
      expect(snapshot.values.boards).toEqual(scenario.expected);
      const response = await t.fetch("/api/modules/jobs/settings");
      expect(response.status).toBe(200);
      const http = await response.json();
      expect(http.values.boards).toEqual(scenario.expected);
      expect(http.values).toEqual(snapshot.values);
      expect(http.provenance.boards).toBe(scenario.provenance);
      const choices = http.ui.fields.find((field: { key: string }) => field.key === "boards").options;
      expect(choices).toHaveLength(10);
      expect(choices.filter((choice: { help: string }) => choice.help.startsWith("Selected by default")).map((choice: { value: string }) => choice.value)).toEqual(curated);
      const child = Bun.spawn([process.execPath, "--preload", resolve(import.meta.dir, "../../module-jobs/tests/helpers/default-boards-preload.ts"), BRAIN_BIN, "jobs", "scrape", "--json"], { env: keylessEnv(t.brainPath), stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code, stderr + stdout).toBe(0);
      const report = JSON.parse(stdout).report;
      expect(report.sources.map((entry: { source: string }) => entry.source)).toEqual(scenario.expected);
      expect(report.sources.every((entry: { status: string }) => entry.status === "empty")).toBe(true);
      expect(report.total_errors).toEqual([]);
      expect(readFileSync(join(t.brainPath, "brain.config.ts"), "utf8")).toBe(config);
    } finally { await t.close(); }
  });
}
