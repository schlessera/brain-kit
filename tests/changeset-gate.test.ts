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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

/** A real synthetic merge: main retains pending work while the release advances source. */
function mergeHistory(mode: "consumed" | "edited" | "absent", check: (git: (args: string[]) => string[], base: string) => void) {
  const cwd = mkdtempSync(join(tmpdir(), "odysseus-changeset-history-"));
  const git = (args: string[]) => {
    const child = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
      cwd, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_DATE: "2026-07-12T00:00:00Z", GIT_COMMITTER_DATE: "2026-07-12T00:00:00Z" }, stdout: "pipe", stderr: "pipe",
    });
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    return child.stdout.toString().trim().split("\n").filter(Boolean);
  };
  const commit = (message: string) => { git(["add", "."]); git(["commit", "-qm", message]); };
  const changeset = "---\n\"@schlessera/brain\": patch\n---\n\nOdysseus prepares the raft.\n";
  try {
    git(["init", "-q", "--template=", "-b", "main"]);
    git(["config", "user.name", "Odysseus"]); git(["config", "user.email", "odysseus@example.invalid"]);
    mkdirSync(join(cwd, ".changeset")); mkdirSync(join(cwd, "packages/core/src"), { recursive: true });
    writeFileSync(join(cwd, ".changeset/inherited.md"), changeset);
    writeFileSync(join(cwd, "packages/core/src/index.ts"), 'export const voyage = "outbound";\n'); commit("Begin voyage");
    git(["checkout", "-qb", "release"]);
    writeFileSync(join(cwd, "packages/core/src/index.ts"), 'export const voyage = "Ithaca";\n');
    if (mode === "consumed") writeFileSync(join(cwd, ".changeset/raft-repair.md"), changeset);
    if (mode === "edited") writeFileSync(join(cwd, ".changeset/inherited.md"), changeset + "Athena checks the rope.\n");
    commit("Repair raft");
    if (mode === "consumed") {
      rmSync(join(cwd, ".changeset/raft-repair.md"));
      writeFileSync(join(cwd, "packages/core/CHANGELOG.md"), "## 0.43.1\n\nOdysseus prepares the raft.\n"); commit("Version repair");
    }
    git(["checkout", "-q", "main"]);
    writeFileSync(join(cwd, ".changeset/future.md"), changeset); commit("Plan next voyage");
    const base = git(["rev-parse", "HEAD"])[0]!;
    git(["merge", "--no-ff", "--no-edit", "release"]);
    expect(git(["show", "-s", "--format=%P", "HEAD"])[0]!.split(" ")).toHaveLength(2);
    check(git, base);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

test("a consumed release-side changeset contributes through a real merge", () => {
  mergeHistory("consumed", (git, base) => {
    const added = contributedChangesets(git, base);
    expect(added, "MERGED_CONSUMED_CHANGESET_CONTRIBUTED").toEqual([".changeset/raft-repair.md"]);
    const verdict = judge(git(["diff", "--name-only", `${base}...HEAD`]), added, shipped);
    expect(verdict.release).toBe(false);
    expect(verdict.ok).toBe(true);
  });
});

for (const mode of ["edited", "absent"] as const) test(`${mode} merge-side changesets do not excuse an uncontributed source change`, () => {
  mergeHistory(mode, (git, base) => {
    const added = contributedChangesets(git, base);
    expect(added, "MERGED_EXISTING_CHANGESET_NOT_CONTRIBUTED").toEqual([]);
    expect(judge(git(["diff", "--name-only", `${base}...HEAD`]), added, shipped).ok, "MERGED_UNCONTRIBUTED_SOURCE_REFUSED").toBe(false);
  });
});
