/** Actual manager/store regression, run in the owned offline native fixture. */
import { expect, spyOn } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { createNativeBrainManager } from "../../packages/ui-sdk/src/server/native-brain-manager";
import { createNativeBrainManagerClient } from "../../packages/ui-sdk/src/server/native-brain-manager-client";
import { NativeRecoveryIndex } from "../../packages/ui-sdk/src/server/native-recovery-index";
import type { Database } from "bun:sqlite";

export async function proveRecoveryInventory(artifacts: string): Promise<void> {
  const brain = "/brain-fixture/brain", state = "/brain-fixture/.brain-native/state";
  const show = Bun.spawnSync(["/usr/bin/btrfs", "subvolume", "show", brain]);
  expect(show.exitCode, show.stderr.toString()).toBe(0);
  const brainUuid = /^\s*UUID:\s*([0-9a-f-]+)/m.exec(show.stdout.toString())![1]!.replaceAll("-", "");
  const superblock = Bun.spawnSync(["/usr/bin/btrfs", "inspect-internal", "dump-super", "/dev/brain-native-proof-loop"]);
  expect(superblock.exitCode, superblock.stderr.toString()).toBe(0);
  const fsid = /^fsid\s+([0-9a-f-]+)/m.exec(superblock.stdout.toString())![1]!;
  const config = { storePath: "/brain-fixture", devicePath: "/dev/brain-native-proof-loop", fsid, brainUuid,
    socketPath: "/native-runtime/recovery-inventory.sock", appGid: 1000,
    capacityBytes: 4 * 1024 ** 3, recoveryReserveBytes: 16 * 1024 ** 2 };
  const id = (n: number) => `17920000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const rows: { total: number; startupMs: number; pageMs: number; count: number; enumerated: number; intentReads: number; metadataBytes: number; indexPageBytes: number }[] = [];
  let seeded = 0;
  for (const total of [0, 1000, 10000]) {
    for (; seeded < total; seeded++) fs.writeFileSync(join(state, `${id(seeded + 1)}.json`),
      JSON.stringify({ version: 1, id: id(seeded + 1), sourceUuid: brainUuid, state: "deleted" }), { mode: 0o600 });
    const start = performance.now();
    const manager = await createNativeBrainManager(config);
    const startupMs = performance.now() - start;
    let enumerated = 0, intentReads = 0;
    let indexAllocation = () => 0;
    const page = NativeRecoveryIndex.prototype.page;
    const pageObserver = spyOn(NativeRecoveryIndex.prototype, "page").mockImplementation(function(this: NativeRecoveryIndex, after: string | null) {
      indexAllocation = () => {
        const db = (this as unknown as { db: Database }).db;
        return db.query<{ page_count: number }, []>("PRAGMA page_count").get()!.page_count *
          db.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size;
      };
      return page.call(this, after);
    });
    const readdir = fs.readdirSync, read = fs.readFileSync;
    const directories = spyOn(fs, "readdirSync").mockImplementation(((...args: Parameters<typeof fs.readdirSync>) => {
      const result = Reflect.apply(readdir, fs, args);
      if (String(args[0]) === state) enumerated += result.length;
      return result;
    }) as typeof fs.readdirSync);
    const reads = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (typeof args[0] === "number") {
        try { if (fs.readlinkSync(`/proc/self/fd/${args[0]}`).startsWith(state + "/")) intentReads++; } catch { /* Other owned descriptors. */ }
      }
      return Reflect.apply(read, fs, args);
    }) as typeof fs.readFileSync);
    let elapsedMs = 0, count = 0;
    try {
      const at = performance.now();
      const result = await (await manager.run({ operation: "listRecovery", after: id(0) })).json() as { records: { id: string }[]; next: string | null };
      elapsedMs = performance.now() - at; count = result.records.length;
      // Earlier hosted controls retain their own deleted identities as well.
      expect(count).toBeLessThanOrEqual(64);
      if (total) expect(result.records.map(row => row.id)).toEqual(Array.from({ length: 64 }, (_, i) => id(i + 1)));
      expect(intentReads, "NATIVE_RECOVERY_PAGE_READS_AT_MOST_64_INTENTS").toBeLessThanOrEqual(64);
    } finally {
      reads.mockRestore(); directories.mockRestore();
      try {
        const entries = fs.readdirSync(state).filter(name => name.startsWith("17920000-"));
        const metadataBytes = entries.reduce((bytes, name) => bytes + fs.statSync(join(state, name)).blocks * 512, 0);
        // Observe actual SQLite allocation without adding a broker/public API.
        const indexPageBytes = indexAllocation();
        rows.push({ total, startupMs, pageMs: elapsedMs, count, enumerated, intentReads, metadataBytes, indexPageBytes });
        fs.writeFileSync(join(artifacts, "recovery-inventory.json"), JSON.stringify(rows, null, 2));
      } finally { pageObserver.mockRestore(); await manager.close(); }
    }
  }
  expect(rows.map(row => row.enumerated), "NATIVE_RECOVERY_PAGE_DOES_NOT_ENUMERATE_HISTORY").toEqual([0, 0, 0]);

  const failedId = id(100001), lostId = id(100002);
  let manager = await createNativeBrainManager(config);
  const remember = NativeRecoveryIndex.prototype.remember;
  // A real SQLite write failure AFTER the production JSON rename/fsync.
  // Reading the surviving JSON is not a substitute for the restart below.
  const failedWrite = spyOn(NativeRecoveryIndex.prototype, "remember").mockImplementation(function(this: NativeRecoveryIndex, value: string) {
    if (value === failedId) (this as unknown as { db: Database }).db.exec("PRAGMA query_only = ON");
    return remember.call(this, value);
  });
  try {
    await expect(manager.run({ operation: "release", id: failedId }), "NATIVE_RECOVERY_INTERRUPTED_INDEX_OUTCOME_UNKNOWN").rejects.toThrow("indexing failed");
    expect(JSON.parse(fs.readFileSync(join(state, `${failedId}.json`), "utf8")).state).toBe("deleted");
    await expect(manager.run({ operation: "listRecovery", after: id(100000) }), "NATIVE_RECOVERY_POISONED_INDEX_REFUSES_PARTIAL_PAGE").rejects.toThrow("restart");
  } finally { failedWrite.mockRestore(); await manager.close(); }
  manager = await createNativeBrainManager(config);
  try {
    const rebuilt = await (await manager.run({ operation: "listRecovery", after: id(100000) })).json() as { records: { id: string }[] };
    expect(rebuilt.records.some(row => row.id === failedId), "NATIVE_RECOVERY_RESTART_REBUILDS_DURABLE_UNINDEXED_INTENT").toBe(true);
    await expect(manager.run({ operation: "checkpoint", id: failedId }), "NATIVE_RECOVERY_DELETED_ID_STILL_FENCES_DELAYED_CREATE").rejects.toThrow("cannot be recreated");
    let committed!: () => void, reply!: () => void;
    const durable = new Promise<void>(done => { committed = done; }), withheld = new Promise<void>(done => { reply = done; });
    const socketPath = "/native-runtime/recovery-lost-reply.sock";
    const transport = Bun.serve({ unix: socketPath, async fetch(request) {
      const result = await manager.run(await request.json()); committed(); await withheld; return result;
    } });
    try {
      const controller = new AbortController();
      const pending = createNativeBrainManagerClient({ socketPath }).release(lostId, controller.signal);
      await Promise.race([durable, pending.then(() => { throw Error("Lost-reply fixture unexpectedly replied"); })]);
      controller.abort(new Error("Odysseus lost the release reply"));
      await expect(pending, "NATIVE_RECOVERY_LOST_RELEASE_REPLY_REMAINS_UNKNOWN").rejects.toMatchObject({ code: "unknown" });
    } finally { reply(); transport.stop(true); }
  } finally { await manager.close(); }
  manager = await createNativeBrainManager(config);
  try {
    await expect(manager.run({ operation: "checkpoint", id: lostId }), "NATIVE_RECOVERY_RESTART_FENCES_LOST_REPLY_ID").rejects.toThrow("cannot be recreated");
    const page = await (await manager.run({ operation: "listRecovery", after: id(100000) })).json() as { records: { id: string; state: string }[] };
    expect(page.records.filter(row => [failedId, lostId].includes(row.id))).toEqual([{ id: failedId, state: "deleted" }, { id: lostId, state: "deleted" }]);
  } finally { await manager.close(); }
}
