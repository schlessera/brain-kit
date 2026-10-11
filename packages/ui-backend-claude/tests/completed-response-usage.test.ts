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
