/**
 * Which boards `jobs scrape` runs, and what it says about a name it will not
 * run.
 *
 * A retired board is not an unknown one. `remoteineurope` was a real board
 * that an existing brain's `boards` config may still name, and "Unknown
 * source" would send its owner looking for a typo (#128).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandContext } from "@schlessera/brain";
import command, { selectSources } from "../src/cli";
import { configSchema, type JobsConfig } from "../src/module";
import { ALL_SOURCES, RETIRED_SOURCES, SOURCES } from "../src/types";

describe("selectSources", () => {
  test("a scrape naming a retired board is refused, and says it was retired", () => {
    const selection = selectSources({ positional: ["remoteineurope"], configured: [] });

    expect("error" in selection).toBe(true);
    const { error } = selection as { error: string };
    expect(error).toContain("remoteineurope");
    expect(error).toContain("retired");
    expect(error).not.toContain("Unknown source");
  });

  test("naming a retired board beside a live one is still refused", () => {
    // The user asked for it by name; running the rest without it would bury
    // the answer in a scrape summary.
    const selection = selectSources({ positional: ["remoteok", "remoteineurope"], configured: [] });

    expect("error" in selection).toBe(true);
    expect((selection as { error: string }).error).toContain("retired");
  });

  test("a boards config naming a retired board warns, and runs the rest", () => {
    // A scheduled scrape should not stop over a config that predates the
    // retirement; it should say so every run until the config is fixed.
    const selection = selectSources({ positional: [], configured: ["remoteineurope", "remoteok"] });

    expect("error" in selection).toBe(false);
    expect((selection as { sources: string[] }).sources).toEqual(["remoteok"]);
    expect(selection.warnings).toHaveLength(1);
    expect(selection.warnings[0]).toContain("remoteineurope");
    expect(selection.warnings[0]).toContain("retired");
    expect(selection.warnings[0]).toContain("boards");
  });

  test("a boards config naming only a retired board falls back to the defaults, and warns", () => {
    const selection = selectSources({ positional: [], configured: ["remoteineurope"] });

    expect((selection as { sources: string[] }).sources).toEqual([...SOURCES]);
    expect(selection.warnings[0]).toContain("retired");
  });

  test("an unknown name is still reported as unknown", () => {
    const selection = selectSources({ positional: ["nosuchboard"], configured: [] });

    expect((selection as { error: string }).error).toContain("Unknown sources: nosuchboard");
    expect(selection.warnings).toEqual([]);
  });

  test("--all and the defaults do not run a retired board", () => {
    const all = selectSources({ positional: [], configured: [], all: true }) as { sources: string[] };
    const defaults = selectSources({ positional: [], configured: [] }) as { sources: string[] };

    expect(Object.keys(RETIRED_SOURCES)).toContain("remoteineurope");
    for (const retired of Object.keys(RETIRED_SOURCES)) {
      expect(all.sources).not.toContain(retired);
      expect(defaults.sources).not.toContain(retired);
      expect(ALL_SOURCES as readonly string[]).not.toContain(retired);
    }
  });
});

describe("jobs scrape <retired board>", () => {
  let root: string;
  let stderr: string[];
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "jobs-retired-"));
    stderr = [];
    errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderr.push(args.join(" "));
    });
  });
  afterEach(() => {
    errorSpy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });

  test("exits non-zero with the retirement message, before any board is fetched", async () => {
    const ctx = {
      root,
      json: false,
      config: configSchema.parse({ criteria: "criteria.md" }),
      taxonomy: { dirForType: () => undefined },
    } as unknown as CommandContext<JobsConfig>;

    const code = await command.run(["scrape", "remoteineurope"], ctx);

    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("remoteineurope was retired");
    // A scrape opens (and so creates) the jobs database before any board is
    // fetched; a refusal never gets that far.
    expect(existsSync(join(root, "jobs.db"))).toBe(false);
  });
});
