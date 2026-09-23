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
import { ALL_SOURCES, DISABLED_BY_DEFAULT, RETIRED_SOURCES, SOURCES } from "../src/types";

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

    // Positive as well as negative: a selection that returned nothing would
    // pass every `not.toContain` below.
    expect(all.sources).toEqual([...ALL_SOURCES]);
    expect(defaults.sources).toEqual([...SOURCES]);
    expect(Object.keys(RETIRED_SOURCES)).toContain("remoteineurope");
    for (const retired of Object.keys(RETIRED_SOURCES)) {
      expect(all.sources).not.toContain(retired);
      expect(defaults.sources).not.toContain(retired);
      expect(ALL_SOURCES as readonly string[]).not.toContain(retired);
    }
  });
});

describe("the default boards and the disabled ones", () => {
  test("every board is either enabled by default or disabled with a reason, never both (#130)", () => {
    const enabled = new Set<string>(SOURCES);
    const disabled = new Set(Object.keys(DISABLED_BY_DEFAULT));

    for (const source of ALL_SOURCES) {
      expect(`${source}: ${enabled.has(source) !== disabled.has(source)}`).toBe(`${source}: true`);
    }
    for (const source of disabled) expect(ALL_SOURCES as readonly string[]).toContain(source);
    for (const reason of Object.values(DISABLED_BY_DEFAULT)) expect(reason.length).toBeGreaterThan(0);
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

    // Both transports `ScrapeClient` has: `fetch`, and curl through
    // `Bun.spawn` for a proxy. A caller that swallows their error would get
    // past them unseen, so only the call counts can tell, and those are read
    // BEFORE `mockRestore`, which clears them. The browser path has no seam
    // here; it only runs inside `runScrape`, which the `jobs.db` check below
    // rules out.
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() =>
      Promise.reject(new Error("a refused scrape must not reach the network"))) as unknown as typeof fetch);
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((() => {
      throw new Error("a refused scrape must not start a subprocess");
    }) as unknown as typeof Bun.spawn);
    let code: number | void;
    try {
      code = await command.run(["scrape", "remoteineurope"], ctx);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      spawnSpy.mockRestore();
    }

    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("remoteineurope was retired");
    // A scrape opens (and so creates) the jobs database before any board is
    // fetched; a refusal never gets that far.
    expect(existsSync(join(root, "jobs.db"))).toBe(false);
  });
});
