/** Span display labels: only a real Agent tool call reads "Agent". */
import { describe, expect, test } from "bun:test";
import type { ActivitySpan } from "@schlessera/brain-ui-sdk/protocol";

import { spanToolLabel } from "../src/components/activity/span-bits";

function span(overrides: Partial<ActivitySpan>): ActivitySpan {
  return {
    spanId: "s1",
    runId: "r1",
    name: "execute_tool Read",
    kind: "tool",
    origin: "session",
    startedAt: 100,
    ...overrides,
  };
}

describe("spanToolLabel", () => {
  test("prefers the server-lifted toolName", () => {
    expect(spanToolLabel(span({ toolName: "Agent", kind: "subagent" }))).toBe("Agent");
    expect(spanToolLabel(span({ toolName: "mcp__brain-ui__get_current_location" }))).toBe(
      "get_current_location"
    );
  });

  test("a subagent span named by convention still reads Agent", () => {
    expect(spanToolLabel(span({ name: "execute_tool Agent", kind: "subagent" }))).toBe("Agent");
  });

  test("a turn root named invoke_agent is a Turn, not an Agent", () => {
    expect(spanToolLabel(span({ name: "invoke_agent", kind: "turn" }))).toBe("Turn");
  });

  test("a cron root labels by its job name, falling back to the span name", () => {
    expect(
      spanToolLabel(span({ name: "cron daily-digest", kind: "cron", jobName: "daily-digest" }))
    ).toBe("daily-digest");
    expect(spanToolLabel(span({ name: "cron run", kind: "cron" }))).toBe("cron run");
  });

  test("legacy tool spans un-parse the execute_tool convention", () => {
    expect(spanToolLabel(span({ name: "execute_tool Read" }))).toBe("Read");
  });
});
