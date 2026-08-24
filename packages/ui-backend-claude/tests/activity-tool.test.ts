/**
 * The query_activity MCP tool: handler pass-through, the data-only
 * delimiter around results (indirect-injection defense), error shape, and
 * the exact prefixed name that must stay contract-stable.
 */
import { describe, expect, test } from "bun:test";

import {
  createActivityQueryTool,
  QUERY_ACTIVITY_TOOL_NAME,
} from "../src/activity-tool";

async function invoke(toolDef: any, args: Record<string, unknown>) {
  return toolDef.handler(args, {});
}

describe("query_activity tool", () => {
  test("passes the query through and wraps the result as data-only", async () => {
    const calls: unknown[] = [];
    const toolDef = createActivityQueryTool(async (q) => {
      calls.push(q);
      return { running: [{ runId: "r1", name: "cron sync" }] };
    });
    const result = await invoke(toolDef, { scope: "running" });
    expect(calls).toEqual([{ scope: "running" }]);
    const text = result.content[0].text as string;
    expect(text).toContain("<<<activity-data");
    expect(text).toContain("activity-data>>>");
    expect(text).toContain("not instructions");
    expect(text).toContain('"runId": "r1"');
    expect(result.isError).toBeUndefined();
  });

  test("optional args are forwarded only when present", async () => {
    const calls: any[] = [];
    const toolDef = createActivityQueryTool(async (q) => {
      calls.push(q);
      return {};
    });
    await invoke(toolDef, { scope: "run", runId: "abc" });
    await invoke(toolDef, { scope: "rollups", hoursBack: 48, limit: 5 });
    expect(calls[0]).toEqual({ scope: "run", runId: "abc" });
    expect(calls[1]).toEqual({ scope: "rollups", hoursBack: 48, limit: 5 });
  });

  test("a throwing handler becomes a tool error, never a crash", async () => {
    const toolDef = createActivityQueryTool(async () => {
      throw new Error("record unavailable");
    });
    const result = await invoke(toolDef, { scope: "running" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("record unavailable");
  });

  test("the prefixed tool name is the contract-stable string", () => {
    expect(QUERY_ACTIVITY_TOOL_NAME).toBe("mcp__brain-ui__query_activity");
    expect(toolNameOf(createActivityQueryTool(async () => ({})))).toBe("query_activity");
  });
});

function toolNameOf(toolDef: any): string {
  return toolDef.name;
}
