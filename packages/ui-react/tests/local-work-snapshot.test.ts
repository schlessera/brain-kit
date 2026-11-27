import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createBrainUiRoot, type BrainUiRoot } from "../src/root.js";
import { createLocalWork, type LocalWork } from "../src/lib/local-work.js";
import type { LocalPartitions, PartitionWrite } from "../src/lib/local-partitions.js";

// What one device snapshot costs (#4746): a draft object already written is
// not serialized again, and a snapshot that moves only the work context is
// written without reading the stored drafts. Keyless: a root without a host,
// a structural partitions double (the non-browser lock path), and Odysseus's
// drafts.

const SCOPE = "root:snapshot";
const roots: BrainUiRoot[] = [];
const works: LocalWork[] = [];
afterEach(() => {
  for (const w of works.splice(0)) w.dispose();
  for (const r of roots.splice(0)) r.dispose();
});

type Mutate = { puts: string[]; deletes: string[] };

function partitionsDouble(seed: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(seed).map(([k, v]) => [k, structuredClone(v)]));
  const calls = { write: 0, mutate: [] as Mutate[] };
  let gate: Promise<void> | null = null;
  let refuse: ((changes: readonly PartitionWrite[]) => boolean) | null = null;
  const apply = (changes: readonly PartitionWrite[]) => {
    for (const c of changes) {
      if ("put" in c) data.set(c.put, structuredClone(c.value));
      else data.delete(c.delete);
    }
  };
  const rows = (prefix: string) => [...data].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) }));
  const handle = {
    id: "account:odysseus",
    async get(key: string) { return structuredClone(data.get(key)); },
    async list(prefix: string) { return rows(prefix); },
    async put(key: string, value: unknown) { calls.write++; apply([{ put: key, value }]); },
    async write(changes: readonly PartitionWrite[]) { calls.write++; apply(changes); },
    async mutate<T>(prefix: string, update: (rows: Array<{ key: string; value: unknown }>) => { changes: readonly PartitionWrite[]; result: T }) {
      const { changes, result } = update(rows(prefix));
      if (refuse?.(changes)) { refuse = null; throw new DOMException("The device refused the write", "UnknownError"); }
      const open = gate;
      if (open) { gate = null; await open; }
      calls.mutate.push({ puts: changes.flatMap((c) => ("put" in c ? [c.put] : [])), deletes: changes.flatMap((c) => ("delete" in c ? [c.delete] : [])) });
      apply(changes);
      return result;
    },
  };
  const partitions = { open: () => handle } as unknown as LocalPartitions;
  return {
    data, calls, partitions,
    /** Holds the next mutate after its callback ran, until the returned function is called. */
    /** Refuses the next mutate whose planned changes match, once. */
    refuseNextMutate(match: (changes: readonly PartitionWrite[]) => boolean) { refuse = match; },
    holdNextMutate() { let release!: () => void; gate = new Promise<void>((r) => { release = r; }); return release; },
  };
}

async function harness(seed?: Record<string, unknown>) {
  const r = createBrainUiRoot({ storage: null, request: async () => Response.json({ error: "not found" }, { status: 404 }) });
  roots.push(r);
  r.stores.connection.setState({ accountKey: "odysseus" });
  const double = partitionsDouble(seed);
  const work = createLocalWork({ stores: r.stores, partitions: double.partitions, scope: SCOPE, tracks: () => [], watchTracks: () => () => {} });
  works.push(work);
  await work.restoring();
  return { r, work, ...double };
}

/** Counts JSON.stringify calls on a stored draft record, by draft id. */
function serializations() {
  const counts = new Map<string, number>();
  const real = JSON.stringify;
  const spy = spyOn(JSON, "stringify").mockImplementation(((value: unknown, ...rest: unknown[]) => {
    const v = value as { v?: unknown; draftId?: unknown; attachments?: unknown } | null;
    if (v && typeof v === "object" && v.v === 1 && typeof v.draftId === "string" && Array.isArray(v.attachments)) counts.set(v.draftId, (counts.get(v.draftId) ?? 0) + 1);
    return (real as (...args: unknown[]) => string)(value, ...rest);
  }) as typeof JSON.stringify);
  return { of: (id: string) => counts.get(id) ?? 0, reset: () => counts.clear(), restore: () => spy.mockRestore() };
}

const draftKey = (id: string) => `${SCOPE}/draft/${id}`;

describe("a device snapshot", () => {
  test("serializes only the draft that was edited; an unchanged draft object is not serialized again", async () => {
    const { r, work, data } = await harness();
    const drafts = r.stores.drafts.getState();
    const a = drafts.idFor("odysseus-sirens"), b = drafts.idFor("odysseus-cyclops");
    drafts.edit(a, "odysseus-sirens", { text: "Wax for the crew" });
    drafts.edit(b, "odysseus-cyclops", { text: "Nobody is my name" });
    await work.snapshotNow();
    expect((data.get(draftKey(b)) as { text: string }).text).toBe("Nobody is my name");
    const count = serializations();
    try {
      r.stores.drafts.getState().edit(a, "odysseus-sirens", { text: "Wax for the crew, rope for me" });
      await work.snapshotNow();
      expect(count.of(b)).toBe(0);
      expect(count.of(a)).toBeGreaterThan(0);
    } finally {
      count.restore();
    }
    expect((data.get(draftKey(a)) as { text: string }).text).toBe("Wax for the crew, rope for me");
  });

  test("a change to the work context alone is written with write, reading and serializing no draft", async () => {
    const { r, work, calls } = await harness();
    const drafts = r.stores.drafts.getState();
    const a = drafts.idFor("odysseus-sirens");
    drafts.edit(a, "odysseus-sirens", { text: "Wax for the crew" });
    await work.snapshotNow();
    const before = { write: calls.write, mutate: calls.mutate.length };
    const count = serializations();
    try {
      r.stores.voice.getState().setReviewText("Bind me to the mast");
      await work.snapshotNow();
      expect(count.of(a)).toBe(0);
    } finally {
      count.restore();
    }
    expect(calls.mutate.length - before.mutate).toBe(0);
    expect(calls.write - before.write).toBe(1);
  });

  test("a draft read back from the device is compared by content on its first snapshot", async () => {
    const id = "draft-ithaca";
    const stored = { v: 1, draftId: id, sessionId: "odysseus-ithaca", text: "Home at last", attachments: [], editedAt: 1, host: null, deviceRevision: 3 };
    const { r, work, data } = await harness({ [draftKey(id)]: stored });
    expect(r.stores.drafts.getState().drafts[id]?.text).toBe("Home at last");
    const count = serializations();
    try {
      r.stores.voice.getState().setReviewText("Penelope waits");
      await work.snapshotNow();
      expect(count.of(id)).toBeGreaterThan(0);
      expect((data.get(draftKey(id)) as { text: string }).text).toBe("Home at last");
      // Written from this object now: the next snapshot does not serialize it.
      count.reset();
      r.stores.voice.getState().setReviewText("Penelope weaves");
      await work.snapshotNow();
      expect(count.of(id)).toBe(0);
    } finally {
      count.restore();
    }
  });

  test("a draft edited while a snapshot commits is written by the next one", async () => {
    const { r, work, data, holdNextMutate } = await harness();
    const drafts = r.stores.drafts.getState();
    const a = drafts.idFor("odysseus-sirens");
    drafts.edit(a, "odysseus-sirens", { text: "Row" });
    const release = holdNextMutate();
    const snapshot = work.snapshotNow();
    await Bun.sleep(0);
    r.stores.drafts.getState().edit(a, "odysseus-sirens", { text: "Row past the Sirens" });
    release();
    await snapshot;
    await work.snapshotNow();
    expect((data.get(draftKey(a)) as { text: string }).text).toBe("Row past the Sirens");
  });

  test("an accepted transcript writes its draft record and its receipt in one mutate", async () => {
    const { r, work, calls, data } = await harness();
    const drafts = r.stores.drafts.getState();
    const a = drafts.idFor("odysseus-sirens");
    drafts.edit(a, "odysseus-sirens", { text: "Notes:" });
    await work.snapshotNow();
    calls.mutate.length = 0;
    await work.addTranscript("rec-sirens", "The song was sweet", a, "odysseus-sirens");
    const withReceipt = calls.mutate.filter((m) => m.puts.includes("recording:accepted:rec-sirens"));
    expect(withReceipt.length).toBeGreaterThan(0);
    for (const m of withReceipt) expect(m.puts).toContain(draftKey(a));
    expect((data.get("recording:accepted:rec-sirens") as { finalized: boolean }).finalized).toBe(true);
    expect((data.get(draftKey(a)) as { text: string }).text).toContain("The song was sweet");
  });

  test("a retried acceptance whose draft object was already written still writes the record with its receipt", async () => {
    const { r, work, calls, data, refuseNextMutate } = await harness();
    const drafts = r.stores.drafts.getState();
    const a = drafts.idFor("odysseus-sirens");
    drafts.edit(a, "odysseus-sirens", { text: "Notes:" });
    await work.snapshotNow();
    const finalizing = (changes: readonly PartitionWrite[]) =>
      changes.some((c) => "put" in c && c.put === "recording:accepted:rec-sirens" && (c.value as { finalized?: boolean }).finalized === true);
    refuseNextMutate(finalizing);
    await expect(work.addTranscript("rec-sirens", "The song was sweet", a, "odysseus-sirens")).rejects.toThrow();
    expect((data.get("recording:accepted:rec-sirens") as { finalized: boolean }).finalized).toBe(false);
    // An ordinary snapshot writes the live draft: the retry finalizes with that same object.
    await work.snapshotNow();
    const live = r.stores.drafts.getState().drafts[a];
    expect((data.get(draftKey(a)) as { text: string }).text).toBe(live!.text);
    calls.mutate.length = 0;
    await work.addTranscript("rec-sirens", "The song was sweet", a, "odysseus-sirens");
    expect(r.stores.drafts.getState().drafts[a]).toBe(live);
    const final = calls.mutate.filter((m) => m.puts.includes("recording:accepted:rec-sirens"));
    expect(final).toHaveLength(1);
    expect(final[0]!.puts).toContain(draftKey(a));
    expect((data.get("recording:accepted:rec-sirens") as { finalized: boolean }).finalized).toBe(true);
  });
});
