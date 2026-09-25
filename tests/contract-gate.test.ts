/**
 * The contract gate's own teeth.
 *
 * The rule it enforces has two directions, and each was broken in practice
 * before the gate existed: commits that added contract surface to the doc
 * without the `CONTRACT:` prefix (146d5a96, 731282fa and four more since
 * 0.33.0), and the reverse, a prefix on a change the doc does not record,
 * which would make the prefix mean nothing to whoever audits by it.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { changedFiles, CONTRACT_DOC, judge, parseLabels } from "../scripts/check-contract-pr.ts";

const title = "CONTRACT: feat(core): add a field to brain stats --json";
const plainTitle = "feat(core): add a field to brain stats --json";
const docAndCode = [CONTRACT_DOC, "packages/core/src/cli/stats.ts"];
const codeOnly = ["packages/core/src/cli/stats.ts"];

describe("contract gate", () => {
  test("a doc change with the title and the label passes", () => {
    const verdict = judge(title, ["contract", "enhancement"], docAndCode);
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  test("a change that is not a contract change passes", () => {
    expect(judge(plainTitle, ["bug"], codeOnly).ok).toBe(true);
  });

  test("a doc change without the CONTRACT: title fails", () => {
    const verdict = judge(plainTitle, ["contract"], docAndCode);
    expect(verdict.problems).toEqual([
      `${CONTRACT_DOC} changed, but the title does not start with \`CONTRACT:\`.`,
    ]);
    expect(verdict.ok).toBe(false);
  });

  test("a doc change without the contract label fails", () => {
    const verdict = judge(title, [], docAndCode);
    expect(verdict.problems).toEqual([
      `${CONTRACT_DOC} changed, but the PR does not carry the \`contract\` label.`,
    ]);
    expect(verdict.ok).toBe(false);
  });

  test("a CONTRACT: title without a doc change fails", () => {
    const verdict = judge(title, [], codeOnly);
    expect(verdict.problems).toEqual([
      `The title starts with \`CONTRACT:\`, but ${CONTRACT_DOC} did not change.`,
    ]);
    expect(verdict.ok).toBe(false);
  });

  test("a contract label without a doc change fails", () => {
    const verdict = judge(plainTitle, ["contract"], codeOnly);
    expect(verdict.problems).toEqual([
      `The PR carries the \`contract\` label, but ${CONTRACT_DOC} did not change.`,
    ]);
    expect(verdict.ok).toBe(false);
  });

  test("the prefix is matched exactly, not anywhere in the title", () => {
    // A lowercase prefix or one after a conventional type is not what the
    // squash commit's subject is audited by.
    expect(judge("contract: feat(core): x", ["contract"], docAndCode).titled).toBe(false);
    expect(judge("feat(core)!: CONTRACT: x", ["contract"], docAndCode).titled).toBe(false);
  });

  test("another file named like the doc does not count", () => {
    const verdict = judge(plainTitle, [], ["docs/archive/integration-contract.md"]);
    expect(verdict.touchesDoc).toBe(false);
  });

  test("labels arrive as the JSON array the workflow passes", () => {
    expect(parseLabels('["contract","bug"]')).toEqual(["contract", "bug"]);
    expect(parseLabels("[]")).toEqual([]);
    expect(parseLabels(undefined)).toEqual([]);
    expect(() => parseLabels('"contract"')).toThrow("not a JSON array");
  });
});

describe("contract gate diff", () => {
  function git(cwd: string, ...args: string[]): string {
    const result = Bun.spawnSync(["git", ...args], { cwd });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
  }

  test("a doc edit that also landed on the base still counts as the PR's", () => {
    // The base moves on after the PR branches, and another PR lands the same
    // doc edit. The PR's own diff still has it. The synthetic merge commit a
    // `pull_request` checkout gives by default, diffed against the base, does
    // not: that is why the workflow checks out and passes the head SHA.
    const repo = mkdtempSync(join(tmpdir(), "contract-gate-"));
    try {
      const write = (file: string, text: string) => {
        mkdirSync(join(repo, file, ".."), { recursive: true });
        writeFileSync(join(repo, file), text);
      };
      git(repo, "init", "-q", "-b", "main");
      git(repo, "config", "user.email", "alex@example.com");
      git(repo, "config", "user.name", "Alex Example");
      write(CONTRACT_DOC, "v1\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "base");

      git(repo, "checkout", "-qb", "pr");
      write(CONTRACT_DOC, "v2\n");
      write("packages/core/src/stats.ts", "// pr\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "pr");
      const head = git(repo, "rev-parse", "HEAD");

      git(repo, "checkout", "-q", "main");
      write(CONTRACT_DOC, "v2\n");
      git(repo, "commit", "-qam", "another PR lands the same edit");
      git(repo, "checkout", "-q", "--detach", "main");
      git(repo, "merge", "-q", "--no-ff", "-m", "synthetic merge", head);
      const merge = git(repo, "rev-parse", "HEAD");

      const own = changedFiles(repo, "main", head);
      expect(own).toContain(CONTRACT_DOC);
      expect(judge("CONTRACT: feat(core): x", ["contract"], own!).ok).toBe(true);

      const synthetic = changedFiles(repo, "main", merge);
      expect(synthetic).toEqual(["packages/core/src/stats.ts"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a ref git cannot resolve is not an empty diff", () => {
    expect(changedFiles(process.cwd(), "no-such-ref", "HEAD")).toBeNull();
  });
});
