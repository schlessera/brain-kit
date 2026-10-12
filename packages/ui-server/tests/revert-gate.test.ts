import { expect, test } from "bun:test";
import { createUiDb } from "../src/db/client.js";
import { createWriterGate } from "../src/brain/writer-gate.js";

test("a queued revert holds back new turns while the old turn can finish its nested shared maintenance", async () => {
  const db = createUiDb(":memory:"), gate = createWriterGate(db, "/odysseus/brain", { pollMs: 1 });
  const order: string[] = [], running = await gate.acquire("shared", "turn:odysseus");
  let exclusive: Awaited<ReturnType<typeof gate.acquire>> | undefined, later: typeof exclusive;
  try {
    const revert = gate.acquire("exclusive", "revert:ithaca", { queueTurns: true }).then(hold => { exclusive = hold; order.push("revert"); return hold; });
    const next = gate.acquire("shared", "turn:athena", { turn: true }).then(hold => { later = hold; order.push("new-turn"); return hold; });
    const maintenance = await gate.acquire("shared", "application index");
    order.push("maintenance");
    await Bun.sleep(10);
    expect(order, "REVERT_NEW_TURN_QUEUED_BEHIND_INTENT").toEqual(["maintenance"]);
    maintenance.release(); running.release();
    await revert;
    expect(order).toEqual(["maintenance", "revert"]);
    exclusive!.release(); await next;
    expect(order, "REVERT_DRAINS_OLD_TURN_BEFORE_NEW_ADMISSION").toEqual(["maintenance", "revert", "new-turn"]);
  } finally { running.release(); exclusive?.release(); later?.release(); db.close(); }
});
