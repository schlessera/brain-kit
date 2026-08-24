/** The subagent drill-in stack: push nests, pop unwinds, empty pop is a no-op. */
import { beforeEach, describe, expect, test } from "bun:test";

import { useUIStore } from "../src/stores/ui-store";

beforeEach(() => {
  useUIStore.setState({ subagentStack: [] });
});

describe("subagentStack", () => {
  test("push nests drill-ins in order", () => {
    const s = useUIStore.getState();
    s.pushSubagentView("agent-1");
    s.pushSubagentView("sub-a");
    expect(useUIStore.getState().subagentStack).toEqual(["agent-1", "sub-a"]);
  });

  test("pop unwinds one level at a time", () => {
    const s = useUIStore.getState();
    s.pushSubagentView("agent-1");
    s.pushSubagentView("sub-a");
    s.popSubagentView();
    expect(useUIStore.getState().subagentStack).toEqual(["agent-1"]);
    s.popSubagentView();
    expect(useUIStore.getState().subagentStack).toEqual([]);
  });

  test("pop on an empty stack stays empty", () => {
    useUIStore.getState().popSubagentView();
    expect(useUIStore.getState().subagentStack).toEqual([]);
  });
});
