/** Real isolated test/runtime processes, with native sentinels under the guard. */
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const sentinel = join(import.meta.dir, "helpers/network-sentinels.ts");
const probe = join(import.meta.dir, "helpers/network-probe.ts");
const shellQuote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

async function run(scenario: string, entry: "direct" | "targeted" | "full" | "package" = "direct", packageDir = ROOT) {
  const dir = mkdtempSync(join(tmpdir(), "network-guard-"));
  try {
    const configFile = join(packageDir, "bunfig.toml");
    const config = (existsSync(configFile) ? Bun.TOML.parse(readFileSync(configFile, "utf8")) : {}) as { test?: { preload?: string[] } };
    const configured = entry === "direct" || entry === "package" ? (config.test?.preload ?? []).map((file) => join(packageDir, file)) : [];
    // Direct commands exercise the actual bunfig configuration. Wrapper
    // probes have only sentinels configured, so they prove its CLI preload.
    writeFileSync(join(dir, "bunfig.toml"), `[test]\npreload = ${JSON.stringify([sentinel, ...configured])}\n`);
    writeFileSync(join(dir, "probe.test.ts"), `import { test } from "bun:test";\nimport { runProbe } from ${JSON.stringify(probe)};\ntest(${JSON.stringify(scenario)}, () => runProbe(${JSON.stringify(scenario === "mock-files" ? "partial" : scenario)}));\n`);
    if (scenario === "mock-files") {
      writeFileSync(join(dir, "mocks.test.ts"), `import {test} from "bun:test"; import {runProbe} from ${JSON.stringify(probe)}; test("restore mocks in another file", () => runProbe("restore-only"));`);
    }
    // A controlled Bun wrapper puts sentinels below any propagated preload.
    // Losing child propagation still cannot contact the internet.
    const fixtureBun = join(dir, "bun");
    writeFileSync(fixtureBun, `#!/bin/sh\ncase "$1" in\n  test|run) subcommand="$1"; shift; exec ${shellQuote(process.execPath)} "$subcommand" --preload ${shellQuote(sentinel)} "$@" ;;\n  *) exec ${shellQuote(process.execPath)} --preload ${shellQuote(sentinel)} "$@" ;;\nesac\n`);
    chmodSync(fixtureBun, 0o755);
    const args = entry === "package" ? ["run", "test"] : entry === "direct" ? ["test", ...(scenario === "mock-files" ? ["./mocks.test.ts"] : []), "./probe.test.ts", "--timeout", "30000"] :
      [join(ROOT, "scripts/test.ts"), ...(entry === "targeted" ? ["./probe.test.ts"] : []), "--timeout", "30000"];
    if (entry === "full" || entry === "package") {
      const { mkdirSync, renameSync } = await import("node:fs");
      mkdirSync(join(dir, "tests"));
      renameSync(join(dir, "probe.test.ts"), join(dir, "tests/probe.test.ts"));
    }
    if (entry === "package") {
      const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: manifest.scripts.test } }));
    }
    // This safe harness deliberately uses node:child_process rather than
    // inheriting a guard ahead of the controlled native sentinels.
    const child = spawn(process.execPath, args, { cwd: dir,
      env: { PATH: process.env.PATH!, PROBE_BUN: fixtureBun, PROBE_DIR: dir }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    const calls = [...output.matchAll(/NATIVE_CALLS=(\[[^\n]*\])/g)].map((match) => JSON.parse(match[1]!) as string[]);
    return { code, output, calls };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("offline test guard", () => {
  const packageManifests = [...new Bun.Glob("packages/*/package.json").scanSync({ cwd: ROOT })];
  test("package entry-point probes have workspace packages to cover", () => expect(packageManifests.length).toBeGreaterThan(0));
  for (const file of packageManifests) {
    test(`${dirname(file)} test command loads its guard`, async () => {
      const result = await run("partial", "package", join(ROOT, dirname(file)));
      expect(result.calls.length, result.output).toBeGreaterThan(0);
      expect(result.calls.flat()).toEqual([]);
      expect(result.output).toContain("Offline test guard");
      expect(result.code).not.toBe(0);
    });
  }
  for (const scenario of ["partial", "robots", "proxy", "curl-forms", "hosts", "retries", "exit-zero", "mocks", "mock-files", "redirect"]) {
    test(`${scenario} fails despite caught errors without dispatching native transport`, async () => {
      const result = await run(scenario);
      expect(result.calls.length, result.output).toBeGreaterThan(0);
      expect(result.calls.flat()).toEqual([]);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("Offline test guard");
      expect(result.output).toContain(scenario === "curl-forms" ? "curl" : "escape.example.invalid");
      if (scenario === "mock-files") expect(result.output).toContain("(pass) restore mocks in another file");
    });
  }
  for (const scenario of ["local", "manual", "redirect-error"]) {
    test(`${scenario} retains real loopback fixture behavior`, async () => {
      const result = await run(scenario);
      expect(result.calls.length).toBeGreaterThan(0);
      expect(result.calls.flat()).toEqual([]);
      expect(result.code, result.output).toBe(0);
    });
  }
  for (const scenario of ["child-async", "child-object", "child-sync", "child-test"]) {
    test(`${scenario} propagates the guard with a replaced environment and cwd`, async () => {
      const result = await run(scenario);
      expect(result.calls.length, result.output).toBe(2);
      expect(result.calls.flat()).toEqual([]);
      expect(result.output).toContain("Offline test guard");
      // The child fails, and its parent asserts that failure as test evidence.
      expect(result.code, result.output).toBe(0);
    });
  }

  test("intentional measurement clients capture 410/403 outside test mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "network-measurement-"));
    try {
      const script = join(dir, "measure.ts");
      writeFileSync(script, `
        const calls = [];
        globalThis.fetch = async (input) => {
          const url = input instanceof Request ? input.url : String(input);
          calls.push(url);
          return new Response("fixture response", { status: url.endsWith("/gone") ? 410 : 403 });
        };
        const { TeeingClient } = await import(${JSON.stringify(join(ROOT, "packages/module-jobs/scripts/measure-boards.ts"))});
        const client = new TeeingClient({ respectRobots: false, defaultDelayMs: 0 });
        for (const path of ["gone", "denied"]) await client.getText("https://measurement.example.invalid/" + path, { retries: 0 }).catch(() => {});
        console.log(JSON.stringify({ calls, captures: client.captures }));
      `);
      const child = spawn(process.execPath, [script], { cwd: ROOT, env: { PATH: process.env.PATH! }, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      let error = "";
      child.stdout.on("data", (data) => { output += data; });
      child.stderr.on("data", (data) => { error += data; });
      const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
      expect(code, error).toBe(0);
      const result = JSON.parse(output);
      expect(result.calls).toHaveLength(2);
      expect(result.captures.map((capture: { status: number; body: string }) => [capture.status, capture.body]))
        .toEqual([[410, "fixture response"], [403, "fixture response"]]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  for (const entry of ["targeted", "full"] as const) {
    test(`${entry} repository test entry point loads the guard`, async () => {
      const result = await run("partial", entry);
      expect(result.calls.flat()).toEqual([]);
      expect(result.output).toContain("Offline test guard");
      expect(result.code).not.toBe(0);
    });
  }
});
