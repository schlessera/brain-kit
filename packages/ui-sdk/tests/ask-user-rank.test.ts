import { describe, expect, test } from "bun:test";
import { handleAskUserRank } from "../src/server/bridge-tools/index";
import { ASK_USER_RANK_INPUT_SCHEMA } from "../src/tool-contracts/index";
import type { BackendBridge, AskUserRankResult } from "../src/server/backend";

const INPUT = { prompt: "Which first?", items: Array.from({ length: 6 }, (_, i) => ({ id: `id-${i}`, label: `Journey ${i}` })) };
const IDS = INPUT.items.map((i) => i.id);
function host(result: AskUserRankResult) {
  const calls: unknown[] = [];
  const bridge = { askUserRank: async (id: string, spec: unknown) => { calls.push({ id, spec }); return result; } } as BackendBridge;
  return { calls, bridge };
}
describe("ask_user_rank", () => {
  test("one call returns all six ids and derives unchanged from order equality", async () => {
    expect(INPUT.items.length).toBe(6);
    const order = [...IDS].reverse();
    const h = host({ order, unchanged: true });
    expect(await handleAskUserRank(INPUT, h.bridge, "rank-1")).toEqual({ order, unchanged: false });
    expect(h.calls).toEqual([{ id: "rank-1", spec: INPUT }]);
    expect(await handleAskUserRank(INPUT, host({ order: IDS, unchanged: false }).bridge)).toEqual({ order: IDS, unchanged: true });
  });
  test("rejects duplicate item ids before calling the host", async () => {
    const h = host({ order: IDS, unchanged: false });
    await expect(handleAskUserRank({ ...INPUT, items: [INPUT.items[0]!, INPUT.items[0]!] }, h.bridge)).rejects.toThrow("unique");
    expect(h.calls).toHaveLength(0);
  });
  test("rejects cutoff past the list before calling the host", async () => {
    const h = host({ order: IDS, unchanged: false });
    await expect(handleAskUserRank({ ...INPUT, cutoff: 7 }, h.bridge)).rejects.toThrow("cutoff");
    expect(h.calls).toHaveLength(0);
  });
  test("refuses missing, extra, repeated or unknown ids instead of inventing an order", async () => {
    for (const order of [IDS.slice(1), [...IDS, "extra"], [...IDS.slice(1), IDS[1]!], [...IDS.slice(1), "unknown"]]) {
      await expect(handleAskUserRank(INPUT, host({ order, unchanged: false }).bridge)).rejects.toThrow("permutation");
    }
  });
  test("cutoff retains every id", async () => {
    const h = host({ order: [...IDS].reverse(), unchanged: false });
    expect((await handleAskUserRank({ ...INPUT, cutoff: 3 }, h.bridge)).order).toHaveLength(6);
  });
  test("schema bounds and absent host", async () => {
    expect(ASK_USER_RANK_INPUT_SCHEMA.safeParse({ ...INPUT, items: [INPUT.items[0]] }).success).toBe(false);
    expect(ASK_USER_RANK_INPUT_SCHEMA.safeParse({ ...INPUT, cutoff: 1.5 }).success).toBe(false);
    await expect(handleAskUserRank(INPUT, {} as BackendBridge)).rejects.toThrow("does not support");
  });
});
