import { describe, expect, test } from "bun:test";

import { computeJson, parseArgs, scanCliArgs } from "../src/cli/io";

describe("parseArgs end-of-options", () => {
  test("preserves a --prefixed positional on the validated path", () => {
    expect(parseArgs(["--", "--weird query"])).toEqual({
      args: ["--weird query"],
      flags: {},
    });
  });

  test("preserves a --prefixed positional on the unvalidated path", () => {
    expect(parseArgs(["--", "--module-value"], false)).toEqual({
      args: ["--module-value"],
      flags: {},
    });
  });

  test("drops a trailing separator", () => {
    expect(parseArgs(["--"])).toEqual({ args: [], flags: {} });
  });

  test("treats a second separator as an ordinary positional", () => {
    expect(parseArgs(["--", "--"])).toEqual({ args: ["--"], flags: {} });
  });

  test("still parses flags before the separator", () => {
    expect(parseArgs(["--type", "note", "--include-archived", "--", "--query"])).toEqual({
      args: ["--query"],
      flags: { type: "note", "include-archived": true },
    });
  });
});

describe("global CLI scans", () => {
  test("computeJson ignores output flags after the separator", () => {
    expect(computeJson(["--human", "--", "--json"])).toBe(false);
    expect(computeJson(["--json", "--", "--human"])).toBe(true);
  });

  test("help and command detection ignore arguments after the separator", () => {
    expect(scanCliArgs(["search", "--", "--help"])).toEqual({
      command: "search",
      wantsHelp: false,
    });
    expect(scanCliArgs(["--", "search"])).toEqual({
      command: undefined,
      wantsHelp: false,
    });
  });
});
