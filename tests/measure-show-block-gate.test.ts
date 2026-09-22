/**
 * The measurement harness's counting rules, asserted.
 *
 * `scripts/measure-show-block-server.ts` produces a number that goes into a
 * decision record, and a counting hole there is a confident wrong number
 * rather than a visible failure. Two of its rules are pure and cheap to pin,
 * and both were wrong at some point on the way to the recorded number. The
 * table count began as a regex over delimiter rows: it required the outer
 * pipes GFM does not, missed a single-column table, and counted a table
 * printed inside a fenced code block, which draws nothing. The escape rule
 * began as a string prefix, which puts `/home/x/brain-backup` inside
 * `/home/x/brain`.
 *
 * The live half needs the network and a key, so it is not tested here and
 * never runs in CI.
 */

import { describe, expect, test } from "bun:test";

import { countMarkdownTables, escapesBrain } from "../scripts/measure-show-block-server.ts";

const tables = countMarkdownTables;

describe("the markdown-table matcher", () => {
  test("counts a table written with outer pipes", () => {
    expect(tables("| a | b |\n| --- | --- |\n| 1 | 2 |")).toBe(1);
  });

  test("counts a table written without them, which GFM allows", () => {
    expect(tables("a | b\n--- | ---\n1 | 2")).toBe(1);
  });

  test("counts an alignment row", () => {
    expect(tables("| a | b |\n|:--|--:|\n| 1 | 2 |")).toBe(1);
  });

  test("counts each table in an answer that has two", () => {
    expect(tables("| a | b |\n| --- | --- |\n\n| c | d |\n| --- | --- |")).toBe(2);
  });

  test("counts a single-column table, whose delimiter row has no interior pipe", () => {
    expect(tables("| Step |\n| --- |\n| Build |")).toBe(1);
  });

  test("does not count prose, or a lone pipe line with no delimiter row", () => {
    expect(tables("no table here\njust prose")).toBe(0);
    expect(tables("a | b\nprose")).toBe(0);
  });

  test("does not count a table inside a fenced code block, which draws nothing", () => {
    expect(tables("```\n| a | b |\n| --- | --- |\n```")).toBe(0);
  });
});

describe("the brain-escape rule", () => {
  const brain = "/tmp/measure/brain";

  test("flags a home path outside the brain", () => {
    expect(escapesBrain([{ command: "ls /home/someone/brain" }], brain)).toBe(true);
  });

  test("flags a tilde path", () => {
    expect(escapesBrain([{ command: "cat ~/notes/today.md" }], brain)).toBe(true);
  });

  test("leaves a path inside the brain alone", () => {
    expect(escapesBrain([{ path: `${brain}/notes/a.md` }], brain)).toBe(false);
  });

  test("leaves a brain that is itself under a home directory alone", () => {
    const home = "/home/someone/brain";
    expect(escapesBrain([{ path: `${home}/notes/a.md` }], home)).toBe(false);
    expect(escapesBrain([{ path: home }], home)).toBe(false);
    expect(escapesBrain([{ path: "/home/someone/other/a.md" }], home)).toBe(true);
  });

  test("a sibling that merely shares the brain's name prefix is outside it", () => {
    const home = "/home/someone/brain";
    expect(escapesBrain([{ path: "/home/someone/brain-backup/notes.md" }], home)).toBe(true);
  });

  test("a traversal back out of the brain is outside it", () => {
    const home = "/home/someone/brain";
    expect(escapesBrain([{ command: `cat ${home}/../private/notes.md` }], home)).toBe(true);
  });

  test("reads every argument, not only the first", () => {
    expect(
      escapesBrain([{ path: `${brain}/a.md` }, { command: "ls /home/someone" }], brain)
    ).toBe(true);
  });
});
