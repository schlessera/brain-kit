import { describe, expect, test } from "bun:test";

import { archivesDocument } from "../src/server/confirm-patterns";
import {
  checkEditedApproval,
  createToolPermissionRequest,
  decideToolPermission,
  requestToolPermission,
} from "../src/server/permission-gate";

const confirmPatterns = [/\brm\s+-rf\b/i];
const allowedTools: ReadonlySet<string> = new Set(["bash", "read_file"]);

const ARCHIVE_REASON =
  'Setting status to "archived" removes this document from search, briefings and context assembly.';

describe("shared permission gate", () => {
  test("distinguishes tool grants from per-command confirmations", () => {
    expect(
      decideToolPermission({
        toolName: "external_tool",
        shellToolName: "bash",
        input: {},
        allowedTools,
        confirmPatterns,
      })
    ).toEqual({
      kind: "tool",
      reason: 'Tool "external_tool" is not auto-allowed in this deployment.',
    });
    expect(
      decideToolPermission({
        toolName: "bash",
        shellToolName: "bash",
        input: { command: "rm -rf notes" },
        allowedTools,
        confirmPatterns,
      })
    ).toEqual({
      kind: "command",
      reason: "This command matches a pattern configured to require confirmation.",
    });
    expect(
      decideToolPermission({
        toolName: "read_file",
        shellToolName: "bash",
        input: {},
        allowedTools,
        confirmPatterns,
      })
    ).toBeNull();
    expect(
      decideToolPermission({
        toolName: "Bash",
        shellToolName: "bash",
        input: { command: "rm -rf notes" },
        allowedTools: new Set(["Bash"]),
        confirmPatterns,
      })
    ).toBeNull();
  });

  test("constructs the shared request without replacing runtime descriptions", () => {
    const approval = { kind: "tool" as const, reason: "policy reason" };
    expect(
      createToolPermissionRequest({
        toolUseId: "t1",
        toolName: "external_tool",
        input: { query: "x" },
        description: "Runtime description",
        approval,
      })
    ).toEqual({
      toolUseId: "t1",
      toolName: "external_tool",
      input: { query: "x" },
      description: "Runtime description",
      kind: "tool",
    });
  });

  test("fails closed for a turn with no grant surface, and never asks", async () => {
    // The refusal belongs here rather than in either binding: both request
    // kinds come through this one call, and a rule that lands only in the
    // Claude backend's canUseTool misses the command path entirely.
    const asked: string[] = [];
    const reported: unknown[] = [];
    const bridge = {
      requestPermission: async (req: { toolName: string }) => {
        asked.push(req.toolName);
        return { behavior: "allow" } as const;
      },
      activity: (event: unknown) => reported.push(event),
    };

    for (const kind of ["tool", "command"] as const) {
      const request = {
        toolUseId: `t-${kind}`,
        toolName: "Bash",
        input: { command: "rm -rf notes" },
        description: "reason",
        kind,
      };
      const decision = await requestToolPermission(bridge, request, {
        noGrantSurface: true,
      });
      expect(decision.behavior).toBe("deny");
      // Named, so the model knows which call failed and a listener hears it.
      expect(decision.behavior === "deny" && decision.message).toContain("Bash");
      expect(decision.behavior === "deny" && decision.message.trimEnd().endsWith(".")).toBe(
        true
      );
    }

    // Nothing was put to the host, so no card was parked anywhere.
    expect(asked).toEqual([]);
    expect(reported).toEqual([
      {
        kind: "permission_denied",
        toolUseId: "t-tool",
        requestKind: "tool",
        reason: expect.any(String),
      },
      {
        kind: "permission_denied",
        toolUseId: "t-command",
        requestKind: "command",
        reason: expect.any(String),
      },
    ]);
  });

  test("a throwing activity reporter does not swallow the refusal", async () => {
    // Observability must not break the observed turn, and least of all may it
    // lose the denial it was reporting.
    const decision = await requestToolPermission(
      {
        requestPermission: async () => ({ behavior: "allow" }) as const,
        activity: () => {
          throw new Error("recorder is down");
        },
      },
      {
        toolUseId: "t-throws",
        toolName: "Bash",
        input: {},
        description: "reason",
        kind: "tool" as const,
      },
      { noGrantSurface: true }
    );

    expect(decision.behavior).toBe("deny");
    expect(decision.behavior === "deny" && decision.message).toContain("Bash");
  });

  test("a turn that did not declare it still reaches the bridge", async () => {
    const asked: string[] = [];
    const bridge = {
      requestPermission: async (req: { toolName: string }) => {
        asked.push(req.toolName);
        return { behavior: "allow" } as const;
      },
    };

    await expect(
      requestToolPermission(bridge, {
        toolUseId: "t3",
        toolName: "Bash",
        input: {},
        description: "reason",
        kind: "command" as const,
      })
    ).resolves.toEqual({ behavior: "allow" });
    expect(asked).toEqual(["Bash"]);
  });

  test("fails closed when no live bridge can approve the request", async () => {
    const request = {
      toolUseId: "t2",
      toolName: "external_tool",
      input: {},
      description: "reason",
      kind: "tool" as const,
    };
    await expect(requestToolPermission(null, request)).resolves.toEqual({
      behavior: "deny",
      message: "No active turn to approve external_tool.",
    });
  });
});

/**
 * `brain_update` is auto-allowed on both backends, and `status: "archived"`
 * through it makes the same visibility change `brain_archive` keeps a card
 * for. The rule is here rather than in either backend because the policy does
 * not change with the model runtime — only the tool's spelling does.
 */
describe("an update that archives", () => {
  const withUpdate = (toolName: string, input: unknown, updateToolName = "brain_update") =>
    decideToolPermission({
      toolName,
      shellToolName: "bash",
      updateToolName,
      input,
      allowedTools: new Set(["bash", "brain_update", "mcp__brain__brain_update"]),
      confirmPatterns,
    });

  test("confirms per use, and is never a grantable tool approval", () => {
    expect(withUpdate("brain_update", { path: "a.md", status: "archived" })).toEqual({
      kind: "command",
      reason: ARCHIVE_REASON,
    });
  });

  test("matches whichever spelling the runtime uses, and only that one", () => {
    expect(
      withUpdate(
        "mcp__brain__brain_update",
        { path: "a.md", status: "archived" },
        "mcp__brain__brain_update"
      )
    ).toEqual({ kind: "command", reason: ARCHIVE_REASON });
    // A runtime that did not declare an update tool gets the old behaviour,
    // and a same-named tool from another runtime is not silently gated.
    expect(
      decideToolPermission({
        toolName: "brain_update",
        shellToolName: "bash",
        input: { path: "a.md", status: "archived" },
        allowedTools: new Set(["brain_update"]),
        confirmPatterns,
      })
    ).toBeNull();
    expect(
      withUpdate("brain_update", { path: "a.md", status: "archived" }, "mcp__brain__brain_update")
    ).toBeNull();
  });

  test("every other update stays silent", () => {
    for (const input of [
      { path: "a.md", summary: "new" },
      { path: "a.md", status: "active" },
      { path: "a.md", status: "draft" },
      { path: "a.md", status: "ARCHIVED" },
      { path: "a.md", append_content: "status: archived" },
      {},
    ]) {
      expect(withUpdate("brain_update", input), JSON.stringify(input)).toBeNull();
    }
  });

  test("a non-allowlisted update still asks as a tool grant, not a confirmation", () => {
    // Order matters: a deployment that removed brain_update from its
    // allowlist must get ONE grantable card, not a per-use one.
    expect(
      decideToolPermission({
        toolName: "brain_update",
        shellToolName: "bash",
        updateToolName: "brain_update",
        input: { path: "a.md", status: "archived" },
        allowedTools: new Set(["bash"]),
        confirmPatterns,
      })
    ).toEqual({
      kind: "tool",
      reason: 'Tool "brain_update" is not auto-allowed in this deployment.',
    });
  });
});

describe("archivesDocument", () => {
  test("is exactly the archived status and nothing else", () => {
    expect(archivesDocument({ status: "archived" })).toBe(true);
    expect(archivesDocument({ path: "a.md", status: "archived" })).toBe(true);
    for (const input of [
      { status: "active" },
      { status: "draft" },
      { status: "Archived" },
      { status: ["archived"] },
      { statuses: "archived" },
      {},
      null,
      undefined,
      "archived",
      42,
    ]) {
      expect(archivesDocument(input), JSON.stringify(input) ?? "undefined").toBe(false);
    }
  });
});

describe("checkEditedApproval", () => {
  const patterns = [/\brm\s+-rf\b/i, /\bgit\s+push\b.*--force/i];
  const check = (toolName: string, originalInput: unknown, editedInput: unknown) =>
    checkEditedApproval({
      toolName,
      shellToolName: "bash",
      updateToolName: "brain_update",
      confirmPatterns: patterns,
      originalInput,
      editedInput,
    });

  test("an edit that needs no confirmation passes", () => {
    expect(check("bash", { command: "rm -rf notes" }, { command: "ls notes" })).toBeNull();
    expect(
      check("brain_update", { path: "a.md", status: "archived" }, { path: "a.md", status: "active" })
    ).toBeNull();
    expect(check("read_file", { path: "a.md" }, { path: "b.md" })).toBeNull();
  });

  test("an edit that keeps the confirmed command or document passes", () => {
    // Only what the confirmation is not about may change: here the command
    // text is identical and a field beside it moves.
    expect(
      check("bash", { command: "rm -rf notes" }, { command: "rm -rf notes", timeout: 5 })
    ).toBeNull();
    expect(
      check(
        "brain_update",
        { path: "a.md", status: "archived" },
        { path: "a.md", status: "archived", summary: "Gone." }
      )
    ).toBeNull();
  });

  test("an edit that needs a confirmation the card did not show is refused, naming the tool", () => {
    const pattern = check("bash", { command: "rm -rf notes" }, { command: "git push --force" });
    expect(pattern).toContain("bash");
    expect(pattern).toContain("did not run");

    const added = check(
      "bash",
      { command: "rm -rf notes" },
      { command: "rm -rf notes && git push --force" }
    );
    expect(added).toContain("bash");

    const document = check(
      "brain_update",
      { path: "a.md", status: "archived" },
      { path: "b.md", status: "archived" }
    );
    expect(document).toContain("brain_update");
    expect(document).toContain(ARCHIVE_REASON);

    // Nothing was confirmed at all: the card was for an input that needed none.
    expect(
      check("brain_update", { path: "a.md", summary: "x" }, { path: "a.md", status: "archived" })
    ).toContain("brain_update");
  });

  test("a destructive command edited to another destructive command is refused, even on the same pattern", () => {
    // The card confirmed THIS command. The pattern names a class of effect,
    // not the target: `brain archive a.md` and `brain archive b.md` match the
    // same pattern and archive different documents (#145 follow-up).
    const archive = [/\bbrain\s+archive\b/i];
    const retarget = checkEditedApproval({
      toolName: "bash",
      shellToolName: "bash",
      confirmPatterns: archive,
      originalInput: { command: "brain archive notes/a.md" },
      editedInput: { command: "brain archive notes/b.md" },
    });
    expect(retarget).toContain("bash");
    expect(retarget).toContain("did not run");
    // Narrowing is refused too: the card did not show the narrower command.
    expect(check("bash", { command: "rm -rf notes" }, { command: "rm -rf notes/old" })).toContain(
      "bash"
    );
  });

  test("an edited input with a __proto__ key is refused whatever it contains", () => {
    const edited = JSON.parse('{"__proto__":{"command":"rm -rf notes"}}');
    expect(check("bash", { command: "rm -rf notes" }, edited)).toContain("bash");
    expect(check("read_file", { path: "a.md" }, edited)).toContain("read_file");
  });

  test("a confirmation hiding behind a tool grant is still seen", () => {
    // The tool-level decision is a property of the name, which an edit cannot
    // change; what an edit CAN change is whether the call is destructive.
    expect(check("bash", { command: "ls" }, { command: "rm -rf notes" })).toContain("bash");
  });
});
