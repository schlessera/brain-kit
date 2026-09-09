import { describe, expect, test } from "bun:test";

import {
  createToolPermissionRequest,
  decideToolPermission,
  requestToolPermission,
} from "../src/server/permission-gate";

const confirmPatterns = [/\brm\s+-rf\b/i];
const allowedTools: ReadonlySet<string> = new Set(["bash", "read_file"]);

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
