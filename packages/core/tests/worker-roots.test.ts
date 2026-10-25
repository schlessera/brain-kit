import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { configurationRoot, loadUserConfig, resolveRoot } from "../src/lib/config.js";

const keys = ["BRAIN_ROOT", "BRAIN_WORKER_DATA_ROOT", "BRAIN_WORKER_CONFIG_ROOT"] as const;
let saved: (string | undefined)[];
let cwd: string, directory: string, data: string, config: string;
let restoreDiscovery: () => void;
beforeEach(() => {
  saved = keys.map(key => process.env[key]);
  for (const key of keys) delete process.env[key];
  cwd = process.cwd();
  directory = mkdtempSync(join(tmpdir(), "brain-worker-roots-"));
  data = join(directory, "data"); config = join(directory, "config");
  mkdirSync(data); mkdirSync(join(config, "voyages"), { recursive: true });
  writeFileSync(join(config, "brain.config.json"), JSON.stringify({ taxonomy: { canonical: { identity: "me/odysseus.md" } } }));
  writeFileSync(join(data, "brain.config.json"), "{}");
  process.env.BRAIN_WORKER_DATA_ROOT = data;
  process.env.BRAIN_WORKER_CONFIG_ROOT = config;
  // Temporary parent directories may themselves contain another brain.
  const exists = fs.existsSync;
  const discovery = spyOn(fs, "existsSync").mockImplementation(path => String(path).startsWith(directory + "/") && exists(path));
  restoreDiscovery = () => discovery.mockRestore();
});
afterEach(() => {
  restoreDiscovery();
  process.chdir(cwd);
  keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
  rmSync(directory, { recursive: true, force: true });
});

describe("hosted worker roots", () => {
  test("explicit config root maps to data while config loading stays frozen", async () => {
    expect(resolveRoot(config)).toBe(data);
    expect(configurationRoot(data)).toBe(config);
    expect((await loadUserConfig(data)).config?.taxonomy?.canonical?.identity).toBe("me/odysseus.md");
  });

  test("a pinned BRAIN_ROOT maps to the resolved data root", () => {
    process.env.BRAIN_ROOT = join(config, "voyages", "..");
    process.env.BRAIN_WORKER_CONFIG_ROOT = relative(cwd, config);
    process.env.BRAIN_WORKER_DATA_ROOT = relative(cwd, data);
    expect(resolveRoot()).toBe(data);
  });

  test.each(["config", "git", "cwd"])("walk-up via %s maps to data", marker => {
    if (marker !== "config") rmSync(join(config, "brain.config.json"));
    if (marker === "git") mkdirSync(join(config, ".git"));
    process.chdir(marker === "cwd" ? config : join(config, "voyages"));
    expect(resolveRoot()).toBe(data);
  });

  test("unrelated roots and incomplete worker environments preserve resolution", () => {
    process.env.BRAIN_ROOT = config;
    expect(resolveRoot(directory)).toBe(directory);
    expect(resolveRoot(data)).toBe(data);
    expect(configurationRoot(directory)).toBe(directory);
    for (const key of ["BRAIN_WORKER_CONFIG_ROOT", "BRAIN_WORKER_DATA_ROOT"] as const) {
      const value = process.env[key]; delete process.env[key];
      expect(resolveRoot(config)).toBe(config);
      expect(resolveRoot()).toBe(config);
      process.env[key] = value;
    }
  });

});
