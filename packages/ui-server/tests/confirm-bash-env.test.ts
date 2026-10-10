/**
 * BRAIN_UI_CONFIRM_BASH carries the same two shapes the backends accept
 * (#112): bare regex sources, and `{ pattern, effect }` objects whose effect
 * the approval card shows. An entry the parser cannot use must never turn the
 * confirmation off by accident — the safe direction is the shipped defaults.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { registryBrainFixture } from "./helpers/registry-brain";

let brain: ReturnType<typeof registryBrainFixture>;
beforeEach(() => { brain = registryBrainFixture(); });
afterEach(() => brain.cleanup());

import { resolveServerConfig } from "../src/config/env";
import { createBackendRegistry } from "../src/agent/backend";

const patternsFrom = (value: string) =>
  resolveServerConfig({ BRAIN_UI_CONFIRM_BASH: value }).agent.confirmBashPatterns;

describe("BRAIN_UI_CONFIRM_BASH", () => {
  test("bare sources pass through as before", () => {
    expect(patternsFrom(String.raw`["\\bdeploy\\b"]`)).toEqual([String.raw`\bdeploy\b`]);
  });

  test("the object form keeps its effect", () => {
    expect(
      patternsFrom(JSON.stringify([{ pattern: String.raw`\bdeploy\b`, effect: "ship to production" }]))
    ).toEqual([{ pattern: String.raw`\bdeploy\b`, effect: "ship to production" }]);
  });

  test("the two forms mix", () => {
    expect(
      patternsFrom(JSON.stringify([String.raw`\bfoo\b`, { pattern: String.raw`\bbar\b`, effect: "bar it" }]))
    ).toEqual([String.raw`\bfoo\b`, { pattern: String.raw`\bbar\b`, effect: "bar it" }]);
  });

  test("an explicit empty array still disables the confirmation", () => {
    expect(patternsFrom("[]")).toEqual([]);
  });

  test("entries it cannot use are dropped, and all-unusable means the defaults, not none", () => {
    expect(patternsFrom(JSON.stringify([{ effect: "no pattern" }, 42, null]))).toBeNull();
    expect(patternsFrom(JSON.stringify([{ effect: "no pattern" }, String.raw`\bok\b`]))).toEqual([
      String.raw`\bok\b`,
    ]);
  });
});

describe("BRAIN_UI_CONFIRM_BASH through real backend initialization", () => {
  for (const backendId of ["claude", "pi"]) {
    const registryFor = (value?: string) => {
      const config = resolveServerConfig({
        NODE_ENV: "test", BRAIN_PATH: brain.root, AGENT_BACKEND: backendId, BRAIN_UI_CONFIRM_BASH: value,
      });
      return createBackendRegistry({
        brainPath: config.brainPath, agent: config.agent,
        log: { emit: () => {}, enabled: () => false },
      });
    };

    test(`${backendId}: an all-invalid regex list rejects initialization`, async () => {
      const registry = registryFor('["("]');
      await expect(registry.getBackends()).rejects.toThrow(/confirmBashPatterns.*BRAIN_UI_CONFIRM_BASH.*no valid/);
    });

    for (const [name, value] of [
      ["missing", undefined],
      ["explicit empty", "[]"],
      ["mixed valid/invalid", JSON.stringify(["(", { pattern: "deploy", effect: "ship a build" }])],
    ] as const) {
      test(`${backendId}: ${name} configuration initializes`, async () => {
        expect((await registryFor(value).getBackends()).map((backend) => backend.id)).toEqual([backendId]);
      });
    }
  }
});
