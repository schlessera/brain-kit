/**
 * Each confirm pattern carries the effect it has, in words (#112).
 *
 * The phrase is what a person is told when a command stops for confirmation:
 * on the approval card, and — later, #54 — out loud, where the command itself
 * cannot be read. It completes "I want to …", and it becomes the `reason` of
 * the `command` approval the pattern raises.
 */

import { describe, expect, test } from "bun:test";

import {
  compileConfirmPatterns,
  DEFAULT_CONFIRM_BASH_PATTERNS,
} from "../src/server/confirm-patterns";
import { decideToolPermission } from "../src/server/permission-gate";

const FALLBACK = "This command matches a pattern configured to require confirmation.";

/** The default entry whose regex source is `source`, as shipped. */
function defaultPattern(source: string): { pattern: string; effect: string } {
  const entry = DEFAULT_CONFIRM_BASH_PATTERNS.find(
    (candidate) => typeof candidate === "object" && candidate.pattern === source
  );
  if (!entry || typeof entry !== "object") {
    throw new Error(`no default confirm pattern ${source} with an effect`);
  }
  return entry;
}

/** The reason a command approval raised against the shipped defaults gives. */
function reasonFor(command: string): string | undefined {
  const approval = decideToolPermission({
    toolName: "bash",
    shellToolName: "bash",
    input: { command },
    allowedTools: new Set(["bash"]),
    confirmPatterns: compileConfirmPatterns(DEFAULT_CONFIRM_BASH_PATTERNS, () => {
      throw new Error("a default pattern failed to compile");
    }),
  });
  // A per-use confirmation, never a grantable tool approval.
  expect(approval?.kind).toBe("command");
  return approval?.reason;
}

describe("the six default patterns, each with its effect", () => {
  test("brain archive", () => {
    const phrase = "archive a document, which takes it out of search and briefings";
    expect(defaultPattern(String.raw`\bbrain\s+archive\b`).effect).toBe(phrase);
    expect(reasonFor("brain archive notes/old.md")).toBe(phrase);
  });

  test("recursive rm", () => {
    const phrase = "delete a directory and everything inside it";
    expect(defaultPattern(String.raw`\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR]`).effect).toBe(phrase);
    expect(reasonFor("rm -rf notes/old")).toBe(phrase);
  });

  test("git push --force", () => {
    const phrase = "force-push, overwriting history on the remote";
    expect(defaultPattern(String.raw`\bgit\s+push\b.*--force`).effect).toBe(phrase);
    expect(reasonFor("git push --force origin main")).toBe(phrase);
  });

  test("git reset --hard", () => {
    const phrase = "discard every uncommitted change in the working tree";
    expect(defaultPattern(String.raw`\bgit\s+reset\b.*--hard`).effect).toBe(phrase);
    expect(reasonFor("git reset --hard HEAD~1")).toBe(phrase);
  });

  test("git clean -f", () => {
    const phrase = "delete untracked files from the working tree";
    expect(defaultPattern(String.raw`\bgit\s+clean\b.*-[a-zA-Z]*f`).effect).toBe(phrase);
    expect(reasonFor("git clean -fd")).toBe(phrase);
  });

  test("git checkout --", () => {
    const phrase = "discard changes to specific files";
    expect(defaultPattern(String.raw`\bgit\s+checkout\b.*\s--\s`).effect).toBe(phrase);
    expect(reasonFor("git checkout -- notes/a.md")).toBe(phrase);
  });

  test("no default pattern is left without an effect", () => {
    // A new default without a phrase is a defect, not a supported state
    // (docs/decisions/voice-permission.md): the fallback says nothing a
    // listener could act on.
    expect(DEFAULT_CONFIRM_BASH_PATTERNS.length).toBeGreaterThan(0);
    for (const entry of DEFAULT_CONFIRM_BASH_PATTERNS) {
      expect(typeof entry, JSON.stringify(entry)).toBe("object");
      expect((entry as { effect: string }).effect.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("a deployment's own patterns", () => {
  test("bare strings still compile, still match, and get the fallback sentence", () => {
    const invalid: string[] = [];
    const compiled = compileConfirmPatterns([String.raw`\bdeploy\s+prod\b`], (source) =>
      invalid.push(source)
    );
    expect(invalid).toEqual([]);
    expect(compiled).toHaveLength(1);
    expect(compiled[0]!.test("DEPLOY PROD now")).toBe(true);
    expect(
      decideToolPermission({
        toolName: "bash",
        shellToolName: "bash",
        input: { command: "deploy prod" },
        allowedTools: new Set(["bash"]),
        confirmPatterns: compiled,
      })
    ).toEqual({ kind: "command", reason: FALLBACK });
  });

  test("the new form carries its effect into the approval", () => {
    const compiled = compileConfirmPatterns(
      [{ pattern: String.raw`\bdeploy\s+prod\b`, effect: "ship this build to production" }],
      () => {}
    );
    expect(
      decideToolPermission({
        toolName: "bash",
        shellToolName: "bash",
        input: { command: "deploy prod" },
        allowedTools: new Set(["bash"]),
        confirmPatterns: compiled,
      })
    ).toEqual({ kind: "command", reason: "ship this build to production" });
  });

  test("the first matching pattern names the effect", () => {
    const compiled = compileConfirmPatterns(
      [String.raw`\bdeploy\b`, { pattern: String.raw`\bprod\b`, effect: "touch production" }],
      () => {}
    );
    // Order is the deployment's: a bare string first means the fallback.
    expect(
      decideToolPermission({
        toolName: "bash",
        shellToolName: "bash",
        input: { command: "deploy prod" },
        allowedTools: new Set(["bash"]),
        confirmPatterns: compiled,
      })?.reason
    ).toBe(FALLBACK);
  });

  test("an invalid pattern in the new form is skipped and reported, not fatal", () => {
    const invalid: Array<[string, string]> = [];
    const compiled = compileConfirmPatterns(
      [
        { pattern: "(unclosed", effect: "never shown" },
        { pattern: String.raw`\bok\b`, effect: "fine" },
      ],
      (source, message) => invalid.push([source, message])
    );
    expect(invalid.map(([source]) => source)).toEqual(["(unclosed"]);
    expect(compiled).toHaveLength(1);
    expect(compiled[0]!.test("ok")).toBe(true);
    expect(
      decideToolPermission({
        toolName: "bash",
        shellToolName: "bash",
        input: { command: "ok" },
        allowedTools: new Set(["bash"]),
        confirmPatterns: compiled,
      })
    ).toEqual({ kind: "command", reason: "fine" });
    expect(compiled.some((pattern) => pattern.test("git push --force"))).toBe(false);
  });

  test("a nonempty all-invalid list throws with each invalid source and repair guidance", () => {
    const invalid: Array<[string, string]> = [];
    let failure: Error | undefined;
    expect(() => {
      try {
        compileConfirmPatterns(["(", { pattern: "[", effect: "never shown" }], (source, message) =>
          invalid.push([source, message])
        );
      } catch (error) {
        failure = error as Error;
        throw error;
      }
    }).toThrow(/confirmBashPatterns.*BRAIN_UI_CONFIRM_BASH.*no valid.*repair.*\[\]/i);
    expect(invalid.map(([source]) => source)).toEqual(["(", "["]);
    for (const [source, message] of invalid) {
      expect(message.length).toBeGreaterThan(0);
      expect(failure!.message).toContain(`${JSON.stringify(source)}: ${message}`);
    }
  });

  test("an explicit empty list still disables confirmation", () => {
    const invalid: string[] = [];
    expect(compileConfirmPatterns([], (source) => invalid.push(source))).toEqual([]);
    expect(invalid).toEqual([]);
  });

  test("an entry with no pattern string is skipped and reported rather than matching everything", () => {
    // `new RegExp(undefined)` is the empty pattern, which matches every
    // command: a malformed entry must fail to "never matches", not "always".
    const invalid: string[] = [];
    const compiled = compileConfirmPatterns(
      [
        { effect: "no pattern" } as never,
        { pattern: 42, effect: "not a string" } as never,
        String.raw`\bok\b`,
      ],
      (source) => invalid.push(source)
    );
    expect(compiled).toHaveLength(1);
    expect(compiled[0]!.test("ok")).toBe(true);
    expect(compiled[0]!.test("git status")).toBe(false);
    expect(invalid).toHaveLength(2);
  });

  test("a nonempty list of malformed objects also throws after reporting them", () => {
    const invalid: string[] = [];
    expect(() =>
      compileConfirmPatterns(
        [{ effect: "no pattern" } as never, { pattern: 42 } as never],
        (source) => invalid.push(source)
      )
    ).toThrow(/no valid/i);
    expect(invalid).toEqual(["undefined", "42"]);
  });
});
