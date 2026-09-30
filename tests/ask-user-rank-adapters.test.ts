import { describe, expect, test } from "bun:test";
import { createAskUserRankTool } from "../packages/ui-backend-claude/src/ask-user-rank-tool.js";
import { createPiBridgeTools } from "../packages/ui-backend-pi/src/bridge-tools.js";
import { createTurnContext } from "../packages/ui-backend-pi/src/turn-context.js";

const input = { cutoff: undefined, prompt: "Which first?", items: [{ id: "a", label: "A" }, { id: "b", label: "B" }] };
describe("rank adapters", () => {
  test("Claude and Pi both return the complete order and recompute agreement", async () => {
    const requests: unknown[] = [];
    const handler = async (_id: string, spec: unknown) => { requests.push(spec); return { order: ["b", "a"], unchanged: true }; };
    const claude = createAskUserRankTool(handler);
    const turn = createTurnContext();
    turn.bridge = { askUserRank: handler } as never;
    const pi = createPiBridgeTools({ brainPath: ".", turn }).find((tool) => tool.name === "ask_user_rank")!;
    const results = [await claude.handler(input, {} as never), await pi.execute("rank-1", input as never, undefined, undefined, {} as never)];
    for (const result of results) {
      const content = result.content.find((item) => item.type === "text")!;
      expect(content.type).toBe("text");
      expect(JSON.parse((content as { text: string }).text)).toEqual({ order: ["b", "a"], unchanged: false });
    }
    expect(requests).toEqual([input, input]);
  });
});
