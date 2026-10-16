import { StreamAdapter } from "../src/stream-adapter.js";
import type { BackendActivityEvent } from "@schlessera/brain-ui-sdk/server";
import { expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { CompletedResponseUsage } from "../src/usage.js";

type Event = Extract<SDKMessage, { type: "stream_event" }>["event"];
const start = (id: string, input = 10): Event => ({ type: "message_start", message: {
  id, model: "claude-sonnet-4-6", usage: { input_tokens: input, output_tokens: 0,
    cache_read_input_tokens: 20, cache_creation_input_tokens: 3 },
} } as Event);
const delta = (output: number): Event => ({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null },
  usage: { output_tokens: output } } as Event);
const stop: Event = { type: "message_stop" };

test("completed receipts replace cumulative deltas, count each response once and clear a new request's boundary", () => {
  const usage = new CompletedResponseUsage();
  expect(usage.observe(start("first"))).toBeUndefined();
  expect(usage.observe(delta(2))).toBeUndefined();
  expect(usage.observe(delta(5))).toBeUndefined();
  expect(usage.observe(stop)).toMatchObject({ atToolBoundary: true,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheCreationTokens: 3 } });
  expect(usage.observe(start("first"))).toMatchObject({ atToolBoundary: false });
  usage.observe(delta(5));
  expect(usage.observe(stop)).toBeUndefined();
  expect(usage.observe(start("second"))).toMatchObject({ atToolBoundary: false });
  usage.observe(delta(7));
  expect(usage.observe(stop)).toMatchObject({ usage: { inputTokens: 20, outputTokens: 12, cacheReadTokens: 40, cacheCreationTokens: 6 } });
  expect(usage.observe(start("unfinished"))).toMatchObject({ atToolBoundary: false,
    usage: { inputTokens: 20, outputTokens: 12 } });
  // No stop: this request's tokens are deliberately outside the lower bound.
  expect(usage.observe(delta(100))).toBeUndefined();
});

test("invalid completed token counts cannot claim a free or negative response", () => {
  const usage = new CompletedResponseUsage();
  usage.observe(start("invalid", -1)); usage.observe(delta(0));
  expect(usage.observe(stop)).toBeUndefined();
});


test("ordinary Claude streams deliver completed general usage with all token classes once", () => {
  const events: BackendActivityEvent[] = [];
  const adapter = new StreamAdapter(event => events.push(event));
  const frame = (event: Event) => adapter.adapt({ type: "stream_event", event } as SDKMessage);
  frame(start("odysseus-response")); frame(delta(2)); frame(delta(5));
  expect(events.filter(event => String(event.kind) === "usage")).toEqual([]);
  frame(stop);
  expect(events.filter(event => String(event.kind) === "usage"), "BUDGET_CLAUDE_GENERAL_COMPLETED_RECEIPT").toEqual([
    expect.objectContaining({ kind: "usage", atToolBoundary: true,
      usage: expect.objectContaining({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheCreationTokens: 3 }) }),
  ]);
  frame(start("odysseus-response")); frame(delta(5)); frame(stop);
  const receipts = events.filter(event => String(event.kind) === "usage");
  expect(receipts.at(-1)).toMatchObject({ usage: { inputTokens: 10, outputTokens: 5 } });
  expect(events.filter(event => event.kind === "autonomous_usage")).toEqual([]);
});

test("ordinary Claude interleaves root and child completed inference without exposing child text",()=>{
  const events:BackendActivityEvent[]=[],adapter=new StreamAdapter(event=>events.push(event));
  const frame=(event:Event,parent:string|null=null)=>adapter.adapt({type:"stream_event",event,parent_tool_use_id:parent} as SDKMessage);
  frame(start("root",10));frame(start("child",2),"loom");frame(delta(1),"loom");frame(stop,"loom");frame(delta(5));frame(stop);
  const receipt=events.filter(event=>event.kind==="usage").at(-1);
  expect(receipt).toMatchObject({usage:{inputTokens:12,outputTokens:6,cacheReadTokens:40,cacheCreationTokens:6}});
  expect(frame({type:"content_block_delta",delta:{type:"text_delta",text:"child-private-text"},index:0} as Event,"loom")).toEqual([]);
});

test("resumed result keeps only this turn including child receipts and no cumulative cost", () => {
  const events: BackendActivityEvent[] = [], adapter = new StreamAdapter(event => events.push(event));
  const frame = (event: Event, parent: string | null = null) => adapter.adapt({ type: "stream_event", event, parent_tool_use_id: parent } as SDKMessage);
  frame(start("current-root", 10)); frame(delta(5)); frame(stop);
  frame(start("current-child", 2), "loom"); frame(delta(1), "loom"); frame(stop, "loom");
  // A duplicate child receipt is not another invocation.
  frame(start("current-child", 2), "loom"); frame(delta(1), "loom"); frame(stop, "loom");
  const result = adapter.adapt({ type: "result", subtype: "success", is_error: false, session_id: "odysseus-session",
    total_cost_usd: 7, duration_ms: 1, num_turns: 1,
    modelUsage: { "claude-sonnet-4-6": { inputTokens: 1200, outputTokens: 600, cacheReadInputTokens: 4000, cacheCreationInputTokens: 600 } },
  } as unknown as SDKMessage).find(message => message.type === "result");
  expect(result, "RESUMED_RESULT_OWN_TOKENS").toMatchObject({ usage: { inputTokens: 12, outputTokens: 6, cacheReadTokens: 40, cacheCreationTokens: 6 } });
  expect(result?.costUsd, "CUMULATIVE_COST_IS_NOT_A_TURN_COST").toBeUndefined();
  expect(events.at(-1)).toMatchObject({ kind: "claude_session_usage", cumulative: { inputTokens: 1200 }, completed: { inputTokens: 12 } });
});
