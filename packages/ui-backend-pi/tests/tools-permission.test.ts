import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PermissionDecision } from "@schlessera/brain-ui-sdk/server";
import {
  compileConfirmPatterns,
  createKeyedLock,
  DEFAULT_CONFIRM_BASH_PATTERNS,
} from "@schlessera/brain-ui-sdk/server";

import { createBrainAccess } from "../src/brain-access";
import { approvalReason, createPermissionGate } from "../src/permission-gate";
import { createBrainTools, DEFAULT_PI_ALLOWED_TOOLS, TOOL_RISK, toolLockFromKeyed } from "../src/tools";
import { createTurnContext } from "../src/turn-context";
import { makeEmptyBrain, makeIndexedBrain, resultText, type TempBrain } from "./helpers";
import { makeMockBridge } from "./mock-bridge";

// ExtensionContext is required by the ToolDefinition.execute signature but is
// unused by the curated tools; a stub is fine for direct unit invocation.
const CTX = {} as never;

const CONFIRM = compileConfirmPatterns(DEFAULT_CONFIRM_BASH_PATTERNS, () => {});
const ALLOWED: ReadonlySet<string> = new Set(DEFAULT_PI_ALLOWED_TOOLS);

function toolMap(tools: ToolDefinition[]): Record<string, ToolDefinition> {
  return Object.fromEntries(tools.map((t) => [t.name, t]));
}

/**
 * Instantiate the gate's tool_call handler the way pi's extension runner
 * would: run the factory against a stub ExtensionAPI and capture the handler.
 */
function gateHandler(opts: Parameters<typeof createPermissionGate>[0]) {
  const gate = createPermissionGate(opts);
  let handler:
    | ((event: {
        toolName: string;
        toolCallId: string;
        input: unknown;
      }) => Promise<{ block: boolean; reason?: string } | undefined>)
    | undefined;
  const pi = {
    on: (event: string, h: unknown) => {
      if (event === "tool_call") handler = h as typeof handler;
    },
  };
  const factory = typeof gate === "function" ? gate : gate.factory;
  factory(pi as never);
  if (!handler) throw new Error("gate registered no tool_call handler");
  return handler;
}

describe("approval policy (approvalReason)", () => {
  test("allowlisted tools need no approval", () => {
    for (const name of ["read_file", "write_file", "edit_file", "brain_add", "brain_update"]) {
      expect(approvalReason(name, {}, ALLOWED, CONFIRM)).toBeNull();
    }
  });

  test("plain bash needs no approval", () => {
    expect(approvalReason("bash", { command: "git status" }, ALLOWED, CONFIRM)).toBeNull();
    expect(approvalReason("bash", { command: "echo hi" }, ALLOWED, CONFIRM)).toBeNull();
  });

  test("destructive bash shapes need approval", () => {
    for (const command of [
      "rm -rf notes/",
      "git push --force origin main",
      "git reset --hard HEAD~3",
      "brain archive notes/foo.md",
    ]) {
      expect(approvalReason("bash", { command }, ALLOWED, CONFIRM)).toBeTruthy();
    }
  });

  test("brain_archive and unknown tools need approval", () => {
    expect(approvalReason("brain_archive", { path: "x.md" }, ALLOWED, CONFIRM)).toBeTruthy();
    expect(approvalReason("some_mcp_tool", {}, ALLOWED, CONFIRM)).toBeTruthy();
  });
});

describe("tool_call permission gate", () => {
  test("allowlisted call passes with no bridge round-trip", async () => {
    const turn = createTurnContext();
    const mock = makeMockBridge({ decision: { behavior: "deny", message: "should not ask" } });
    turn.bridge = mock.bridge;
    const handler = gateHandler({ turn, allowedTools: ALLOWED, confirmPatterns: CONFIRM });

    const res = await handler({
      toolName: "write_file",
      toolCallId: "t1",
      input: { path: "a.md", content: "x" },
    });
    expect(res).toBeUndefined();
    expect(mock.permissionCalls).toHaveLength(0);
  });

  test("allowlisted extension named Bash is not treated as pi's bash tool", async () => {
    const turn = createTurnContext(); // bridge stays null
    const handler = gateHandler({
      turn,
      allowedTools: new Set(["Bash"]),
      confirmPatterns: CONFIRM,
    });

    const res = await handler({
      toolName: "Bash",
      toolCallId: "extension-bash",
      input: { command: "rm -rf notes" },
    });
    expect(res).toBeUndefined();
  });

  test("a turn with no grant surface blocks without asking, for either kind", async () => {
    // The declaration is honoured on both shipped backends, or it is a
    // statement of intent on whichever one ignores it (#110).
    for (const call of [
      { toolName: "bash", toolCallId: "no-surface-command", input: { command: "rm -rf notes" } },
      { toolName: "some_mcp_tool", toolCallId: "no-surface-tool", input: {} },
    ]) {
      const turn = createTurnContext();
      const mock = makeMockBridge({ decision: { behavior: "allow" } });
      turn.bridge = mock.bridge;
      turn.noGrantSurface = true;
      const handler = gateHandler({ turn, allowedTools: ALLOWED, confirmPatterns: CONFIRM });

      const res = await handler(call);
      expect(res?.block).toBe(true);
      expect(res?.reason).toContain(call.toolName);
      expect(mock.permissionCalls).toHaveLength(0);
    }
  });

  test("gated call asks, denial blocks with the host's message", async () => {
    const turn = createTurnContext();
    const mock = makeMockBridge({ decision: { behavior: "deny", message: "user said no" } });
    turn.bridge = mock.bridge;
    const handler = gateHandler({ turn, allowedTools: ALLOWED, confirmPatterns: CONFIRM });

    const res = await handler({
      toolName: "bash",
      toolCallId: "t2",
      input: { command: "rm -rf notes" },
    });
    expect(res).toEqual({ block: true, reason: "user said no" });
    expect(mock.permissionCalls).toEqual([
      {
        toolUseId: "t2",
        toolName: "bash",
        input: { command: "rm -rf notes" },
        // The matched pattern's effect, in words (#112).
        description: "delete a directory and everything inside it",
        kind: "command",
      },
    ]);
  });

  test("approval with updatedInput patches the input in place", async () => {
    // An edit that needs no confirmation of its own is applied whole.
    const turn = createTurnContext();
    const mock = makeMockBridge({
      decision: { behavior: "allow", updatedInput: { command: "ls notes" } },
    });
    turn.bridge = mock.bridge;
    const handler = gateHandler({ turn, allowedTools: ALLOWED, confirmPatterns: CONFIRM });

    const input = { command: "rm -rf notes", timeout: 5 };
    const res = await handler({ toolName: "bash", toolCallId: "t3", input });
    expect(res).toBeUndefined();
    // updatedInput replaces the whole input: patched key applied, absent key dropped.
    expect(input.command).toBe("ls notes");
    expect("timeout" in input).toBe(false);
  });

  test("an edit carrying a __proto__ key is refused, not merged into the arguments", async () => {
    // JSON.parse makes `__proto__` an own key; Object.assign would then set
    // the arguments' prototype, and bash would read an inherited `command`
    // the re-check never saw. The WebSocket schema strips it; a bridge that
    // returns its own payload does not.
    const turn = createTurnContext();
    const mock = makeMockBridge({
      decision: {
        behavior: "allow",
        updatedInput: JSON.parse('{"__proto__":{"command":"brain archive notes/b.md"}}'),
      },
    });
    turn.bridge = mock.bridge;
    const handler = gateHandler({ turn, allowedTools: ALLOWED, confirmPatterns: CONFIRM });

    const input: Record<string, unknown> = { command: "brain archive notes/a.md" };
    const res = await handler({ toolName: "bash", toolCallId: "proto", input });
    expect(res?.block).toBe(true);
    expect(input.command).toBe("brain archive notes/a.md");
    expect(Object.getPrototypeOf(input)).toBe(Object.prototype);
  });

  test("an edit whose command is a getter is checked and applied as one value", async () => {
    // A bridge in the same process can hand back any object. The first read
    // says `ls`, every later one says archive: what was checked must be what
    // runs, so the edit is taken as one plain snapshot before either.
    let reads = 0;
    const updatedInput = {
      get command() {
        return ++reads === 1 ? "ls notes" : "brain archive notes/b.md";
      },
    };
    const turn = createTurnContext();
    const mock = makeMockBridge({ decision: { behavior: "allow", updatedInput } });
    turn.bridge = mock.bridge;
    const handler = gateHandler({ turn, allowedTools: ALLOWED, confirmPatterns: CONFIRM });

    const input: Record<string, unknown> = { command: "brain archive notes/a.md" };
    const res = await handler({ toolName: "bash", toolCallId: "getter", input });
    expect(res).toBeUndefined();
    expect(input.command).toBe("ls notes");
    expect(Object.getOwnPropertyDescriptor(input, "command")?.get).toBeUndefined();
  });

  test("an edit whose command is only inherited replaces nothing it did not show", async () => {
    // `Object.create({ command })` has no own command: the checked value and
    // the applied value must agree, so the destructive original must not
    // survive an approval that looked like a safe replacement.
    const turn = createTurnContext();
    const mock = makeMockBridge({
      decision: { behavior: "allow", updatedInput: Object.create({ command: "ls notes" }) },
    });
    turn.bridge = mock.bridge;
    const handler = gateHandler({ turn, allowedTools: ALLOWED, confirmPatterns: CONFIRM });

    const input: Record<string, unknown> = { command: "brain archive notes/a.md" };
    await handler({ toolName: "bash", toolCallId: "inherited", input });
    expect(input.command).not.toBe("brain archive notes/a.md");
  });

  test("a confirmed command edited to another on the same pattern is refused", async () => {
    // Behaviour change (#145 follow-up): the pattern names the kind of effect,
    // not the target, so `brain archive` of another document would pass a
    // pattern-only check. The card confirmed the command it showed.
    const turn = createTurnContext();
    const mock = makeMockBridge({
      decision: { behavior: "allow", updatedInput: { command: "brain archive notes/b.md" } },
    });
    turn.bridge = mock.bridge;
    const handler = gateHandler({ turn, allowedTools: ALLOWED, confirmPatterns: CONFIRM });

    const input = { command: "brain archive notes/a.md" };
    const res = await handler({ toolName: "bash", toolCallId: "retarget", input });
    expect(res?.block).toBe(true);
    expect(input).toEqual({ command: "brain archive notes/a.md" });
  });

  test("an edit that moves a confirmed archive to another document is refused, not applied", async () => {
    // The card showed notes/a.md being archived. An approval that comes back
    // pointing at notes/b.md is a confirmation nobody gave (#145).
    const turn = createTurnContext();
    const mock = makeMockBridge({
      decision: {
        behavior: "allow",
        updatedInput: { path: "notes/b.md", status: "archived" },
      },
    });
    turn.bridge = mock.bridge;
    const handler = gateHandler({ turn, allowedTools: ALLOWED, confirmPatterns: CONFIRM });

    const input = { path: "notes/a.md", status: "archived" };
    const res = await handler({ toolName: "brain_update", toolCallId: "edit-doc", input });

    expect(res?.block).toBe(true);
    expect(res?.reason).toContain("brain_update");
    expect(res?.reason).toContain("did not run");
    // Nothing was patched: the call is refused as a whole.
    expect(input).toEqual({ path: "notes/a.md", status: "archived" });
  });

  test("an edit that stays on the confirmed document is applied", async () => {
    const turn = createTurnContext();
    const mock = makeMockBridge({
      decision: {
        behavior: "allow",
        updatedInput: { path: "notes/a.md", status: "archived", summary: "Superseded." },
      },
    });
    turn.bridge = mock.bridge;
    const handler = gateHandler({ turn, allowedTools: ALLOWED, confirmPatterns: CONFIRM });

    const input: Record<string, unknown> = { path: "notes/a.md", status: "archived" };
    const res = await handler({ toolName: "brain_update", toolCallId: "edit-same-doc", input });

    expect(res).toBeUndefined();
    expect(input).toEqual({ path: "notes/a.md", status: "archived", summary: "Superseded." });
  });

  test("an edit into a command matching a pattern the card did not show is refused", async () => {
    const turn = createTurnContext();
    const mock = makeMockBridge({
      decision: { behavior: "allow", updatedInput: { command: "git push --force origin main" } },
    });
    turn.bridge = mock.bridge;
    const handler = gateHandler({ turn, allowedTools: ALLOWED, confirmPatterns: CONFIRM });

    const input = { command: "rm -rf notes" };
    const res = await handler({ toolName: "bash", toolCallId: "edit-pattern", input });

    expect(res?.block).toBe(true);
    expect(res?.reason).toContain("bash");
    expect(input).toEqual({ command: "rm -rf notes" });
  });

  test("an edit that needs no confirmation at all is applied", async () => {
    const turn = createTurnContext();
    const mock = makeMockBridge({
      decision: { behavior: "allow", updatedInput: { path: "notes/a.md", status: "active" } },
    });
    turn.bridge = mock.bridge;
    const handler = gateHandler({ turn, allowedTools: ALLOWED, confirmPatterns: CONFIRM });

    const input: Record<string, unknown> = { path: "notes/a.md", status: "archived" };
    const res = await handler({ toolName: "brain_update", toolCallId: "edit-unarchive", input });

    expect(res).toBeUndefined();
    expect(input).toEqual({ path: "notes/a.md", status: "active" });
  });

  test("the applied edit is what the executing tool takes its lock key from", async () => {
    // pi applies an edit by patching the arguments in place, and the tool then
    // executes with them — so the lock key is derived from the edited command,
    // not the one on the card. The edit needs no confirmation of its own
    // but is a staging write, which needs the git lock.
    const turn = createTurnContext();
    const mock = makeMockBridge({
      decision: {
        behavior: "allow",
        updatedInput: { command: "git add -A" },
      },
    });
    turn.bridge = mock.bridge;
    const handler = gateHandler({ turn, allowedTools: ALLOWED, confirmPatterns: CONFIRM });
    const input: Record<string, unknown> = { command: "rm -rf scratch" };
    expect(await handler({ toolName: "bash", toolCallId: "edit-lock", input })).toBeUndefined();

    const brain = makeEmptyBrain();
    try {
      const keys: (string | null)[] = [];
      const tools = toolMap(
        createBrainTools({
          brain: createBrainAccess(brain.root),
          turn,
          // Records the key and does not run the body: the command is never
          // executed, only classified.
          lock: {
            withKey: (key: string | null) => {
              keys.push(key);
              return Promise.resolve({ content: [], details: {} });
            },
          },
        } as never)
      );
      await tools.bash!.execute("edit-lock", input as never, undefined, undefined, CTX);
      expect(keys).toEqual(["repo-git"]);
    } finally {
      brain.cleanup();
    }
  });

  test("gated call with no live turn is blocked, not silently run", async () => {
    const turn = createTurnContext(); // bridge stays null
    const handler = gateHandler({ turn, allowedTools: ALLOWED, confirmPatterns: CONFIRM });
    const res = await handler({
      toolName: "third_party_tool",
      toolCallId: "t4",
      input: {},
    });
    expect(res).toEqual({
      block: true,
      reason: "No active turn to approve third_party_tool.",
    });
  });

  test("non-allowlisted extension tool asks and runs on allow", async () => {
    const turn = createTurnContext();
    const mock = makeMockBridge({ decision: { behavior: "allow" } });
    turn.bridge = mock.bridge;
    const handler = gateHandler({ turn, allowedTools: ALLOWED, confirmPatterns: CONFIRM });

    const res = await handler({
      toolName: "mcp_proxy_tool",
      toolCallId: "t5",
      input: { server: "x" },
    });
    expect(res).toBeUndefined();
    expect(mock.permissionCalls).toEqual([
      {
        toolUseId: "t5",
        toolName: "mcp_proxy_tool",
        input: { server: "x" },
        description:
          'Tool "mcp_proxy_tool" is not auto-allowed in this deployment.',
        kind: "tool",
      },
    ]);
  });
});

describe("curated tools execute without in-tool gating", () => {
  test("write_file writes with no permission round-trip", async () => {
    const brain = makeEmptyBrain();
    try {
      const turn = createTurnContext();
      const tools = toolMap(
        createBrainTools({ brain: createBrainAccess(brain.root), turn, lock: toolLockFromKeyed(createKeyedLock()) })
      );
      const mock = makeMockBridge({ decision: { behavior: "deny", message: "should not ask" } });
      turn.bridge = mock.bridge;

      await tools.write_file.execute("t1", { path: "note.md", content: "captured" }, undefined, undefined, CTX);
      expect(mock.permissionCalls).toHaveLength(0);
      expect(readFileSync(join(brain.root, "note.md"), "utf-8")).toBe("captured");
    } finally {
      brain.cleanup();
    }
  });

  test("bash runs with no permission round-trip", async () => {
    const brain = makeEmptyBrain();
    try {
      const turn = createTurnContext();
      const tools = toolMap(
        createBrainTools({ brain: createBrainAccess(brain.root), turn, lock: toolLockFromKeyed(createKeyedLock()) })
      );
      const mock = makeMockBridge({ decision: { behavior: "deny", message: "should not ask" } });
      turn.bridge = mock.bridge;

      const res = await tools.bash.execute("t2", { command: "echo brain-kit-ok" }, undefined, undefined, CTX);
      expect(mock.permissionCalls).toHaveLength(0);
      expect(resultText(res)).toContain("brain-kit-ok");
    } finally {
      brain.cleanup();
    }
  });

  test("ask_user degrades to an error when the host lacks askUser", async () => {
    const brain = makeEmptyBrain();
    try {
      const turn = createTurnContext();
      const tools = toolMap(
        createBrainTools({ brain: createBrainAccess(brain.root), turn, lock: toolLockFromKeyed(createKeyedLock()) })
      );
      turn.bridge = makeMockBridge().bridge; // no askUser

      await expect(
        tools.ask_user.execute(
          "t3",
          { questions: [{ question: "Q?", header: "H", options: [{ label: "A", description: "d" }] }] },
          undefined,
          undefined,
          CTX
        )
      ).rejects.toThrow("does not support ask_user");
    } finally {
      brain.cleanup();
    }
  });
});

describe("brain document tools", () => {
  const LINKED_DOCS = {
    "notes/alpha.md":
      "---\ntype: note\ntitle: Alpha\ncreated: 2026-01-01\nupdated: 2026-01-02\n" +
      "tags: [graph]\nstatus: active\nrelevance: primary\n---\n\nLinks to [[beta]].\n",
    "notes/beta.md":
      "---\ntype: note\ntitle: Beta\ncreated: 2026-01-01\nupdated: 2026-01-02\n" +
      "tags: [graph]\nstatus: active\nrelevance: primary\n---\n\nStands alone.\n",
  };

  test("brain_read returns the document, brain_list filters by tag", async () => {
    const brain = await makeIndexedBrain(LINKED_DOCS);
    try {
      const turn = createTurnContext();
      const tools = toolMap(
        createBrainTools({ brain: createBrainAccess(brain.root), turn, lock: toolLockFromKeyed(createKeyedLock()) })
      );
      const read = await tools.brain_read.execute("r1", { path: "notes/alpha.md" }, undefined, undefined, CTX);
      expect(resultText(read)).toContain("Links to [[beta]]");

      const list = await tools.brain_list.execute("r2", { tag: "graph" }, undefined, undefined, CTX);
      const text = resultText(list);
      expect(text).toContain("notes/alpha.md");
      expect(text).toContain("notes/beta.md");
    } finally {
      brain.cleanup();
    }
  });

  test("brain_graph traverses wiki-links", async () => {
    const brain = await makeIndexedBrain(LINKED_DOCS);
    try {
      const turn = createTurnContext();
      const tools = toolMap(
        createBrainTools({ brain: createBrainAccess(brain.root), turn, lock: toolLockFromKeyed(createKeyedLock()) })
      );
      const res = await tools.brain_graph.execute(
        "g1",
        { path: "notes/alpha.md", direction: "outgoing" },
        undefined,
        undefined,
        CTX
      );
      const parsed = JSON.parse(resultText(res)) as { edges: Array<{ source: string; target: string }> };
      expect(parsed.edges.some((e) => e.source === "notes/alpha.md" && e.target.includes("beta"))).toBe(true);
    } finally {
      brain.cleanup();
    }
  });

  test("brain_update sets frontmatter and appends content", async () => {
    const brain = await makeIndexedBrain(LINKED_DOCS);
    try {
      const turn = createTurnContext();
      const tools = toolMap(
        createBrainTools({ brain: createBrainAccess(brain.root), turn, lock: toolLockFromKeyed(createKeyedLock()) })
      );
      const res = await tools.brain_update.execute(
        "u1",
        { path: "notes/beta.md", summary: "Updated summary", append_content: "New section." },
        undefined,
        undefined,
        CTX
      );
      const outcome = JSON.parse(resultText(res)) as { changes: string[] };
      expect(outcome.changes).toContain("summary");
      expect(outcome.changes).toContain("content");
      const raw = readFileSync(join(brain.root, "notes/beta.md"), "utf-8");
      expect(raw).toContain("Updated summary");
      expect(raw).toContain("New section.");
    } finally {
      brain.cleanup();
    }
  });

  test("brain_archive archives a document (dry run first)", async () => {
    const brain = await makeIndexedBrain(LINKED_DOCS);
    try {
      const turn = createTurnContext();
      const tools = toolMap(
        createBrainTools({ brain: createBrainAccess(brain.root), turn, lock: toolLockFromKeyed(createKeyedLock()) })
      );
      const dry = await tools.brain_archive.execute(
        "a1",
        { path: "notes/beta.md", dry_run: true },
        undefined,
        undefined,
        CTX
      );
      expect(JSON.parse(resultText(dry)).dryRun).toBe(true);
      expect(readFileSync(join(brain.root, "notes/beta.md"), "utf-8")).toContain("status: active");

      const real = await tools.brain_archive.execute(
        "a2",
        { path: "notes/beta.md" },
        undefined,
        undefined,
        CTX
      );
      expect(JSON.parse(resultText(real)).status).toBe("archived");
      expect(readFileSync(join(brain.root, "notes/beta.md"), "utf-8")).toContain("status: archived");
    } finally {
      brain.cleanup();
    }
  });
});

describe("bridge-capability tool registration", () => {
  test("location/activity/mask tools register only with the capability", () => {
    const brain = makeEmptyBrain();
    try {
      const turn = createTurnContext();
      const base = toolMap(
        createBrainTools({ brain: createBrainAccess(brain.root), turn, lock: toolLockFromKeyed(createKeyedLock()) })
      );
      expect(base.get_current_location).toBeUndefined();
      expect(base.query_activity).toBeUndefined();
      expect(base.request_image_mask).toBeUndefined();

      const full = toolMap(
        createBrainTools({
          brain: createBrainAccess(brain.root),
          turn,
          lock: toolLockFromKeyed(createKeyedLock()),
          capabilities: { location: true, activity: true, mask: true },
        })
      );
      expect(full.get_current_location).toBeDefined();
      expect(full.query_activity).toBeDefined();
      expect(full.request_image_mask).toBeDefined();
    } finally {
      brain.cleanup();
    }
  });

  test("the mask editor refuses a turn with no grant surface instead of blocking on it", async () => {
    // The tool set is built once per session, so the posture is checked when
    // the tool runs. It is registered and it fails fast, rather than opening
    // an editor and waiting for a region nobody can paint.
    const brain = makeEmptyBrain();
    try {
      const turn = createTurnContext();
      const mock = makeMockBridge();
      turn.bridge = mock.bridge;
      (turn.bridge as { requestMask?: unknown }).requestMask = () => {
        throw new Error("the editor must not open");
      };
      const tools = toolMap(
        createBrainTools({
          brain: createBrainAccess(brain.root),
          turn,
          lock: toolLockFromKeyed(createKeyedLock()),
          capabilities: { mask: true },
        })
      );

      turn.noGrantSurface = true;
      await expect(
        tools.request_image_mask!.execute("m1", { imagePath: "a.png" }, undefined, undefined, CTX)
      ).rejects.toThrow(/no way to show anyone an image/);
    } finally {
      brain.cleanup();
    }
  });

  test("the list card refuses a turn with no grant surface instead of blocking on it", async () => {
    const brain = makeEmptyBrain();
    try {
      const turn = createTurnContext();
      const mock = makeMockBridge();
      turn.bridge = mock.bridge;
      (turn.bridge as { askUserList?: unknown }).askUserList = () => {
        throw new Error("the card must not open");
      };
      const tools = toolMap(
        createBrainTools({
          brain: createBrainAccess(brain.root),
          turn,
          lock: toolLockFromKeyed(createKeyedLock()),
        })
      );
      const input = {
        prompt: "Rate?",
        scale: [{ label: "x" }, { label: "y" }],
        items: [{ id: "a", label: "A" }],
      };
      turn.noGrantSurface = true;
      await expect(
        tools.ask_user_list!.execute("l1", input, undefined, undefined, CTX)
      ).rejects.toThrow(/no way to show anyone a card/);
    } finally {
      brain.cleanup();
    }
  });

  test("risk-class table covers every registered tool", () => {
    const brain = makeEmptyBrain();
    try {
      const turn = createTurnContext();
      const tools = createBrainTools({
        brain: createBrainAccess(brain.root),
        turn,
        lock: toolLockFromKeyed(createKeyedLock()),
        capabilities: { location: true, activity: true, mask: true },
      });
      for (const t of tools) {
        expect(TOOL_RISK[t.name]).toBeDefined();
      }
      expect(TOOL_RISK.read_file).toBe("read");
      expect(TOOL_RISK.write_file).toBe("mutate");
      expect(TOOL_RISK.bash).toBe("mutate");
      expect(TOOL_RISK.brain_archive).toBe("mutate");
    } finally {
      brain.cleanup();
    }
  });
});

describe("path containment", () => {
  test("write_file outside the repo is refused", async () => {
    const brain = makeEmptyBrain();
    try {
      const turn = createTurnContext();
      const tools = toolMap(
        createBrainTools({ brain: createBrainAccess(brain.root), turn, lock: toolLockFromKeyed(createKeyedLock()) })
      );
      turn.bridge = makeMockBridge({ decision: { behavior: "allow" } }).bridge;

      await expect(
        tools.write_file.execute("e1", { path: "../escape.md", content: "x" }, undefined, undefined, CTX)
      ).rejects.toThrow("escapes the brain repository");
    } finally {
      brain.cleanup();
    }
  });

  test("read_file outside the repo is refused", async () => {
    const brain = makeEmptyBrain();
    try {
      const turn = createTurnContext();
      const tools = toolMap(
        createBrainTools({ brain: createBrainAccess(brain.root), turn, lock: toolLockFromKeyed(createKeyedLock()) })
      );
      await expect(
        tools.read_file.execute("e2", { path: "../../etc/passwd" }, undefined, undefined, CTX)
      ).rejects.toThrow("escapes the brain repository");
    } finally {
      brain.cleanup();
    }
  });
});

/**
 * Archiving through the auto-allowed `brain_update`.
 *
 * `brain_archive` is off the allowlist because archiving is a VISIBILITY
 * change: an archived document drops out of search, briefings and context
 * assembly. `brain_update` takes the same `status` field and IS on the
 * allowlist, so `status: "archived"` made that change with no card. These run
 * the gate and the real tool against a real indexed brain, because the claim
 * worth proving is about the document on disk and in the index, not about a
 * predicate.
 */
describe("archiving through brain_update", () => {
  // Each case gets its own body: gray-matter caches parsed documents by their
  // exact content, so byte-identical fixtures across cases would share one
  // frontmatter object and leak one case's write into the next.
  const docs = (marker: string) => ({
    "notes/beta.md":
      "---\ntype: note\ntitle: Beta\ncreated: 2026-01-01\nupdated: 2026-01-02\n" +
      `tags: [graph]\nstatus: active\nrelevance: primary\n---\n\nStands alone. ${marker}\n`,
  });

  /**
   * Run one brain_update the way pi's runtime does: consult the gate, and
   * execute the tool only when the gate did not block it.
   */
  async function updateThroughGate(
    brain: TempBrain,
    input: Record<string, unknown>,
    decision: PermissionDecision
  ) {
    const turn = createTurnContext();
    const mock = makeMockBridge({ decision });
    turn.bridge = mock.bridge;
    const handler = gateHandler({ turn, allowedTools: ALLOWED, confirmPatterns: CONFIRM });
    const tools = toolMap(
      createBrainTools({
        brain: createBrainAccess(brain.root),
        turn,
        lock: toolLockFromKeyed(createKeyedLock()),
      })
    );

    const gate = await handler({ toolName: "brain_update", toolCallId: "u1", input });
    if (!gate?.block) {
      await tools.brain_update.execute("u1", input as never, undefined, undefined, CTX);
    }
    const search = await tools.brain_search.execute(
      "s1",
      { query: "Beta" },
      undefined,
      undefined,
      CTX
    );
    return {
      gate,
      permissionCalls: mock.permissionCalls,
      raw: readFileSync(join(brain.root, "notes/beta.md"), "utf-8"),
      searchText: resultText(search),
    };
  }

  test("an archiving update asks, as a per-use confirmation", async () => {
    const brain = await makeIndexedBrain(docs("asks"));
    try {
      const { permissionCalls } = await updateThroughGate(
        brain,
        { path: "notes/beta.md", status: "archived" },
        { behavior: "deny", message: "Keep it visible." }
      );
      expect(permissionCalls).toEqual([
        {
          toolUseId: "u1",
          toolName: "brain_update",
          input: { path: "notes/beta.md", status: "archived" },
          description:
            'Setting status to "archived" removes this document from search, briefings and context assembly.',
          // Never "tool": a remembered "always allow brain_update" would
          // reopen the hole permanently.
          kind: "command",
        },
      ]);
    } finally {
      brain.cleanup();
    }
  });

  test("denying it leaves the status unchanged on disk and in the index", async () => {
    const brain = await makeIndexedBrain(docs("denied"));
    try {
      const { gate, raw, searchText } = await updateThroughGate(
        brain,
        { path: "notes/beta.md", status: "archived" },
        { behavior: "deny", message: "Keep it visible." }
      );
      // Asserted before the gate's own return value, so this case fails on
      // the harm (an archived document) and not only on a missing card.
      expect(raw).toContain("status: active");
      expect(raw).not.toContain("status: archived");
      // The point of the card: the document is still findable.
      expect(searchText).toContain("notes/beta.md");
      expect(gate).toEqual({ block: true, reason: "Keep it visible." });
    } finally {
      brain.cleanup();
    }
  });

  test("approving it archives, which is what the card is about", async () => {
    const brain = await makeIndexedBrain(docs("approved"));
    try {
      const { gate, raw, searchText } = await updateThroughGate(
        brain,
        { path: "notes/beta.md", status: "archived" },
        { behavior: "allow" }
      );
      expect(gate).toBeUndefined();
      expect(raw).toContain("status: archived");
      // Gone from search with no further action — the reason approval is asked.
      expect(searchText).not.toContain("notes/beta.md");
    } finally {
      brain.cleanup();
    }
  });

  test("an update that does not archive runs unprompted", async () => {
    const cases: Array<Record<string, unknown>> = [
      { path: "notes/beta.md", summary: "A new one-liner" },
      { path: "notes/beta.md", status: "active" },
      { path: "notes/beta.md", status: "draft" },
    ];
    for (const input of cases) {
      const brain = await makeIndexedBrain(docs(JSON.stringify(input)));
      try {
        const { gate, permissionCalls, raw, searchText } = await updateThroughGate(
          brain,
          input,
          { behavior: "deny", message: "should not ask" }
        );
        expect(permissionCalls, `${JSON.stringify(input)} must not ask`).toEqual([]);
        expect(gate).toBeUndefined();
        expect(raw).not.toContain("status: archived");
        // Still visible: nothing about these updates changes what search sees.
        expect(searchText).toContain("notes/beta.md");
      } finally {
        brain.cleanup();
      }
    }
  });
});
