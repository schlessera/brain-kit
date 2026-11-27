import { describe, expect, test } from "bun:test";
import type { DraftSnapshot, DraftSnapshotWrite } from "@schlessera/brain-ui-sdk/protocol";

import { DraftError } from "../src/drafts/errors";
import { legacyOutgoing, nextSnapshots, snapshotFiles } from "../src/drafts/snapshot-list";

// The outgoing-snapshot transition rules (#3588) as a pure function (#4817):
// no database, no principal, no store. Odysseus fixtures only.

const AT = 1_752_278_400_000;
const stored = (n: number, state: DraftSnapshot["state"], fileIds: string[] = []): DraftSnapshot =>
  ({ snapshotId: `snap-${n}`, requestId: `request-${n}`, text: `Message ${n} to Ithaca`, fileIds, state, createdAt: AT - n });
const write = (snapshot: DraftSnapshot, change: Partial<DraftSnapshotWrite> = {}): DraftSnapshotWrite => {
  const { createdAt: _createdAt, ...rest } = snapshot;
  return { ...rest, ...change };
};
const fresh = (n: number, state: DraftSnapshotWrite["state"] = "held", fileIds: string[] = []): DraftSnapshotWrite =>
  ({ snapshotId: `snap-${n}`, requestId: `request-${n}`, text: `Message ${n} to Ithaca`, fileIds, state });

function refusal(fn: () => unknown): DraftError {
  try { fn(); } catch (error) { if (error instanceof DraftError) return error; throw error; }
  throw new Error("expected a DraftError");
}

describe("nextSnapshots refuses", () => {
  const held = stored(1, "held", ["file-oar"]);
  const dispatched = stored(2, "dispatched");
  const returned = stored(3, "returned");
  const cases: Array<{ name: string; list: DraftSnapshot[]; input: Parameters<typeof nextSnapshots>[1]; message: string }> = [
    { name: "both outgoing and snapshots", list: [], message: "Send either outgoing or snapshots, not both.",
      input: { outgoing: { requestId: "request-9", text: "Hold the mast", fileIds: [], state: "held" }, snapshots: [] } },
    { name: "a snapshot listed twice", list: [held], message: "A snapshot is listed twice.",
      input: { snapshots: [write(held), write(held, { requestId: "request-7" })] } },
    { name: "two snapshots with one requestId", list: [], message: "Two snapshots name the same requestId.",
      input: { snapshots: [fresh(4), fresh(5, "held"), { ...fresh(6), requestId: "request-4" }] } },
    { name: "a new snapshot in state returned", list: [], message: "A new snapshot is held or dispatched.",
      input: { snapshots: [fresh(4, "returned")] } },
    { name: "a requestId another stored snapshot already sends", list: [returned], message: "Another snapshot already sends this requestId.",
      input: { snapshots: [{ ...fresh(4), requestId: "request-3" }] } },
    { name: "changed text", list: [held], message: "A snapshot's text and requestId do not change.",
      input: { snapshots: [write(held, { text: "Untie me" })] } },
    { name: "changed requestId", list: [held], message: "A snapshot's text and requestId do not change.",
      input: { snapshots: [write(held, { requestId: "request-8" })] } },
    { name: "changed files on a snapshot that is not held", list: [dispatched], message: "Only a held snapshot's files change.",
      input: { snapshots: [write(dispatched, { fileIds: ["file-sail"] })] } },
    { name: "a disallowed state change (dispatched to held)", list: [dispatched], message: "A dispatched snapshot cannot become held.",
      input: { snapshots: [write(dispatched, { state: "held" })] } },
    { name: "a disallowed state change (returned to dispatched)", list: [returned], message: "A returned snapshot cannot become dispatched.",
      input: { snapshots: [write(returned, { state: "dispatched" })] } },
    { name: "a held snapshot left out", list: [held, returned], message: "A held snapshot is not deleted; return it first.",
      input: { snapshots: [write(returned)] } },
    { name: "a dispatched snapshot left out", list: [dispatched], message: "A dispatched snapshot is not deleted; return it first.",
      input: { snapshots: [] } },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const error = refusal(() => nextSnapshots(c.list, c.input, AT));
      expect(error.message).toBe(c.message);
      expect(error.status).toBe(400);
      expect(error.body).toEqual({ error: "DRAFT_INVALID", message: c.message });
    });
  }
});

describe("nextSnapshots allows", () => {
  for (const [from, to] of [["held", "dispatched"], ["held", "returned"], ["dispatched", "returned"], ["held", "held"], ["dispatched", "dispatched"], ["returned", "returned"]] as const) {
    test(`${from} to ${to}`, () => {
      const prior = stored(1, from);
      const result = nextSnapshots([prior], { snapshots: [write(prior, { state: to })] }, AT);
      expect(result).toEqual({ list: [{ ...prior, state: to }], created: [] });
    });
  }

  test("a held snapshot's files change", () => {
    const prior = stored(1, "held", ["file-oar"]);
    const result = nextSnapshots([prior], { snapshots: [write(prior, { fileIds: ["file-oar", "file-sail"] })] }, AT);
    expect(result.list).toEqual([{ ...prior, fileIds: ["file-oar", "file-sail"] }]);
  });

  test("a new snapshot is stamped with the save's time and reported as created", () => {
    const result = nextSnapshots([], { snapshots: [fresh(4, "dispatched", ["file-oar"])] }, AT);
    const created = { ...fresh(4, "dispatched", ["file-oar"]), createdAt: AT };
    expect(result).toEqual({ list: [created], created: [created] });
  });

  test("a returned snapshot left out is deleted", () => {
    const kept = stored(1, "held");
    const result = nextSnapshots([kept, stored(2, "returned")], { snapshots: [write(kept)] }, AT);
    expect(result).toEqual({ list: [kept], created: [] });
  });

  test("neither field given keeps the list", () => {
    const list = [stored(1, "held"), stored(2, "returned")];
    const result = nextSnapshots(list, {}, AT);
    expect(result).toEqual({ list, created: [] });
    expect(result.list).not.toBe(list);
  });

  test("the single-slot write creates the snapshot of its request", () => {
    const prior = stored(1, "returned");
    const result = nextSnapshots([prior], { outgoing: { requestId: "request-5", text: "Steer past Scylla", fileIds: [], state: "held" } }, AT);
    const created: DraftSnapshot = { snapshotId: "request-5", requestId: "request-5", text: "Steer past Scylla", fileIds: [], state: "held", createdAt: AT };
    expect(result).toEqual({ list: [prior, created], created: [created] });
  });

  test("the single-slot write addresses the existing snapshot of its request", () => {
    const prior = stored(1, "held");
    const result = nextSnapshots([prior], { outgoing: { requestId: prior.requestId, text: prior.text, fileIds: [], state: "dispatched" } }, AT);
    expect(result).toEqual({ list: [{ ...prior, state: "dispatched" }], created: [] });
  });

  test("the single-slot clear removes the snapshot the slot shows", () => {
    const older = stored(1, "held");
    const shown = stored(2, "dispatched");
    const gone = stored(3, "returned");
    expect(nextSnapshots([older, shown, gone], { outgoing: null }, AT)).toEqual({ list: [older, gone], created: [] });
    expect(nextSnapshots([gone], { outgoing: null }, AT)).toEqual({ list: [gone], created: [] });
  });
});

test("legacyOutgoing shows the newest snapshot that is not returned", () => {
  expect(legacyOutgoing([stored(1, "held"), stored(2, "dispatched"), stored(3, "returned")])?.snapshotId).toBe("snap-2");
  expect(legacyOutgoing([stored(1, "returned")])).toBeNull();
});

test("snapshotFiles lists every owned file once", () => {
  expect(snapshotFiles([fresh(1, "held", ["file-oar", "file-sail"]), fresh(2, "returned", ["file-sail", "file-map"])]))
    .toEqual(["file-oar", "file-sail", "file-map"]);
});
