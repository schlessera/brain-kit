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
    // The delimiter carries a per-call nonce; open and close must share it,
    // so embedded content can never terminate the block.
    const open = text.match(/^<<<activity-data-([0-9a-f-]+)$/m);
    expect(open).not.toBeNull();
    const nonce = open![1]!;
    expect(text).toContain(`activity-data-${nonce}>>>`);
    expect(text).toContain("not instructions");
    expect(text).toContain('"runId": "r1"');
    expect(result.isError).toBeUndefined();
  });

  test("the nonce differs per call, so a replayed delimiter cannot match", async () => {
    const toolDef = createActivityQueryTool(async () => ({}));
    const nonceOf = (text: string) => text.match(/<<<activity-data-([0-9a-f-]+)/)![1];
    const a = nonceOf((await invoke(toolDef, { scope: "running" })).content[0].text);
    const b = nonceOf((await invoke(toolDef, { scope: "running" })).content[0].text);
    expect(a).not.toBe(b);
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

  test("scope=inbox passes through to the handler like any other scope", async () => {
    const calls: unknown[] = [];
    const toolDef = createActivityQueryTool(async (q) => {
      calls.push(q);
      return { intents: [{ kind: "failure", title: "sync failed" }] };
    });
    const result = await invoke(toolDef, { scope: "inbox" });
    expect(calls).toEqual([{ scope: "inbox" }]);
    expect(result.content[0].text).toContain('"kind": "failure"');
    expect(result.isError).toBeUndefined();
  });

  test("a throwing handler becomes a tool error, never a crash", async () => {
    const toolDef = createActivityQueryTool(async () => {
      throw new Error("record unavailable");
    });
    const result = await invoke(toolDef, { scope: "running" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("record unavailable");
  });

  test("the description documents the dual cost numbers and NULL semantics", () => {
    const description = (createActivityQueryTool(async () => ({})) as any)
      .description as string;
    expect(description).toContain("costUsd");
    expect(description).toContain("effectiveCostUsd");
    expect(description).toContain("unpricedRuns");
    // The load-bearing sentence: null is unknown, never zero.
    expect(description).toContain("null");
    expect(description.toLowerCase()).toContain("never");
  });

  test("explicit null cost fields reach the data block verbatim, not omitted", async () => {
    const toolDef = createActivityQueryTool(async () => ({
      finished: [{ runId: "r1", costUsd: null, effectiveCostUsd: null, billingMode: null }],
    }));
    const text = (await invoke(toolDef, { scope: "recent" })).content[0].text as string;
    expect(text).toContain('"effectiveCostUsd": null');
    expect(text).toContain('"billingMode": null');
  });

  test("the prefixed tool name is the contract-stable string", () => {
    expect(QUERY_ACTIVITY_TOOL_NAME).toBe("mcp__brain-ui__query_activity");
    expect(toolNameOf(createActivityQueryTool(async () => ({})))).toBe("query_activity");
  });
});

function toolNameOf(toolDef: any): string {
  return toolDef.name;
}
