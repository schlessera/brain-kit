/**
 * Span display labels (only a real Agent tool call reads "Agent") and the
 * shared cost glyphs (unknown is never $0.00 — AE3).
 */
import { describe, expect, test } from "bun:test";
import type { ActivitySpan } from "@schlessera/brain-ui-sdk/protocol";

import {
  digestCostClause,
  formatAggregateCost,
  formatEffectiveCost,
  spanToolLabel,
} from "../src/components/activity/span-bits";

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

describe("formatEffectiveCost", () => {
  test("unknown cost renders an em dash, NEVER $0.00 (AE3)", () => {
    expect(formatEffectiveCost(null)).toBe("—");
    expect(formatEffectiveCost(undefined)).toBe("—");
    expect(formatEffectiveCost(null)).not.toContain("$");
  });

  test("zero is genuinely free, distinct from unknown", () => {
    expect(formatEffectiveCost(0)).toBe("free");
  });

  test("priced runs render dollars", () => {
    expect(formatEffectiveCost(1.234)).toBe("$1.23");
    expect(formatEffectiveCost(0.05)).toBe("$0.05");
  });

  test("estimated rates prefix ~", () => {
    expect(formatEffectiveCost(0.5, true)).toBe("~$0.50");
  });

  test("the estimate flag never decorates unknown or free", () => {
    expect(formatEffectiveCost(null, true)).toBe("—");
    expect(formatEffectiveCost(0, true)).toBe("free");
  });

  test("a sub-cent cost floors at <$0.01 instead of rounding to a zero look-alike", () => {
    expect(formatEffectiveCost(0.004)).toBe("<$0.01");
  });
});

describe("formatAggregateCost", () => {
  test("a fully priced sum renders plainly", () => {
    expect(formatAggregateCost(2.5, 0)).toBe("$2.50");
  });

  test("unpriced runs turn the sum into a floor (≥ form)", () => {
    expect(formatAggregateCost(2.5, 3)).toBe("≥ $2.50");
  });
});

describe("digestCostClause", () => {
  test("priced window with no unknowns", () => {
    expect(digestCostClause({ costUsd: 2, effectiveCostUsd: 1.5, unpricedRuns: 0 })).toBe(
      "$1.50 spent"
    );
  });

  test("unpriced runs fold into the clause as a floor", () => {
    expect(digestCostClause({ costUsd: 2, effectiveCostUsd: 1.5, unpricedRuns: 3 })).toBe(
      "≥ $1.50 spent (3 unpriced)"
    );
  });

  test("known-zero spend says free instead of staying silent", () => {
    expect(digestCostClause({ costUsd: 2, effectiveCostUsd: 0, unpricedRuns: 0 })).toBe("free");
  });

  test("all-unknown window names the unknowns, never $0.00", () => {
    expect(digestCostClause({ costUsd: 0, effectiveCostUsd: 0, unpricedRuns: 4 })).toBe(
      "4 unpriced"
    );
  });

  test("a pre-pricing digest keeps the old list-cost clause", () => {
    expect(digestCostClause({ costUsd: 2 })).toBe("$2.00 spent");
    expect(digestCostClause({ costUsd: 0 })).toBeNull();
  });
});
