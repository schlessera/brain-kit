/**
 * The installed runtime is the one the permission design was measured
 * against (#209).
 *
 * What `permission-hooks.ts`, `input-rewrite-hooks.ts` and their tests say
 * about the runtime was measured against the pair `MEASURED_RUNTIME` names.
 * The SDK bundles the Claude Code release it ships with, and the lockfile pins
 * the SDK, so a deployment built from this lockfile runs exactly that pair —
 * and bumping the SDK here fails this test until somebody re-runs
 * `scripts/measure-claude-runtime.ts` and updates the constant with its output
 * (docs/decisions/claude-code-runtime.md).
 *
 * The SDK is located the way the backend loads it: resolved from the
 * backend's own source, then `package.json` and `manifest.json` are read
 * beside the resolved entry. Neither file is an exported subpath of the SDK,
 * and a root `node_modules` path could name a different copy.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { MEASURED_RUNTIME } from "../src/measured-runtime";

const BACKEND_SOURCE = join(import.meta.dir, "../src");

/** The SDK entry the backend's own imports resolve to. */
function backendSdkEntry(): string {
  return Bun.resolveSync("@anthropic-ai/claude-agent-sdk", BACKEND_SOURCE);
}

function installed(): { agentSdk: string; claudeCode: string } {
  const dir = dirname(backendSdkEntry());
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string; version: string };
  if (pkg.name !== "@anthropic-ai/claude-agent-sdk") {
    throw new Error(`resolved ${pkg.name} beside the SDK entry, not the SDK`);
  }
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { version: string };
  return { agentSdk: pkg.version, claudeCode: manifest.version };
}

/** The mismatches between a constant and what is installed. */
function runtimeDrift(
  measured: { agentSdk: string; claudeCode: string },
  actual: { agentSdk: string; claudeCode: string }
): string[] {
  const drift: string[] = [];
  if (measured.agentSdk !== actual.agentSdk) {
    drift.push(`Agent SDK: measured ${measured.agentSdk}, installed ${actual.agentSdk}`);
  }
  if (measured.claudeCode !== actual.claudeCode) {
    drift.push(`Claude Code: measured ${measured.claudeCode}, installed ${actual.claudeCode}`);
  }
  return drift;
}

describe("the measured runtime", () => {
  test("is the one installed — re-run scripts/measure-claude-runtime.ts when this fails", () => {
    expect(runtimeDrift(MEASURED_RUNTIME, installed())).toEqual([]);
  });

  test("is read from the SDK copy the backend itself imports", () => {
    // The turn runner imports the SDK from the backend's source directory;
    // the guard resolves from the same place, so a second, hoisted copy of the
    // SDK cannot answer for the one the backend loads.
    const fromTurnRunner = Bun.resolveSync(
      "@anthropic-ai/claude-agent-sdk",
      dirname(join(BACKEND_SOURCE, "turn-runner.ts"))
    );
    expect(backendSdkEntry()).toBe(fromTurnRunner);
    expect(installed().agentSdk).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("a moved SDK and a moved CLI are each caught on their own", () => {
    const actual = installed();
    expect(runtimeDrift({ ...actual, agentSdk: "0.0.0" }, actual)).toEqual([
      `Agent SDK: measured 0.0.0, installed ${actual.agentSdk}`,
    ]);
    expect(runtimeDrift({ ...actual, claudeCode: "0.0.0" }, actual)).toEqual([
      `Claude Code: measured 0.0.0, installed ${actual.claudeCode}`,
    ]);
  });
});
