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
import { CONTRACT_DOC, judge, parseLabels } from "../scripts/check-contract-pr.ts";

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
