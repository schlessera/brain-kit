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
import { resolve } from "node:path";

import {
  assertMeasurableBrainPath,
  countMarkdownTables,
  escapesBrain,
} from "../scripts/measure-show-block-server.ts";

function tables(...parts: string[]): number {
  return countMarkdownTables(...parts);
}

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

  test("counts a table the reader saw in its own part, not the joined text", () => {
    // A tool call between the prose and the table makes them two parts.
    // Joined, the header row becomes the tail of a paragraph and the table
    // vanishes; the reader saw one.
    const prose = "Let me check.";
    const table = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    expect(tables(prose, table)).toBe(1);
    expect(tables(prose + table)).toBe(0);
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

  test("normalises the brain side, so a redundant segment is still the brain", () => {
    expect(escapesBrain([{ path: "/home/someone/brain/notes/a.md" }], "/home/someone/brain/.")).toBe(
      false
    );
  });

  test("resolves a relative brain against the working directory", () => {
    // Only bites when the working directory is itself under a home
    // directory, which is where the harness is usually run; the answer is
    // the same either way, so the assertion is unconditional.
    const relative = "fixtures/brain";
    expect(escapesBrain([{ path: `${resolve(relative)}/notes/a.md` }], relative)).toBe(false);
    expect(escapesBrain([{ path: "/home/someone/elsewhere/a.md" }], relative)).toBe(true);
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

  test("a brain whose name carries a non-ASCII character is still itself", () => {
    const accented = "/home/someone/cerveau-privé";
    expect(escapesBrain([{ path: `${accented}/notes/a.md` }], accented)).toBe(false);
    expect(escapesBrain([{ path: "/home/someone/autre/a.md" }], accented)).toBe(true);
  });

  test("a sibling whose extra character is non-ASCII is still a sibling", () => {
    const home = "/home/someone/brain";
    expect(escapesBrain([{ path: "/home/someone/brainé/notes.md" }], home)).toBe(true);
    expect(escapesBrain([{ path: "/home/someone/brain2/notes.md" }], home)).toBe(true);
  });

  test("a brain path with whitespace is refused rather than judged", () => {
    // `<brain> copy/notes.md` and `find <brain> -type f` are the same string
    // with opposite answers, and the blob cannot tell them apart.
    expect(() => assertMeasurableBrainPath("/home/someone/brain copy")).toThrow(/whitespace/);
    expect(() => assertMeasurableBrainPath("/home/someone/brain")).not.toThrow();
  });

  test("a quoted traversal out of the brain is outside it", () => {
    const home = "/home/someone/brain";
    expect(escapesBrain([{ command: `ls '${home}/..'` }], home)).toBe(true);
    expect(escapesBrain([{ command: `ls "${home}/../private"` }], home)).toBe(true);
  });

  test("the brain named as one argument of a shell command is not an escape", () => {
    const home = "/home/someone/brain";
    expect(escapesBrain([{ command: `find ${home} -type f -name '*.md'` }], home)).toBe(false);
    expect(escapesBrain([{ command: `ls '${home}'` }], home)).toBe(false);
    expect(escapesBrain([{ command: `cd ${home} && git log` }], home)).toBe(false);
  });

  test("a traversal back out of the brain is outside it", () => {
    const home = "/home/someone/brain";
    expect(escapesBrain([{ command: `cat ${home}/../private/notes.md` }], home)).toBe(true);
  });

  test("a traversal ended by a shell separator is still a traversal", () => {
    const home = "/home/someone/brain";
    expect(escapesBrain([{ command: `cd ${home}/..; ls` }], home)).toBe(true);
    expect(escapesBrain([{ command: `cd ${home}/..&&ls` }], home)).toBe(true);
    expect(escapesBrain([{ command: `cat ${home}/..|head` }], home)).toBe(true);
    // The brain itself, ended the same way, is not.
    expect(escapesBrain([{ command: `cd ${home}; ls` }], home)).toBe(false);
  });

  test("reads every argument, not only the first", () => {
    expect(
      escapesBrain([{ path: `${brain}/a.md` }, { command: "ls /home/someone" }], brain)
    ).toBe(true);
  });
});
