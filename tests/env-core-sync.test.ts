/**
 * env-core sync gate — the shared half of the env chokepoint is a COPY, and
 * this test is what makes a copy safe.
 *
 * Every package with an env chokepoint (`src/config/env.ts`) carries the same
 * `src/config/env-core.ts`: the descriptor contract (EnvVarSpec /
 * DynamicEnvReadSpec), `readEnvVar`, and the boolean helpers `envFlag` /
 * `envPresent`. There is deliberately NO shared package for it — the repo
 * takes a seam only where a second implementation is plausible, and a
 * dependency edge for four fields and three functions would churn the release
 * manifest for nothing. The single-source-of-truth guarantee comes from HERE
 * instead: `packages/core/src/config/env-core.ts` is the canonical copy, and
 * every other copy must be byte-identical to it.
 *
 * On failure: edit one copy, copy the file verbatim to every
 * `packages/*\/src/config/env-core.ts`, and rerun — see the file's header.
 *
 * The behaviour tests at the bottom run against the canonical copy only;
 * byte-equality extends the proof to every other copy.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { envFlag, envPresent, readEnvVar } from "../packages/core/src/config/env-core.ts";

const ROOT = resolve(import.meta.dir, "..");
const PACKAGES_DIR = join(ROOT, "packages");
const CANONICAL_DIR = "core";
const CANONICAL = join(PACKAGES_DIR, CANONICAL_DIR, "src", "config", "env-core.ts");

function packageDirs(): string[] {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const withChokepoint = packageDirs().filter((dir) =>
  existsSync(join(PACKAGES_DIR, dir, "src", "config", "env.ts"))
);

describe("env-core sync", () => {
  test("the canonical copy exists and states the sync rule in its header", () => {
    expect(existsSync(CANONICAL)).toBe(true);
    const header = readFileSync(CANONICAL, "utf8");
    // The header is the update instruction the failure messages point at; a
    // copy that loses it strands the next editor.
    expect(header).toContain("SYNC-ENFORCED");
    expect(header).toContain("tests/env-core-sync.test.ts");
  });

  test("every package with an env chokepoint carries the shared copy", () => {
    const missing = withChokepoint.filter(
      (dir) => !existsSync(join(PACKAGES_DIR, dir, "src", "config", "env-core.ts"))
    );
    expect(
      missing,
      "these packages have src/config/env.ts but no src/config/env-core.ts — " +
        "copy packages/core/src/config/env-core.ts in verbatim"
    ).toEqual([]);
  });

  test("no package carries the copy without a chokepoint to serve", () => {
    // env-core.ts only exists to back an env.ts next to it; an orphan copy is
    // dead weight that would still be sync-checked forever.
    const orphans = packageDirs().filter(
      (dir) =>
        !withChokepoint.includes(dir) &&
        existsSync(join(PACKAGES_DIR, dir, "src", "config", "env-core.ts"))
    );
    expect(orphans).toEqual([]);
  });

  const canonicalText = readFileSync(CANONICAL, "utf8");
  for (const dir of withChokepoint.filter((d) => d !== CANONICAL_DIR)) {
    test(`packages/${dir}/src/config/env-core.ts is byte-identical to the canonical copy`, () => {
      const copy = join(PACKAGES_DIR, dir, "src", "config", "env-core.ts");
      expect(
        readFileSync(copy, "utf8"),
        `packages/${dir}/src/config/env-core.ts has drifted from ` +
          "packages/core/src/config/env-core.ts — edit one, copy to all, see header"
      ).toBe(canonicalText);
    });
  }
});

describe("envFlag", () => {
  test("truthy tokens: 1/true/on/yes, case-insensitive, trimmed", () => {
    for (const raw of ["1", "true", "on", "yes", "TRUE", "Yes", " on ", "\ttrue\n"]) {
      expect(envFlag(raw, false), `expected ${JSON.stringify(raw)} to be truthy`).toBe(true);
      expect(envFlag(raw, true), `expected ${JSON.stringify(raw)} to be truthy`).toBe(true);
    }
  });

  test("falsy tokens: 0/false/off/no, case-insensitive, trimmed", () => {
    for (const raw of ["0", "false", "off", "no", "OFF", "No", " false ", "\t0\n"]) {
      expect(envFlag(raw, true), `expected ${JSON.stringify(raw)} to be falsy`).toBe(false);
      expect(envFlag(raw, false), `expected ${JSON.stringify(raw)} to be falsy`).toBe(false);
    }
  });

  test("unset returns the default, in both directions", () => {
    expect(envFlag(undefined, true)).toBe(true);
    expect(envFlag(undefined, false)).toBe(false);
  });

  test("empty and unrecognised tokens return the default, never a silent flip", () => {
    for (const raw of ["", "  ", "banana", "2", "enabled", "ja", "y", "n", "on!"]) {
      expect(envFlag(raw, true), `expected ${JSON.stringify(raw)} to fall back`).toBe(true);
      expect(envFlag(raw, false), `expected ${JSON.stringify(raw)} to fall back`).toBe(false);
    }
  });
});

describe("envPresent", () => {
  test("any non-empty value counts as set — the NO_COLOR convention", () => {
    expect(envPresent("1")).toBe(true);
    expect(envPresent("0")).toBe(true); // NO_COLOR=0 still disables color
    expect(envPresent("anything")).toBe(true);
    expect(envPresent(" ")).toBe(true);
  });

  test("unset and empty are not present", () => {
    expect(envPresent(undefined)).toBe(false);
    expect(envPresent("")).toBe(false);
  });
});

describe("readEnvVar", () => {
  test("reads a named variable from the given environment", () => {
    expect(readEnvVar("SOME_KEY", { SOME_KEY: "v" })).toBe("v");
    expect(readEnvVar("SOME_KEY", {})).toBeUndefined();
  });
});
