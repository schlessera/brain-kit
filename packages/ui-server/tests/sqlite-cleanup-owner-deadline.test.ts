import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardSqliteCleanup, openSqliteWriter } from "../src/db/write-worker.js";
import { StorageSettlementIndeterminate } from "../src/db/settlement.js";
import * as controls from "./helpers/dialogue-test-writes.js";
import { storageDeadlineClock } from "./helpers/storage-deadline-clock.js";

test("one real writer becoming idle cannot clear another writer's same-ID deadline", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-sqlite-owners-"));
  const ids: number[] = [], send = Worker.prototype.postMessage;
  const descriptor = Object.getOwnPropertyDescriptor(Worker.prototype, "postMessage")!;
  const messages = spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, ...args: [message: unknown, options?: StructuredSerializeOptions | Transferable[]]) {
    const message = args[0] as { kind?: string; name?: string; id: number };
    if (message.kind === "call" && message.name === "holdUntilReleased") ids.push(message.id);
    return Reflect.apply(send, this, args);
  });
  const owners = ["ithaca", "troy"].map(name => {
    const db = new Database(join(root, `${name}.sqlite`)), writer = openSqliteWriter(db);
    const channel = writer.channel(controls, {}), gate = new Int32Array(new SharedArrayBuffer(8));
    return { db, writer, channel, gate, release() { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); } };
  });
  let clock: ReturnType<typeof storageDeadlineClock> | undefined;
  let holds: Promise<unknown>[] = [], cleanup: Promise<void> | undefined, guarded: Promise<void> | undefined;
  try {
    await Promise.all(owners.map(owner => owner.channel.ready));
    holds = owners.map(owner => owner.channel.call("holdUntilReleased", owner.gate));
    const entered = Date.now() + 2000;
    while (owners.some(owner => !Atomics.load(owner.gate, 1))) {
      if (Date.now() > entered) throw Error("Both native writers must enter their holds");
      await Bun.sleep(1);
    }
    expect(ids, "REAL_WORKERS_HAVE_OVERLAPPING_PENDING_REQUEST_IDENTITIES").toEqual([3, 3]);
    clock = storageDeadlineClock();
    cleanup = Promise.all(holds).then(() => {});
    let settled = false, outcome: unknown;
    guarded = guardSqliteCleanup(owners.map(owner => owner.writer), cleanup)
      .catch(error => { outcome = error; }).finally(() => { settled = true; });
    // Capture the second writer's actual deadline, not whichever timer survives.
    // A shared request map clears this timer when the first writer returns and
    // leaves its own obsolete timer behind; expiring all timers hides the bug.
    const expireHeldOwner = clock.captureLatest();
    owners[0]!.release(); await holds[0];
    expect(Atomics.load(owners[1]!.gate, 0), "SECOND_NATIVE_WRITER_REMAINS_HELD").toBe(0);
    expect(settled).toBe(false);
    expireHeldOwner(); await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled, "IDLE_WRITER_CANNOT_CLEAR_OTHER_SAME_ID_STORAGE_DEADLINE").toBe(true);
    await guarded;
    expect(outcome).toBeInstanceOf(StorageSettlementIndeterminate);
    expect((outcome as StorageSettlementIndeterminate).cleanup).toBe(cleanup);
    expect(owners[1]!.db.query("SELECT 1 AS n").get(), "HELD_OWNER_READER_STAYS_OPEN").toEqual({ n: 1 });
    owners[1]!.release(); await cleanup;
  } finally {
    for (const owner of owners) owner.release();
    await Promise.allSettled(holds); await cleanup; await guarded; clock?.restore();
    for (const owner of owners) { await owner.writer.close(); owner.db.close(); }
    messages.mockRestore(); Object.defineProperty(Worker.prototype, "postMessage", descriptor);
    rmSync(root, { recursive: true, force: true });
  }
});
