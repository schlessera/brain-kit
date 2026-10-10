/**
 * The changeset gate's own teeth.
 *
 * Two ways this gate could pass while the rule it enforces is broken, both
 * found by review rather than by use:
 *   - "shipped" was originally `src/` and `package.json` only, so a change to
 *     `skills/`, `migrations/`, `templates/` or `docs/` — all listed in a
 *     package's `files` and all in the published tarball — needed no changeset.
 *   - the diff was checked for changeset files rather than for ADDED ones, so a
 *     PR could edit or delete a changeset already on the base branch and count
 *     that as its own.
 */

import { describe, expect, test } from "bun:test";
import { contributedChangesets, judge, shippedRoots } from "../scripts/check-changeset.ts";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");

/** The real shipping rules, so the fixtures cannot drift from the manifests. */
const shipped = new Map<string, string[]>([
  ["core", shippedRoots(join(ROOT, "packages", "core"))],
  ["ui-server", shippedRoots(join(ROOT, "packages", "ui-server"))],
  ["module-finance", shippedRoots(join(ROOT, "packages", "module-finance"))],
]);

describe("changeset gate", () => {
  test("dist is never counted as shipped", () => {
    for (const roots of shipped.values()) expect(roots).not.toContain("dist");
  });

  test("source changes require a changeset", () => {
    const verdict = judge(["packages/core/src/index.ts"], [], shipped);
    expect(verdict.shipped).toEqual(["packages/core/src/index.ts"]);
    expect(verdict.ok).toBe(false);
  });

  test("shipped assets outside src require one too", () => {
    // The originally-shipped version of this gate missed every one of these.
    const files = [
      "packages/core/skills/sync/SKILL.md",
      "packages/ui-server/migrations/003_settings.sql",
      "packages/module-finance/templates/ledger.md",
    ];
    const verdict = judge(files, [], shipped);
    expect(verdict.shipped.sort()).toEqual([...files].sort());
    expect(verdict.ok).toBe(false);
  });

  test("a manifest change alone requires one", () => {
    // Dependencies, exports and engines are user-visible with no source moved.
    const verdict = judge(["packages/ui-server/package.json"], [], shipped);
    expect(verdict.ok).toBe(false);
  });

  test("tests, fixtures and repo files do not", () => {
    const verdict = judge(
      [
        "packages/core/tests/search.test.ts",
        "packages/core/fixtures/corpus/note.md",
        "tests/release-manifest.test.ts",
        "docs/hosting/README.md",
        ".github/workflows/ci.yml",
      ],
      [],
      shipped
    );
    expect(verdict.shipped).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  test("an added changeset satisfies it", () => {
    const verdict = judge(
      ["packages/core/src/index.ts"],
      [".changeset/brave-pandas-shout.md"],
      shipped
    );
    expect(verdict.ok).toBe(true);
  });

  test("editing someone else's pending changeset does not", () => {
    // The caller passes ADDED files only, so a modified changeset never
    // reaches `judge` — this pins the contract that makes that true.
    const verdict = judge(["packages/core/src/index.ts"], [], shipped);
    expect(verdict.added).toEqual([]);
    expect(verdict.ok).toBe(false);
  });

  test("a release PR is exempt", () => {
    // `changeset version` consumes the changesets and writes the CHANGELOGs,
    // so it legitimately touches every manifest while adding nothing.
    const verdict = judge(
      [
        "packages/core/package.json",
        "packages/core/CHANGELOG.md",
        ".changeset/brave-pandas-shout.md",
      ],
      [],
      shipped
    );
    expect(verdict.release).toBe(true);
    expect(verdict.ok).toBe(true);
  });
});

describe("contributedChangesets", () => {
  test("a changeset added and consumed within the range still counts", () => {
    // Endpoint diff shows nothing under .changeset (added, then consumed by
    // the release commit); only the commit walk sees the addition. This is
    // the 0.17.0 feature-plus-release push that failed the gate.
    const stub = (args: string[]): string[] =>
      args[0] === "log" ? [".changeset/my-feature.md"] : [];
    expect(contributedChangesets(stub, "base")).toEqual([
      ".changeset/my-feature.md",
    ]);
  });

  test("endpoint-only adds still count, and README never does", () => {
    const stub = (args: string[]): string[] =>
      args[0] === "diff"
        ? [".changeset/pending.md", ".changeset/README.md"]
        : [];
    expect(contributedChangesets(stub, "base")).toEqual([
      ".changeset/pending.md",
    ]);
  });
});
