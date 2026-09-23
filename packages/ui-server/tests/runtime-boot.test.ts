/**
 * Boot probes the Claude Code binary a turn would spawn (#211): a binary that
 * is missing or will not start refuses the boot, a runtime other than the
 * measured one is a warning naming both pairs, and `/api/status` reports what
 * was found — while the public `/api/health` stays as it was.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEASURED_RUNTIME } from "@schlessera/brain-backend-claude";
import type { BackendRuntimeReport } from "@schlessera/brain-ui-sdk/server";

import { probeBackendRuntimes } from "../src/agent/backend";
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
  test("refuses when the binary a turn would spawn does not exist", () => {
    const missing = join(tmpdir(), `no-such-claude-${process.pid}`);
    expect(() => createTestApp({ env: { CLAUDE_CODE_PATH: missing } })).toThrow(missing);
  });

  test("refuses when that binary exits non-zero on --version", () => {
    expect(() => createTestApp({ env: { CLAUDE_CODE_PATH: fakeClaude("broken", 2) } })).toThrow(
      /exited 2 on --version: broken/
    );
  });

  test("reports what it found on /api/status, and leaves /api/health's body alone", async () => {
    const t = createTestApp({ env: { CLAUDE_CODE_PATH: fakeClaude(`${MEASURED_RUNTIME.claudeCode} (Claude Code)`) } });
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
      t.teardown();
    }
  });
});

describe("a runtime other than the measured one", () => {
  function probeWith(report: BackendRuntimeReport) {
    const observability = createRecordingObservability();
    const probes = probeBackendRuntimes(
      resolveServerConfig({ AGENT_BACKEND: "claude" }).agent,
      tmpdir(),
      observability.logger("agent"),
      () => ({
        backendModule: {
          id: "claude",
          resolveFromEnv: () => ({ ok: false, error: new Error("unused") }),
          profileSchema: { parse: () => ({ ok: true, profiles: [] }) },
          settingsHooks: {},
          probeRuntime: () => report,
        },
      })
    );
    return { probes, warnings: observability.logs.find({ scope: "agent", severity: "WARN" }) };
  }

  test("warns once, naming both pairs, and boot continues", () => {
    const { probes, warnings } = probeWith({
      runtime: { name: "claude-code", version: "2.1.999", command: "/x/claude", hostProvided: true },
      sdk: { name: "@anthropic-ai/claude-agent-sdk", version: MEASURED_RUNTIME.agentSdk },
      measured: { runtime: MEASURED_RUNTIME.claudeCode, sdk: MEASURED_RUNTIME.agentSdk, matches: false },
    });
    expect(probes).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]!.body)).toContain(`2.1.999 / SDK ${MEASURED_RUNTIME.agentSdk}`);
    expect(String(warnings[0]!.body)).toContain(`${MEASURED_RUNTIME.claudeCode} / SDK ${MEASURED_RUNTIME.agentSdk}`);
  });

  test("the same CLI under a different SDK is a different pair, and warns too", () => {
    const { warnings } = probeWith({
      runtime: { name: "claude-code", version: MEASURED_RUNTIME.claudeCode, command: "/x/claude", hostProvided: true },
      sdk: { name: "@anthropic-ai/claude-agent-sdk", version: "0.3.999" },
      measured: { runtime: MEASURED_RUNTIME.claudeCode, sdk: MEASURED_RUNTIME.agentSdk, matches: false },
    });
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]!.body)).toContain(`${MEASURED_RUNTIME.claudeCode} / SDK 0.3.999`);
  });
});
