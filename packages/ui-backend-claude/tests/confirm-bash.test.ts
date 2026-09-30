/**
 * Bash confirmation patterns.
 *
 * The hole these close: `Bash` is auto-allowed, and the SDK never consults
 * `canUseTool` for an allowlisted tool, so `brain archive x.md` typed into
 * Bash ran with no card while the identical operation through `brain_archive`
 * raised one. The gated path was the one the brain repo's own CLAUDE.md steers
 * away from, so in practice the confirmation almost never fired.
 *
 * These assert the matching, not the SDK plumbing: what must be true is that
 * the shipped set catches the commands it claims to and leaves ordinary work
 * alone. A pattern set that fires on `git status` would be turned off within a
 * day, and then it protects nothing.
 */
import { describe, expect, test } from "bun:test";
import type { Options, query } from "@anthropic-ai/claude-agent-sdk";

import { createClaudeBackend, DEFAULT_CONFIRM_BASH_PATTERNS } from "../src/backend.js";
import { MUTATING_TOOL_MATCHER } from "../src/tool-policy.js";

const patterns = DEFAULT_CONFIRM_BASH_PATTERNS.map((p) => new RegExp(p.pattern, "i"));
const confirms = (command: string) => patterns.some((re) => re.test(command));

describe("commands that must raise a card", () => {
  test("brain archive, in the forms an agent actually writes", () => {
    // The reported case: "Archive X.md" became a Bash call, not the MCP tool.
    expect(confirms("brain archive notes/thing.md")).toBe(true);
    expect(confirms("bun node_modules/.bin/brain archive notes/thing.md")).toBe(true);
    expect(confirms("cd /data/brain && brain archive a.md")).toBe(true);
    expect(confirms("brain   archive   a.md")).toBe(true);
    expect(confirms("BRAIN_ROOT=/x brain archive a.md")).toBe(true);
  });

  test("recursive deletes, in their common spellings", () => {
    expect(confirms("rm -rf /data/brain/notes")).toBe(true);
    expect(confirms("rm -fr build")).toBe(true);
    expect(confirms("rm -r notes/old")).toBe(true);
    expect(confirms("rm -f -r notes/old")).toBe(true);
    expect(confirms("rm -R notes/old")).toBe(true);
  });

  test("history rewrites and working-tree discards", () => {
    expect(confirms("git push --force origin main")).toBe(true);
    expect(confirms("git push origin main --force-with-lease")).toBe(true);
    expect(confirms("git reset --hard HEAD~3")).toBe(true);
    expect(confirms("git clean -fd")).toBe(true);
    expect(confirms("git checkout -- notes/thing.md")).toBe(true);
  });
});

describe("commands that must NOT raise a card", () => {
  test("ordinary read-only work stays silent", () => {
    // The bar: if this list ever fires on everyday commands, someone disables
    // the whole mechanism and it stops protecting anything.
    for (const command of [
      "brain search 'foo'",
      "brain list --type note",
      "brain sync",
      "brain index --force",
      "git status",
      "git log --oneline -5",
      "git diff",
      "git push origin main",
      "git checkout main",
      "ls -la notes",
      "cat notes/thing.md",
      "rm notes/single-file.md",
      "grep -r pattern notes",
    ]) {
      expect(confirms(command), `${command} should not need confirmation`).toBe(false);
    }
  });

  test("a plain non-recursive rm is not confirmed", () => {
    // Deliberate: a single-file delete inside a git repo is ordinary work, and
    // confirming it would be the noise that gets the feature switched off.
    expect(confirms("rm notes/a.md")).toBe(false);
    expect(confirms("rm -f notes/a.md")).toBe(false);
  });

  test("the word archive alone is not enough", () => {
    expect(confirms("brain search archive")).toBe(false);
    expect(confirms("ls notes/archive")).toBe(false);
    expect(confirms("cat notes/archive/old.md")).toBe(false);
  });
});

describe("configurability", () => {
  test("the shipped set is exported so a deployment can extend or replace it", () => {
    expect(DEFAULT_CONFIRM_BASH_PATTERNS.length).toBeGreaterThan(0);
    // Every shipped source must compile — one that does not would be silently
    // skipped at runtime, i.e. a pattern that never fires.
    for (const { pattern } of DEFAULT_CONFIRM_BASH_PATTERNS) {
      expect(() => new RegExp(pattern, "i")).not.toThrow();
    }
  });

  test("matching is case-insensitive", () => {
    expect(confirms("BRAIN ARCHIVE a.md")).toBe(true);
    expect(confirms("RM -RF /")).toBe(true);
  });
});

describe("unparseable patterns", () => {
  test("an all-invalid list rejects construction before the scripted runtime or tools run", async () => {
    let queries = 0;
    let toolCalls = 0;
    const queryFn = ((params: { options?: Options }) => {
      queries++;
      return (async function* () {
        const group = params.options!.hooks!.PreToolUse!.find(
          (entry) => entry.matcher === MUTATING_TOOL_MATCHER
        )!;
        const decision = await group.hooks[0]!(
          {
            hook_event_name: "PreToolUse", tool_name: "Bash",
            tool_input: { command: "git push --force" }, tool_use_id: "invalid-patterns-tool",
          } as never,
          "invalid-patterns-tool",
          { signal: new AbortController().signal }
        );
        const output = "hookSpecificOutput" in decision ? decision.hookSpecificOutput : undefined;
        if (output?.hookEventName !== "PreToolUse" || output.permissionDecision !== "deny") {
          toolCalls++;
        }
        yield {
          type: "result", subtype: "success", session_id: "invalid-patterns",
          total_cost_usd: 0, duration_ms: 1, num_turns: 1,
        };
      })();
    }) as unknown as typeof query;
    let backend: ReturnType<typeof createClaudeBackend> | undefined;
    let constructionError: unknown;
    try {
      backend = createClaudeBackend({
        brainPath: "/tmp", confirmBashPatterns: ["("], queryFn, log: () => {},
      });
    } catch (error) {
      constructionError = error;
    }
    // On the old behavior the real backend constructs and runs this runtime.
    if (backend) {
      await backend.startTurn({
        prompt: "test", signal: new AbortController().signal,
        bridge: { emit: () => {}, requestPermission: async () => ({ behavior: "deny", message: "No." }) },
      });
    }
    expect(constructionError).toBeInstanceOf(Error);
    expect((constructionError as Error).message).toMatch(/confirmBashPatterns.*BRAIN_UI_CONFIRM_BASH/);
    expect(queries).toBe(0);
    expect(toolCalls).toBe(0);
  });

  test("are reported through the injected log callback, with the source", () => {
    const calls: Array<{ level: string; message: string; attrs?: Record<string, unknown> }> = [];

    createClaudeBackend({
      brainPath: "/tmp",
      confirmBashPatterns: ["(unclosed", String.raw`\brm\s`],
      log: (level, message, attrs) => calls.push({ level, message, attrs }),
    });

    // The valid pattern compiles silently; only the broken one is reported —
    // and through the callback, so a host's structured log receives it
    // instead of a bare console line.
    expect(calls.length).toBe(1);
    expect(calls[0].level).toBe("warn");
    expect(calls[0].message).toContain("confirmBashPatterns");
    expect(calls[0].attrs?.source).toBe("(unclosed");
    expect(calls[0].attrs?.error).toBeString();
  });
});

describe("what the card says (#112)", () => {
  /** The description of the confirmation one command raises, under `patterns`. */
  async function descriptionFor(
    command: string,
    confirmBashPatterns?: Parameters<typeof createClaudeBackend>[0]["confirmBashPatterns"]
  ): Promise<string | undefined> {
    let description: string | undefined;
    let queries = 0;
    const queryFn = ((params: { options?: Options }) => {
      queries++;
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "card" };
        const group = params.options!.hooks!.PreToolUse!.find(
          (entry) => entry.matcher === MUTATING_TOOL_MATCHER
        )!;
        await group.hooks[0]!(
          {
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command },
            tool_use_id: "card-1",
          } as never,
          "card-1",
          { signal: new AbortController().signal }
        );
        yield {
          type: "result",
          subtype: "success",
          session_id: "card",
          total_cost_usd: 0,
          duration_ms: 1,
          num_turns: 1,
        };
      })();
    }) as unknown as typeof query;
    const backend = createClaudeBackend({
      brainPath: "/tmp",
      queryFn,
      log: () => {},
      ...(confirmBashPatterns ? { confirmBashPatterns } : {}),
    });
    await backend.startTurn({
      prompt: "card",
      signal: new AbortController().signal,
      bridge: {
        emit: () => {},
        requestPermission: async (request) => {
          description = request.description;
          return { behavior: "deny", message: "No." };
        },
      },
    });
    expect(queries).toBe(1);
    return description;
  }

  test("a shipped pattern's card names its effect", async () => {
    expect(await descriptionFor("git push --force origin main")).toBe(
      "force-push, overwriting history on the remote"
    );
  });

  test("a deployment's bare-string pattern still confirms, with the old sentence", async () => {
    expect(await descriptionFor("deploy prod", [String.raw`\bdeploy\s+prod\b`])).toBe(
      "This command matches a pattern configured to require confirmation."
    );
  });

  test("a deployment's pattern in the new form names its own effect", async () => {
    expect(
      await descriptionFor("deploy prod", [
        { pattern: String.raw`\bdeploy\s+prod\b`, effect: "ship this build to production" },
      ])
    ).toBe("ship this build to production");
  });

  test("mixed valid/invalid patterns still run and confirm with the valid effect", async () => {
    expect(await descriptionFor("deploy prod", [
      "(", { pattern: String.raw`\bdeploy\b`, effect: "ship to production" },
    ])).toBe("ship to production");
  });

  test("an explicit empty list still runs without confirmation", async () => {
    expect(await descriptionFor("git push --force", [])).toBeUndefined();
  });
});
