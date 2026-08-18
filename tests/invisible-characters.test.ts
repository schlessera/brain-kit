import { describe, expect, test } from "bun:test";
import { resolve } from "path";

import { scanRepo, scanText } from "../scripts/check-invisibles";

// Built numerically so this test file never contains the characters it asserts
// on — otherwise the repo-wide scan below would flag the test itself.
const NUL = String.fromCharCode(0x00);
const ZWSP = String.fromCharCode(0x200b);
const NBSP = String.fromCharCode(0x00a0);
const BOM = String.fromCharCode(0xfeff);

describe("scanText", () => {
  test("allows tab, newline and carriage return", () => {
    expect(scanText("a.ts", "const a = 1;\n\tconst b = 2;\r\n")).toEqual([]);
  });

  test("allows ordinary unicode", () => {
    expect(scanText("a.ts", 'const s = "héllo — wörld ✓";\n')).toEqual([]);
  });

  test("flags a raw NUL, the byte that makes grep skip a file", () => {
    const findings = scanText("a.ts", `const k = "x${NUL}y";\n`);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.name).toBe("NUL");
    expect(findings[0]!.line).toBe(1);
  });

  test("flags zero-width and non-breaking invisibles", () => {
    const names = scanText("a.ts", `a${ZWSP}b${NBSP}c${BOM}\n`).map((f) => f.name);
    expect(names).toEqual(["ZERO WIDTH SPACE", "NO-BREAK SPACE", "BYTE ORDER MARK"]);
  });

  test("reports the line the character is actually on", () => {
    const findings = scanText("a.ts", `one\ntwo\nthr${NUL}ee\n`);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.line).toBe(3);
    expect(findings[0]!.column).toBe(4);
  });

  test("escaping a character satisfies the check while preserving its value", () => {
    // What the fix looks like: the source spells the escape, the runtime string
    // still contains the character.
    const escapedSource = 'const k = "x\\u0000y";\n';
    expect(scanText("a.ts", escapedSource)).toEqual([]);
    // ...and the escape is the same character, so nothing downstream moves.
    expect(JSON.parse('"x\\u0000y"')).toBe(["x", NUL, "y"].join(""));
  });
});

describe("repository", () => {
  test("no tracked file contains raw control or invisible characters", () => {
    const findings = scanRepo(resolve(import.meta.dir, ".."));
    const report = findings
      .map((f) => `${f.file}:${f.line}:${f.column} ${f.name}`)
      .join("\n");
    expect(report).toBe("");
  });
});
