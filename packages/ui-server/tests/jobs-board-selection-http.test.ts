import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BRAIN_BIN, keylessEnv, runCli } from "../../core/tests/cli-harness";
import { RETIRED_SOURCES } from "../../module-jobs/src/types";
import { httpContractApp } from "./helpers/http-contract-app";

function git(root: string, args: string[]) {
  const result = Bun.spawnSync(["git", "-C", root, ...args]);
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
  return new TextDecoder().decode(result.stdout).trim();
}

test("mounted jobs settings reject invalid boards before writes and save an intentional empty selection", async () => {
  const t = await httpContractApp({ env: { BRAIN_UI_ALLOW_LOOPBACK_ORIGIN: "1" } });
  try {
    symlinkSync(resolve(import.meta.dir, "../../../node_modules/@schlessera"), join(t.brainPath, "node_modules/@schlessera"));
    mkdirSync(join(t.brainPath, "career"));
    writeFileSync(join(t.brainPath, "career/criteria.md"), readFileSync(resolve(import.meta.dir, "../../module-jobs/tests/fixtures/criteria.md"), "utf8"));
    const config = `export default ${JSON.stringify({ modules: { "@schlessera/brain-module-jobs": { criteria: "career/criteria.md", boards: ["workingnomads"] } } })};\n`;
    writeFileSync(join(t.brainPath, "brain.config.ts"), config);
    writeFileSync(join(t.brainPath, "node_modules/.bin/brain"), `#!${process.execPath}\nprocess.env.BRAIN_ROOT=${JSON.stringify(t.brainPath)}; await import(${JSON.stringify(BRAIN_BIN)});\n`, { mode: 0o755 });
    git(t.brainPath, ["init", "--initial-branch=main"]);
    git(t.brainPath, ["config", "user.name", "Alex Example"]);
    git(t.brainPath, ["config", "user.email", "alex@example.com"]);
    git(t.brainPath, ["config", "commit.gpgsign", "false"]);
    git(t.brainPath, ["add", "brain.config.ts", "career"]);
    git(t.brainPath, ["commit", "-m", "fixture"]);
    const head = git(t.brainPath, ["rev-parse", "HEAD"]);
    const path = "/api/modules/jobs/settings";
    const read = await t.fetch(path);
    expect(read.status).toBe(200);
    const snapshot = await read.json();
    expect(snapshot.values.boards).toEqual(["workingnomads"]);
    const put = (boards: string[]) => t.fetch(path, { method: "PUT", headers: { "content-type": "application/json", "If-Match": snapshot.revision }, body: JSON.stringify({ values: { boards } }) });
    for (const invalid of ["nosuchboard", "remoteineurope"]) {
      const boards = ["remoteok", invalid];
      expect(boards).toHaveLength(2);
      const response = await put(boards);
      expect(response.status).toBe(422);
      const body = await response.json();
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0].path).toBe("boards.1");
      expect(body.errors[0].message).toContain(invalid);
      if (invalid === "remoteineurope") expect(body.errors[0].message).toContain(RETIRED_SOURCES.remoteineurope);
      expect(existsSync(join(t.brainPath, "settings/jobs.json"))).toBe(false);
      expect(git(t.brainPath, ["rev-parse", "HEAD"])).toBe(head);
    }
    const saved = await put([]);
    expect(saved.status).toBe(200);
    const body = await saved.json();
    expect(body.changed).toBe(true);
    expect(body.values.boards).toEqual([]);
    expect(body.provenance.boards).toBe("saved");
    expect(git(t.brainPath, ["rev-list", "--count", "HEAD"])).toBe("2");
    expect(git(t.brainPath, ["show", "--pretty=", "--name-only", "HEAD"])).toBe("settings/jobs.json");
    const cli = await runCli(t.brainPath, ["module", "settings", "jobs", "--json"]);
    expect(cli.code, cli.stderr + cli.stdout).toBe(0);
    expect(JSON.parse(cli.stdout).values).toEqual(body.values);
    const child = Bun.spawn([process.execPath, "--preload", resolve(import.meta.dir, "../../module-jobs/tests/helpers/default-boards-preload.ts"), BRAIN_BIN, "jobs", "scrape", "--json"], { env: keylessEnv(t.brainPath), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, stderr + stdout).toBe(0);
    expect(JSON.parse(stdout).report).toEqual({ sources: [], dedup: { checked: 0, duplicates_found: 0 }, scored: 0, total_new: 0, total_errors: [] });
    expect(readFileSync(join(t.brainPath, "brain.config.ts"), "utf8")).toBe(config);
  } finally { await t.close(); }
});
