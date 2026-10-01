/**
 * Boot probes the Claude Code binary a turn would spawn (#211): a binary that
 * is missing or will not start refuses the boot, a runtime other than the
 * measured one is a warning naming both pairs, and `/api/status` reports what
 * was found — while the public `/api/health` stays as it was.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEASURED_RUNTIME } from "@schlessera/brain-backend-claude";
import type { BackendRuntimeReport } from "@schlessera/brain-ui-sdk/server";

import { probeBackendRuntimes } from "../src/agent/backend";
import { createApp } from "../src/app";
import { resolveServerConfig } from "../src/config/env";
import { createRecordingObservability } from "../src/observability/index";
import { createTestApp } from "./helpers/test-app";

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeClaude(output: string, exitCode = 0): string {
  const dir = mkdtempSync(join(tmpdir(), "boot-claude-"));
  scratch.push(dir);
  const path = join(dir, "claude");
  writeFileSync(path, `#!/bin/sh\necho ${JSON.stringify(output)}\nexit ${exitCode}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("boot", () => {
  test("refuses when the binary a turn would spawn does not exist", async () => {
    const missing = join(tmpdir(), `no-such-claude-${process.pid}`);
    await expect(createTestApp({ env: { CLAUDE_CODE_PATH: missing } })).rejects.toThrow(missing);
  });

  test("a refused boot opens nothing: no database is created", async () => {
    const dir = mkdtempSync(join(tmpdir(), "boot-refused-"));
    scratch.push(dir);
    const brainPath = join(dir, "brain");
    mkdirSync(brainPath);
    const dbPath = join(dir, "ui.db");
    const config = resolveServerConfig({
      AUTH_MODE: "none",
      HOST: "127.0.0.1",
      NODE_ENV: "test",
      BRAIN_PATH: brainPath,
      DB_PATH: dbPath,
      BRAIN_UI_PRICING_DISCOVERY: "0",
      CLAUDE_CODE_PATH: join(dir, "no-such-claude"),
    });
    await expect(createApp({ config })).rejects.toThrow("no-such-claude");
    expect(existsSync(dbPath)).toBe(false);
  });

  test("refuses when that binary exits non-zero on --version", async () => {
    await expect(createTestApp({ env: { CLAUDE_CODE_PATH: fakeClaude("broken", 2) } })).rejects.toThrow(/exited 2 on --version: broken/);
  });

  test("reports what it found on /api/status, and leaves /api/health's body alone", async () => {
    const t = await createTestApp({ env: { CLAUDE_CODE_PATH: fakeClaude(`${MEASURED_RUNTIME.claudeCode} (Claude Code)`) } });
    try {
      const status = (await (await t.fetch("/api/status")).json()) as {
        runtime: { boot: Array<{ backendId: string } & BackendRuntimeReport> };
      };
      expect(status.runtime.boot).toHaveLength(1);
      expect(status.runtime.boot[0]).toMatchObject({
        backendId: "claude",
        runtime: { name: "claude-code", version: MEASURED_RUNTIME.claudeCode, hostProvided: true },
        sdk: { version: MEASURED_RUNTIME.agentSdk },
        measured: { matches: true },
      });
      const health = (await (await t.fetch("/api/health")).json()) as Record<string, unknown>;
      expect(Object.keys(health).sort()).toEqual(["status", "timestamp", "uptime"]);
    } finally {
      await t.teardown();
    }
  });
});

describe("a runtime other than the measured one", () => {
  async function probeWith(report: BackendRuntimeReport) {
    const observability = createRecordingObservability();
    const probes = await probeBackendRuntimes(
      resolveServerConfig({ AGENT_BACKEND: "claude" }).agent,
      tmpdir(),
      observability.logger("agent"),
      () => ({
        backendModule: {
          id: "claude",
          resolveFromEnv: () => ({ ok: false, error: new Error("unused") }),
          profileSchema: { parse: () => ({ ok: true, profiles: [] }) },
          settingsHooks: {},
          probeRuntime: async () => report,
        },
      })
    );
    return { probes, warnings: observability.logs.find({ scope: "agent", severity: "WARN" }) };
  }

  test("warns once, naming both pairs, and boot continues", async () => {
    const { probes, warnings } = await probeWith({
      runtime: { name: "claude-code", version: "2.1.999", command: "/x/claude", hostProvided: true },
      sdk: { name: "@anthropic-ai/claude-agent-sdk", version: MEASURED_RUNTIME.agentSdk },
      measured: { runtime: MEASURED_RUNTIME.claudeCode, sdk: MEASURED_RUNTIME.agentSdk, matches: false },
    });
    expect(probes).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]!.body)).toContain(`2.1.999 / SDK ${MEASURED_RUNTIME.agentSdk}`);
    expect(String(warnings[0]!.body)).toContain(`${MEASURED_RUNTIME.claudeCode} / SDK ${MEASURED_RUNTIME.agentSdk}`);
  });

  test("the same CLI under a different SDK is a different pair, and warns too", async () => {
    const { warnings } = await probeWith({
      runtime: { name: "claude-code", version: MEASURED_RUNTIME.claudeCode, command: "/x/claude", hostProvided: true },
      sdk: { name: "@anthropic-ai/claude-agent-sdk", version: "0.3.999" },
      measured: { runtime: MEASURED_RUNTIME.claudeCode, sdk: MEASURED_RUNTIME.agentSdk, matches: false },
    });
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]!.body)).toContain(`${MEASURED_RUNTIME.claudeCode} / SDK 0.3.999`);
  });
});


describe("asynchronous startup resource ordering", () => {
  for (const succeeds of [false, true]) {
    test(`a pending required probe opens no resources; ${succeeds ? "successful" : "refused"} startup ${succeeds ? "then serves" : "never serves"}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "async-startup-"));
      scratch.push(dir);
      const brainPath = join(dir, "brain");
      mkdirSync(brainPath);
      const dbPath = join(dir, "ui.db");
      const marker = join(dir, "probe-started");
      const completedProbe = join(dir, "probe-finished");
      const path = join(dir, "claude");
      writeFileSync(path, `#!/bin/sh\ntouch '${marker}'\nsleep 0.3\ntouch '${completedProbe}'\necho '2.0.0 (Claude Code)'\nexit ${succeeds ? 0 : 2}\n`);
      chmodSync(path, 0o755);
      const config = resolveServerConfig({ AUTH_MODE: "none", HOST: "127.0.0.1", NODE_ENV: "test", BRAIN_PATH: brainPath, DB_PATH: dbPath, BRAIN_UI_PRICING_DISCOVERY: "0", CLAUDE_CODE_PATH: path });
      let app: Awaited<ReturnType<typeof createApp>> | undefined;
      let server: ReturnType<typeof Bun.serve> | undefined;
      const startup = createApp({ config }).then(ready => {
        app = ready;
        server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: ready.fetch, websocket: ready.websocket });
      });
      // Observe any refusal immediately, including when a mutation removes the await.
      const outcome = startup.then(() => undefined, error => error as Error);
      try {
        expect(startup).toBeInstanceOf(Promise);
        const until = Date.now() + 2_000;
        while (!existsSync(marker) && Date.now() < until) await Bun.sleep(5);
        expect(existsSync(marker)).toBe(true);
        let pendingObservations = 0;
        while (!existsSync(completedProbe) && Date.now() < until) {
          pendingObservations++;
          expect(existsSync(dbPath)).toBe(false);
          expect(server).toBeUndefined();
          await Bun.sleep(5);
        }
        expect(pendingObservations).toBeGreaterThan(0);
        expect(existsSync(completedProbe)).toBe(true);
        const error = await outcome;
        if (succeeds) {
          expect(error).toBeUndefined();
          expect(existsSync(dbPath)).toBe(true);
          expect(server).toBeDefined();
          const response = await fetch(`http://127.0.0.1:${server!.port}/api/health`);
          expect(response.status).toBe(200);
          expect(await response.json()).toHaveProperty("status", "healthy");
        } else {
          expect(error?.message).toContain("exited 2 on --version");
          expect(existsSync(dbPath)).toBe(false);
          expect(server).toBeUndefined();
        }
      } finally {
        await outcome;
        await server?.stop(true);
        await app?.close();
      }
    });
  }

  test("invalid subscription configuration refuses before invoking a runtime probe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "async-validation-"));
    scratch.push(dir);
    const marker = join(dir, "invoked");
    const path = join(dir, "claude");
    writeFileSync(path, `#!/bin/sh\ntouch '${marker}'\necho '2.0.0 (Claude Code)'\n`);
    chmodSync(path, 0o755);
    const dbPath = join(dir, "ui.db");
    const config = resolveServerConfig({ AUTH_MODE: "none", HOST: "127.0.0.1", NODE_ENV: "test", BRAIN_PATH: dir, DB_PATH: dbPath, BRAIN_UI_PRICING_DISCOVERY: "0", CLAUDE_CODE_PATH: path, BRAIN_UI_CLAUDE_TOKEN_MINTED_AT: "last spring" });
    await expect(createApp({ config })).rejects.toThrow("BRAIN_UI_CLAUDE_TOKEN_MINTED_AT");
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(dbPath)).toBe(false);
  });
});


describe("backend-owned compatibility checks", () => {
  test("a constrained below-floor Claude probe refuses before opening resources", async () => {
    const dir = mkdtempSync(join(tmpdir(), "boot-runtime-floor-")); scratch.push(dir);
    const brainPath = join(dir, "brain"); mkdirSync(brainPath);
    const dbPath = join(dir, "ui.db");
    const config = resolveServerConfig({ AUTH_MODE: "none", HOST: "127.0.0.1", NODE_ENV: "test", BRAIN_PATH: brainPath, DB_PATH: dbPath,
      BRAIN_UI_PRICING_DISCOVERY: "0", CLAUDE_CODE_PATH: fakeClaude("2.1.282 (Claude Code)") });
    await expect(createApp({ config, versionRequirements: { backends: { claude: { runtime: "2.1.283" } } } })).rejects.toThrow(/host.*2\.1\.283/);
    expect(existsSync(dbPath)).toBe(false);
  });
  test("compatible unmeasured Claude runtime preserves boot warning and provenance with minima", async () => {
    const observability = createRecordingObservability();
    const t = await createTestApp({ env: { CLAUDE_CODE_PATH: fakeClaude("2.1.999 (Claude Code)") }, appOptions: {
      observability, versionRequirements: { backends: { claude: { sdk: "0.3.250", runtime: "2.1.283" } } },
    } });
    try {
      const status = await (await t.fetch("/api/status")).json() as { runtime: { boot: unknown[] } };
      expect(status.runtime.boot).toHaveLength(1);
      expect(status.runtime.boot[0]).toMatchObject({ backendId: "claude", runtime: { version: "2.1.999" }, sdk: { version: MEASURED_RUNTIME.agentSdk }, measured: { matches: false } });
      expect(observability.logs.find({ scope: "agent", severity: "WARN" }).some(log => String(log.body).includes("not the one its behaviour was measured against"))).toBe(true);
    } finally { await t.teardown(); }
  });
  test("Pi startup and provider construction report SDK without requiring an inactive Claude executable", async () => {
    const t = await createTestApp({ env: { AGENT_BACKEND: "pi", CLAUDE_CODE_PATH: "/missing-inactive-claude", BRAIN_UI_CLAUDE_PROFILES: "invalid inactive roster",
      BRAIN_UI_PI_PROFILES: JSON.stringify([{ id: "pi-test", label: "Pi test", vendor: "openai", model: "gpt-6.1-sol" }]) },
      appOptions: { versionRequirements: { backends: { pi: { sdk: "0.99.1" } } } } });
    try {
      const status = await (await t.fetch("/api/status")).json() as { runtime: { boot: unknown[] } };
      expect(status.runtime.boot).toEqual([{ backendId: "pi", sdk: { name: "@earendil-works/pi-coding-agent", version: "0.99.2" } }]);
      const providers = await t.fetch("/api/providers");
      expect(providers.status).toBe(200);
      const body = await providers.json() as { providers: unknown[] };
      expect(body.providers.length).toBeGreaterThan(0);
      const health = await (await t.fetch("/api/health")).json() as Record<string, unknown>;
      expect(Object.keys(health).sort()).toEqual(["status", "timestamp", "uptime"]);
    } finally { await t.teardown(); }
  });
});
