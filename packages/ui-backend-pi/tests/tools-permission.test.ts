import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createWriteLock } from "@schlessera/brain-ui-sdk/server";

import { createBrainAccess } from "../src/brain-access";
import { createBrainTools, TOOL_RISK } from "../src/tools";
import { createTurnContext } from "../src/turn-context";
import { makeEmptyBrain, resultText } from "./helpers";
import { makeMockBridge } from "./mock-bridge";

// ExtensionContext is required by the ToolDefinition.execute signature but is
// unused by the curated tools; a stub is fine for direct unit invocation.
const CTX = {} as never;

function toolMap(tools: ToolDefinition[]): Record<string, ToolDefinition> {
  return Object.fromEntries(tools.map((t) => [t.name, t]));
}

describe("curated tool permission gating", () => {
  test("read-only tools auto-allow (no requestPermission round-trip)", async () => {
    const brain = makeEmptyBrain();
    try {
      writeFileSync(join(brain.root, "hello.md"), "# Hello\nbrain world", "utf-8");
      const turn = createTurnContext();
      const tools = toolMap(createBrainTools({ brain: createBrainAccess(brain.root), turn, writeLock: createWriteLock() }));
      const mock = makeMockBridge({ decision: { behavior: "deny", message: "should not ask" } });
      turn.bridge = mock.bridge;

      const res = await tools.read_file.execute(
        "t1",
        { path: "hello.md" },
        undefined,
        undefined,
        CTX
      );
      expect(resultText(res)).toContain("brain world");
      // Read tools must not consult the permission bridge at all.
      expect(mock.permissionCalls).toHaveLength(0);
    } finally {
      brain.cleanup();
    }
  });

  test("mutating tool awaits approval, then writes on allow", async () => {
    const brain = makeEmptyBrain();
    try {
      const turn = createTurnContext();
      const tools = toolMap(createBrainTools({ brain: createBrainAccess(brain.root), turn, writeLock: createWriteLock() }));
      const mock = makeMockBridge({ decision: { behavior: "allow" } });
      turn.bridge = mock.bridge;

      await tools.write_file.execute(
        "t2",
        { path: "note.md", content: "captured" },
        undefined,
        undefined,
        CTX
      );
      expect(mock.permissionCalls).toHaveLength(1);
      expect(mock.permissionCalls[0].toolName).toBe("write_file");
      expect(readFileSync(join(brain.root, "note.md"), "utf-8")).toBe("captured");
    } finally {
      brain.cleanup();
    }
  });

  test("denied mutation throws a tool error and does not write", async () => {
    const brain = makeEmptyBrain();
    try {
      const turn = createTurnContext();
      const tools = toolMap(createBrainTools({ brain: createBrainAccess(brain.root), turn, writeLock: createWriteLock() }));
      const mock = makeMockBridge({ decision: { behavior: "deny", message: "user said no" } });
      turn.bridge = mock.bridge;

      await expect(
        tools.write_file.execute(
          "t3",
          { path: "denied.md", content: "x" },
          undefined,
          undefined,
          CTX
        )
      ).rejects.toThrow("user said no");
      expect(mock.permissionCalls).toHaveLength(1);
      expect(existsSync(join(brain.root, "denied.md"))).toBe(false);
    } finally {
      brain.cleanup();
    }
  });

  test("host may edit the input on allow (updatedInput)", async () => {
    const brain = makeEmptyBrain();
    try {
      const turn = createTurnContext();
      const tools = toolMap(createBrainTools({ brain: createBrainAccess(brain.root), turn, writeLock: createWriteLock() }));
      const mock = makeMockBridge({
        decision: { behavior: "allow", updatedInput: { path: "edited.md", content: "override" } },
      });
      turn.bridge = mock.bridge;

      await tools.write_file.execute(
        "t4",
        { path: "original.md", content: "orig" },
        undefined,
        undefined,
        CTX
      );
      expect(existsSync(join(brain.root, "original.md"))).toBe(false);
      expect(readFileSync(join(brain.root, "edited.md"), "utf-8")).toBe("override");
    } finally {
      brain.cleanup();
    }
  });

  test("bash requires approval and runs on allow", async () => {
    const brain = makeEmptyBrain();
    try {
      const turn = createTurnContext();
      const tools = toolMap(createBrainTools({ brain: createBrainAccess(brain.root), turn, writeLock: createWriteLock() }));
      const mock = makeMockBridge({ decision: { behavior: "allow" } });
      turn.bridge = mock.bridge;

      const res = await tools.bash.execute(
        "t5",
        { command: "echo brain-kit-ok" },
        undefined,
        undefined,
        CTX
      );
      expect(mock.permissionCalls).toHaveLength(1);
      expect(resultText(res)).toContain("brain-kit-ok");
    } finally {
      brain.cleanup();
    }
  });

  test("ask_user degrades to an error when the host lacks askUser", async () => {
    const brain = makeEmptyBrain();
    try {
      const turn = createTurnContext();
      const tools = toolMap(createBrainTools({ brain: createBrainAccess(brain.root), turn, writeLock: createWriteLock() }));
      turn.bridge = makeMockBridge().bridge; // no askUser

      await expect(
        tools.ask_user.execute(
          "t6",
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

  test("risk-class table matches the registered tools", () => {
    const brain = makeEmptyBrain();
    try {
      const turn = createTurnContext();
      const tools = createBrainTools({ brain: createBrainAccess(brain.root), turn, writeLock: createWriteLock() });
      for (const t of tools) {
        expect(TOOL_RISK[t.name]).toBeDefined();
      }
      expect(TOOL_RISK.read_file).toBe("read");
      expect(TOOL_RISK.write_file).toBe("mutate");
      expect(TOOL_RISK.bash).toBe("mutate");
      expect(TOOL_RISK.brain_add).toBe("mutate");
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
      const tools = toolMap(createBrainTools({ brain: createBrainAccess(brain.root), turn, writeLock: createWriteLock() }));
      turn.bridge = makeMockBridge({ decision: { behavior: "allow" } }).bridge;

      await expect(
        tools.write_file.execute(
          "e1",
          { path: "../escape.md", content: "x" },
          undefined,
          undefined,
          CTX
        )
      ).rejects.toThrow("escapes the brain repository");
    } finally {
      brain.cleanup();
    }
  });

  test("read_file outside the repo is refused", async () => {
    const brain = makeEmptyBrain();
    try {
      const turn = createTurnContext();
      const tools = toolMap(createBrainTools({ brain: createBrainAccess(brain.root), turn, writeLock: createWriteLock() }));
      await expect(
        tools.read_file.execute(
          "e2",
          { path: "../../etc/passwd" },
          undefined,
          undefined,
          CTX
        )
      ).rejects.toThrow("escapes the brain repository");
    } finally {
      brain.cleanup();
    }
  });
});
