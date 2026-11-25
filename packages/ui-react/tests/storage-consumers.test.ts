import { describe, expect, test } from "bun:test";
import {
  foldSidecarLabels,
  sidecarBase,
  storageConsumerRows,
} from "../src/components/settings/storage/storage-consumers.js";
import { bytes } from "../src/components/settings/storage/storage-model.js";
import { GB, appRoots, brainRoots, inventory, node, page, root } from "./fixtures/storage-volumes.js";

describe("sidecar folding", () => {
  test("names a sidecar's database", () => {
    expect(["brain.db-wal", "brain.db-shm", "brain.db-journal", "brain.db", "Ithaca-wall"].map(sidecarBase)).toEqual([
      "brain.db",
      "brain.db",
      "brain.db",
      null,
      null,
    ]);
    expect(foldSidecarLabels(["Operational database", "Operational database-wal", "Operational database-shm", "Orphan-wal"])).toEqual([
      "Operational database",
      "Orphan-wal",
    ]);
  });

  test("a store's sidecars fold into it and keep the known sum as a lower bound with the unknown member", () => {
    const { rows } = storageConsumerRows(page(appRoots.map(node)), "allocated", { inventory: inventory([], appRoots) });
    const database = rows.find((row) => row.name === "Operational database")!;
    expect(rows.map((row) => row.name)).toEqual(["Operational database", "App journal"]);
    // 5 GB + 0.4 GB known; the -shm store was not measured.
    expect(database.bytes).toBe(5_400_000_000);
    expect(database.atLeast).toBe(true);
    expect(database.size).toBe(bytes(5_400_000_000));
    expect(database.reason).toBe("size so far · scan stopped early");
    expect(database.meta).toBe("database · with -shm, -wal");
    expect(database.members.map((member) => [member.name, member.bytes])).toEqual([
      ["Operational database", 5 * GB],
      ["Operational database-shm", null],
      ["Operational database-wal", 400_000_000],
    ]);
  });

  test("a file's sidecars fold beside it; a folded database with nothing known stays unknown", () => {
    const nodes = [
      node({ id: 20, rootId: 6, name: "brain.db", kind: "file", owner: "app", bytes: null, reason: "metadata-unavailable" }),
      node({ id: 21, rootId: 6, name: "brain.db-wal", kind: "file", owner: "app", bytes: null, reason: "metadata-unavailable" }),
      node({ id: 22, rootId: 6, name: "ledger.db", kind: "file", owner: "app", bytes: 2 * GB }),
      node({ id: 23, rootId: 6, name: "ledger.db-wal", kind: "file", owner: "app", bytes: 1_000_000 }),
    ];
    const { rows } = storageConsumerRows(page(nodes, appRoots[1]!.id), "allocated");
    expect(rows.map((row) => [row.name, row.bytes, row.atLeast ?? false, row.members.length])).toEqual([
      ["ledger.db", 2_001_000_000, false, 2],
      ["brain.db", null, false, 2],
    ]);
    expect(rows[1]!.size).toBeNull();
    expect(rows[1]!.reason).toBe("couldn't read file details");
    expect(rows[1]!.share).toBeUndefined();
  });

  test("a sidecar does not fold into a same-named entry of another root or kind", () => {
    const nodes = [
      node({ id: 30, rootId: 6, name: "notes", kind: "directory", owner: "app", bytes: GB }),
      node({ id: 31, rootId: 6, name: "notes-wal", kind: "file", owner: "app", bytes: 1_000 }),
    ];
    expect(storageConsumerRows(page(nodes, appRoots[1]!.id), "allocated").rows).toHaveLength(2);
  });
});

describe("rows", () => {
  const roots = [
    ...brainRoots,
    root(11, "Ithaca harbour log", "journal", "app", 0),
    root(12, "Native retained store", "native", "app", null, { reason: "unsupported-platform" }),
  ];

  test("rank by size, unknown last; known complete zero rows are hidden but returned", () => {
    const { rows, empty } = storageConsumerRows(page(roots.map(node)), "allocated", { inventory: inventory([], roots) });
    expect(rows.map((row) => row.name)).toEqual(["Voyage transcripts", "Brain files", "Git store", "Content index", "Native retained store"]);
    expect(empty.map((row) => [row.name, row.bytes, row.size])).toEqual([["Ithaca harbour log", 0, bytes(0)]]);
    expect(rows.at(-1)).toMatchObject({ size: null, bytes: null, reason: "not measured on this system" });
    expect(rows[0]).toMatchObject({ action: "drill", kind: "store", owner: "app", share: 1, shareLabel: "100% of largest" });
  });

  test("name sorting keeps unknown last, either direction", () => {
    const names = (direction: "ascending" | "descending") =>
      storageConsumerRows(page(roots.map(node)), "allocated", { sort: { key: "name", direction } }).rows.map((row) => row.name);
    expect(names("ascending")).toEqual(["Brain files", "Content index", "Git store", "Voyage transcripts", "Native retained store"]);
    expect(names("descending")).toEqual(["Voyage transcripts", "Git store", "Content index", "Brain files", "Native retained store"]);
  });

  test("an unknown root takes its reason from the scan's errors", () => {
    const silent = root(13, "Upload staging", "staging", "app", null);
    const { rows } = storageConsumerRows(page([node(silent)]), "allocated", {
      inventory: inventory([], [silent], [{ rootId: silent.id, reason: "cancelled" }]),
    });
    expect(rows[0]!.reason).toBe("scan was cancelled · scan again");
  });

  test("files inspect, folders drill", () => {
    const nodes = [
      node({ id: 40, rootId: 1, name: "voyage.pdf", kind: "file", owner: "brain", bytes: 48_200_000 }),
      node({ id: 41, rootId: 1, name: "charts", kind: "directory", owner: "brain", bytes: 5_000_000 }),
    ];
    expect(storageConsumerRows(page(nodes, brainRoots[0]!.id), "allocated").rows.map((row) => [row.name, row.action, row.kind])).toEqual([
      ["voyage.pdf", "inspect", "file"],
      ["charts", "drill", "folder"],
    ]);
  });
});
