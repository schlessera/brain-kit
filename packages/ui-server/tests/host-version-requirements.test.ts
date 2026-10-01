import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp, type HostVersionRequirements } from "../src/app";
import { createBackendRegistry, createStaticBackendRegistry, probeBackendRuntimes } from "../src/agent/backend";
import { backendModule as claudeDescriptor } from "@schlessera/brain-backend-claude";
import type { BackendModuleContext, BackendRuntimeReport } from "@schlessera/brain-ui-sdk/server";
import { createBrainClient, probeBrainCliVersion } from "../src/brain/client";
import { createRecordingObservability } from "../src/observability";
import { resolveServerConfig } from "../src/config/env";
import { makeFakeBackend } from "./helpers/fake-backend";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(version = "0.40.0") {
  const root = mkdtempSync(join(tmpdir(), "host-version-"));
  roots.push(root);
  const calls = join(root, "calls.jsonl");
  const bin = join(root, "node_modules/.bin/brain");
  mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
  function install(nextVersion: string) {
    writeFileSync(bin, `#!/usr/bin/env bun\nimport { appendFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nappendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");\nif (args[0] === "--version") console.log(${JSON.stringify(nextVersion)});\nelse console.log(JSON.stringify({ results: [], warnings: [] }));\n`);
    chmodSync(bin, 0o755);
  }
  install(version);
  const config = resolveServerConfig({ AUTH_MODE: "none", HOST: "127.0.0.1", NODE_ENV: "test", DB_PATH: join(root, "ui.db"), BRAIN_PATH: root, BRAIN_UI_PRICING_DISCOVERY: "0" });
  const observability = createRecordingObservability();
  const registry = createStaticBackendRegistry([makeFakeBackend({ id: "fake" })]);
  const invocations = () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]) : [];
  return { root, bin, install, config, observability, registry, invocations };
}

describe("host version requirements at app startup", () => {
  for (const versionRequirements of [null, [], { other: "1.2.3" }]) {
    test(`invalid whole requirements object ${JSON.stringify(versionRequirements)} refuses before resources`, async () => {
      const f = fixture();
      await expect(createApp({ ...f, versionRequirements: versionRequirements as unknown as HostVersionRequirements })).rejects.toThrow("host versionRequirements");
      expect(f.invocations()).toEqual([]);
      expect(existsSync(f.config.dbPath)).toBe(false);
    });
  }
  for (const backends of [{ unknown: { sdk: "1.0.0" } }, { pi: { sdk: "1.0.0" } }, { claude: { sdk: "" } }, { claude: { runtime: "1.2" } }, { claude: { other: "1.2.3" } }, []]) {
    test(`whole backend configuration refuses ${JSON.stringify(backends)} before a probe`, async () => {
      const f = fixture();
      const { registry: _registry, ...options } = f;
      await expect(createApp({ ...options, versionRequirements: { backends } as unknown as HostVersionRequirements })).rejects.toThrow("versionRequirements.backends");
      expect(f.invocations()).toEqual([]);
      expect(existsSync(f.config.dbPath)).toBe(false);
    });
  }
  for (const brainCli of ["", "v0.40.0", "0.40", "0.40.0\u00a0"]) {
    test(`invalid host minimum ${JSON.stringify(brainCli)} refuses before probing or opening a DB`, async () => {
      const f = fixture();
      await expect(createApp({ ...f, versionRequirements: { brainCli } })).rejects.toThrow("versionRequirements.brainCli");
      expect(f.invocations()).toEqual([]);
      expect(existsSync(f.config.dbPath)).toBe(false);
    });
  }
  test("below an explicit host floor refuses, despite satisfying the package floor", async () => {
    const f = fixture("0.39.0");
    await expect(createApp({ ...f, versionRequirements: { brainCli: "0.40.0" } })).rejects.toThrow("host versionRequirements.brainCli");
    expect(f.invocations()).toEqual([["--version"]]);
    expect(existsSync(f.config.dbPath)).toBe(false);
  });
  test("a weaker host floor cannot lower the package floor", async () => {
    const f = fixture("0.32.9");
    await expect(createApp({ ...f, versionRequirements: { brainCli: "0.1.0" } })).rejects.toThrow("0.33.0");
    expect(existsSync(f.config.dbPath)).toBe(false);
  });
  test("explicit unknown refuses while default unknown logs a warning and boots", async () => {
    const f = fixture("unknown");
    await expect(createApp({ ...f, versionRequirements: { brainCli: "0.40.0" } })).rejects.toThrow("unknown");
    expect(existsSync(f.config.dbPath)).toBe(false);
    const app = await createApp(f);
    try {
      expect(f.observability.logs.count({ scope: "brain", severity: "WARN" })).toBeGreaterThan(0);
      expect(existsSync(f.config.dbPath)).toBe(true);
    } finally { await app.close(); }
  });
  test("an injected registry cannot silently bypass explicit backend requirements", async () => {
    const f = fixture();
    const versionRequirements: HostVersionRequirements = { backends: { claude: { sdk: "0.3.283" } } };
    expect(Object.keys(versionRequirements.backends!)).toHaveLength(1);
    await expect(createApp({ ...f, versionRequirements })).rejects.toThrow("injected registry");
    expect(f.invocations()).toEqual([]);
    expect(existsSync(f.config.dbPath)).toBe(false);
  });
  test("a CLI replaced after startup is refused before a user search is executed", async () => {
    const f = fixture();
    const app = await createApp({ ...f, versionRequirements: { brainCli: "0.40.0" } });
    try {
      f.install("0.39.0");
      const response = await app.fetch(new Request("http://localhost/api/brain/search?q=user-query"));
      expect(response.status).toBe(500);
      expect(await response.json()).toHaveProperty("error", expect.stringContaining("invocation"));
      expect(f.invocations().filter(args => args[0] === "search")).toEqual([]);
      expect(f.invocations().filter(args => args[0] === "--version").length).toBeGreaterThan(1);
    } finally { await app.close(); }
  });
  test("a replaced CLI is also refused before streaming sync's independent launch", async () => {
    const f = fixture();
    const app = await createApp({ ...f, versionRequirements: { brainCli: "0.40.0" } });
    try {
      f.install("0.39.0");
      const response = await app.fetch(new Request("http://localhost/api/brain/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
      expect(await response.text()).toContain("incompatible");
      expect(f.invocations().filter(args => args[0] === "sync")).toEqual([]);
    } finally { await app.close(); }
  });
});

describe("real descriptor-backed host forwarding", () => {
  const report: BackendRuntimeReport = { runtime: { name: "fixture-runtime", version: "9.0.0", command: "fixture-command", hostProvided: true }, sdk: { name: "fixture-sdk", version: "8.0.0" }, measured: { runtime: "7.0.0", sdk: "7.0.0", matches: false } };
  test("createApp forwards both nonempty minima to boot, registry probing and resolution", async () => {
    const f = fixture();
    const contexts: BackendModuleContext[] = [];
    const minima = { sdk: "8.0.0", runtime: "9.0.0" };
    const probe = spyOn(claudeDescriptor, "probeRuntime").mockImplementation(async context => { contexts.push(context); return report; });
    const resolve = spyOn(claudeDescriptor, "resolveFromEnv").mockImplementation(context => {
      contexts.push(context);
      return { ok: true, value: { backend: makeFakeBackend({ id: "claude" }) } };
    });
    const { registry: _registry, ...options } = f;
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      app = await createApp({ ...options, versionRequirements: { brainCli: "0.40.0", backends: { claude: minima } } });
      const response = await app.fetch(new Request("http://localhost/api/providers"));
      expect(response.status).toBe(200);
      expect(probe).toHaveBeenCalledTimes(2);
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(contexts).toHaveLength(3);
      for (const context of contexts) expect(context.versionRequirements).toEqual(minima);
      expect(f.observability.logs.count({ scope: "agent", severity: "WARN" })).toBeGreaterThan(0); // measurement remains independent
    } finally { await app?.close(); probe.mockRestore(); resolve.mockRestore(); }
  });
  test("a direct real registry verifies explicit requirements before constructing its backend", async () => {
    const f = fixture();
    const probe = spyOn(claudeDescriptor, "probeRuntime").mockResolvedValue(report);
    const resolve = spyOn(claudeDescriptor, "resolveFromEnv");
    try {
      const registry = createBackendRegistry({ brainPath: f.root, agent: f.config.agent, versionRequirements: { claude: { runtime: "10.0.0" } } });
      await expect(registry.getBackends()).rejects.toThrow("registry construction");
      expect(probe).toHaveBeenCalledTimes(1);
      expect(resolve).not.toHaveBeenCalled();
    } finally { probe.mockRestore(); resolve.mockRestore(); }
  });
  test("the actual selected temporary backend executable below a host floor refuses app startup", async () => {
    const f = fixture();
    const claude = join(f.root, "claude");
    writeFileSync(claude, "#!/bin/sh\necho '2.0.0 (Claude Code)'\n");
    chmodSync(claude, 0o755);
    const config = resolveServerConfig({ AUTH_MODE: "none", HOST: "127.0.0.1", NODE_ENV: "test", DB_PATH: f.config.dbPath, BRAIN_PATH: f.root, BRAIN_UI_PRICING_DISCOVERY: "0", CLAUDE_CODE_PATH: claude });
    await expect(createApp({ config, observability: f.observability, versionRequirements: { backends: { claude: { runtime: "3.0.0" } } } })).rejects.toThrow(/claude runtime.*startup.*2\.0\.0.*host versionRequirements.backends.claude.runtime.*3\.0\.0/);
    expect(existsSync(f.config.dbPath)).toBe(false);
    expect(f.invocations()).toEqual([]);
  });
  test("a requested SDK identity cannot be silently skipped when a probe omits it", async () => {
    const f = fixture();
    const probe = spyOn(claudeDescriptor, "probeRuntime").mockResolvedValue({ runtime: report.runtime });
    try {
      await expect(probeBackendRuntimes(f.config.agent, f.root, undefined, undefined, { claude: { sdk: "8.0.0" } })).rejects.toThrow("does not report a verifiable sdk identity");
    } finally { probe.mockRestore(); }
  });
  test("a descriptor without a probe refuses explicit identities", async () => {
    const f = fixture();
    const descriptor = { ...claudeDescriptor, probeRuntime: undefined };
    await expect(probeBackendRuntimes(f.config.agent, f.root, undefined, () => ({ backendModule: descriptor }), { claude: { runtime: "9.0.0" } })).rejects.toThrow("no runtime probe");
    expect(await probeBackendRuntimes(f.config.agent, f.root, undefined, () => ({ backendModule: descriptor }))).toEqual([]);
  });
});

describe("explicit probes retain bounded wrapper cleanup", () => {
  for (const timesOut of [false, true]) {
    test(`an explicit ${timesOut ? "timed-out" : "failed"} probe leaves no wrapper child`, async () => {
      const f = fixture();
      const wrapper = join(f.root, "wrapper.sh");
      const pidFile = join(f.root, "child.pid");
      writeFileSync(wrapper, `#!/bin/sh\nsleep 300 ${timesOut ? "" : ">/dev/null 2>&1 "}&\necho $! > '${pidFile}'\n${timesOut ? "sleep 300" : "exit 4"}\n`);
      chmodSync(wrapper, 0o755);
      const previous = process.env.BRAIN_UI_EXEC_WRAPPER;
      process.env.BRAIN_UI_EXEC_WRAPPER = wrapper;
      try {
        await expect(probeBrainCliVersion(f.root, f.observability.logger("brain"), { minimumVersion: "0.40.0" })).rejects.toThrow(timesOut ? "within 5 s" : "exited 4");
        const pid = Number(readFileSync(pidFile, "utf8").trim());
        expect(pid).toBeGreaterThan(0);
        const until = Date.now() + 2_000;
        const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
        while (alive() && Date.now() < until) await Bun.sleep(10);
        expect(alive()).toBe(false);
        expect(f.invocations()).toEqual([]);
      } finally {
        if (previous === undefined) delete process.env.BRAIN_UI_EXEC_WRAPPER;
        else process.env.BRAIN_UI_EXEC_WRAPPER = previous;
      }
    });
  }
});

describe("explicit CLI minima on direct clients and probes", () => {
  test("the explicit check and invocation use the same packaged command, wrapper, cwd and environment", async () => {
    const f = fixture();
    const wrapper = join(f.root, "wrapper.ts");
    const records = join(f.root, "wrapper.jsonl");
    writeFileSync(wrapper, `#!/usr/bin/env bun\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(records)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), color: process.env.NO_COLOR }) + "\\n");\nconst child = Bun.spawn(process.argv.slice(2), { stdin: "inherit", stdout: "inherit", stderr: "inherit" });\nprocess.exit(await child.exited);\n`);
    chmodSync(wrapper, 0o755);
    const previous = process.env.BRAIN_UI_EXEC_WRAPPER;
    process.env.BRAIN_UI_EXEC_WRAPPER = wrapper;
    try {
      await createBrainClient({ brainPath: f.root, minimumVersion: "0.40.0" }).search("user-query");
      expect(readFileSync(records, "utf8").trim().split("\n").map(line => JSON.parse(line))).toEqual([
        { args: [f.bin, "--version"], cwd: f.root, color: "1" },
        { args: [f.bin, "search", "--", "user-query"], cwd: f.root, color: "1" },
      ]);
      expect(f.invocations()).toEqual([["--version"], ["search", "--", "user-query"]]);
    } finally {
      if (previous === undefined) delete process.env.BRAIN_UI_EXEC_WRAPPER;
      else process.env.BRAIN_UI_EXEC_WRAPPER = previous;
    }
  });
  test("an explicit floor verifies the legacy script when there is no packaged executable", async () => {
    const f = fixture();
    rmSync(f.bin);
    mkdirSync(join(f.root, "scripts"));
    writeFileSync(join(f.root, "scripts/brain-cli.ts"), 'console.log(process.argv.includes("--version") ? "0.39.0" : "unexpected invocation");\n');
    await expect(createBrainClient({ brainPath: f.root, minimumVersion: "0.40.0" }).search("user-query")).rejects.toThrow("0.39.0");
    expect(f.invocations()).toEqual([]);
  });
  test("a direct client verifies before the selected user command", async () => {
    const f = fixture("0.39.0");
    await expect(createBrainClient({ brainPath: f.root, minimumVersion: "0.40.0" }).search("user-query")).rejects.toThrow("invocation");
    expect(f.invocations()).toEqual([["--version"]]);
  });
  test("a cancelled explicit invocation check reaps its child before sending user input", async () => {
    const f = fixture();
    const pidFile = join(f.root, "probe.pid");
    writeFileSync(f.bin, `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 300\n`);
    const client = createBrainClient({ brainPath: f.root, minimumVersion: "0.40.0", searchTimeoutMs: 500 });
    const started = Date.now();
    await expect(client.search("user-query")).rejects.toHaveProperty("name", "TimeoutError");
    expect(Date.now() - started).toBeLessThan(2_000);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(f.invocations()).toEqual([]);
  });
  test("a failed explicit probe reports its owner, phase and corrective action", async () => {
    const f = fixture();
    writeFileSync(f.bin, "#!/bin/sh\nexit 4\n");
    const log = f.observability.logger("brain");
    await expect(probeBrainCliVersion(f.root, log, { minimumVersion: "0.40.0", phase: "invocation" })).rejects.toThrow(/host versionRequirements.brainCli.*0\.40\.0.*bump the brain repo/);
  });
});
