import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  compileConfirmPatterns,
  createWriteLock,
  DEFAULT_CONFIRM_BASH_PATTERNS,
} from "@schlessera/brain-ui-sdk/server";

import { createBrainAccess } from "../src/brain-access";
import { approvalReason, createPermissionGate } from "../src/permission-gate";
import { createBrainTools, DEFAULT_PI_ALLOWED_TOOLS, TOOL_RISK } from "../src/tools";
import { createTurnContext } from "../src/turn-context";
import { makeEmptyBrain, makeIndexedBrain, resultText } from "./helpers";
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
    expect(mock.permissionCalls).toHaveLength(1);
    expect(mock.permissionCalls[0].toolName).toBe("bash");
  });

  test("approval with updatedInput patches the input in place", async () => {
    const turn = createTurnContext();
    const mock = makeMockBridge({
      decision: { behavior: "allow", updatedInput: { command: "rm -r safe-subdir" } },
    });
    turn.bridge = mock.bridge;
    const handler = gateHandler({ turn, allowedTools: ALLOWED, confirmPatterns: CONFIRM });

    const input = { command: "rm -rf notes", timeout: 5 };
    const res = await handler({ toolName: "bash", toolCallId: "t3", input });
    expect(res).toBeUndefined();
    // updatedInput replaces the whole input: patched key applied, absent key dropped.
    expect(input.command).toBe("rm -r safe-subdir");
    expect("timeout" in input).toBe(false);
  });

  test("gated call with no live turn is blocked, not silently run", async () => {
    const turn = createTurnContext(); // bridge stays null
    const handler = gateHandler({ turn, allowedTools: ALLOWED, confirmPatterns: CONFIRM });
    const res = await handler({
      toolName: "third_party_tool",
      toolCallId: "t4",
      input: {},
    });
    expect(res?.block).toBe(true);
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
    expect(mock.permissionCalls).toHaveLength(1);
  });
});

describe("curated tools execute without in-tool gating", () => {
  test("write_file writes with no permission round-trip", async () => {
    const brain = makeEmptyBrain();
    try {
      const turn = createTurnContext();
      const tools = toolMap(
        createBrainTools({ brain: createBrainAccess(brain.root), turn, writeLock: createWriteLock() })
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
        createBrainTools({ brain: createBrainAccess(brain.root), turn, writeLock: createWriteLock() })
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
        createBrainTools({ brain: createBrainAccess(brain.root), turn, writeLock: createWriteLock() })
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
        createBrainTools({ brain: createBrainAccess(brain.root), turn, writeLock: createWriteLock() })
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
        createBrainTools({ brain: createBrainAccess(brain.root), turn, writeLock: createWriteLock() })
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
        createBrainTools({ brain: createBrainAccess(brain.root), turn, writeLock: createWriteLock() })
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
        createBrainTools({ brain: createBrainAccess(brain.root), turn, writeLock: createWriteLock() })
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
        createBrainTools({ brain: createBrainAccess(brain.root), turn, writeLock: createWriteLock() })
      );
      expect(base.get_current_location).toBeUndefined();
      expect(base.query_activity).toBeUndefined();
      expect(base.request_image_mask).toBeUndefined();

      const full = toolMap(
        createBrainTools({
          brain: createBrainAccess(brain.root),
          turn,
          writeLock: createWriteLock(),
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

  test("risk-class table covers every registered tool", () => {
    const brain = makeEmptyBrain();
    try {
      const turn = createTurnContext();
      const tools = createBrainTools({
        brain: createBrainAccess(brain.root),
        turn,
        writeLock: createWriteLock(),
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
        createBrainTools({ brain: createBrainAccess(brain.root), turn, writeLock: createWriteLock() })
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
        createBrainTools({ brain: createBrainAccess(brain.root), turn, writeLock: createWriteLock() })
      );
      await expect(
        tools.read_file.execute("e2", { path: "../../etc/passwd" }, undefined, undefined, CTX)
      ).rejects.toThrow("escapes the brain repository");
    } finally {
      brain.cleanup();
    }
  });
});
