import { describe, expect, test } from "bun:test";
import {
  foldSidecarLabels,
  sidecarBase,
  storageConsumerRows,
  storageLegend,
  storageListing,
} from "../src/components/settings/storage/storage-consumers.js";
import { bytes, mapItems } from "../src/components/settings/storage/storage-model.js";
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
    // The database itself was read; the unreadable -shm member is why the size is a lower bound.
    expect(database.reason).toBe("couldn't read file details");
    expect(database.meta).toBe("database · with -shm, -wal");
    expect(database.members.map((member) => [member.name, member.bytes, member.reason])).toEqual([
      ["Operational database", 5 * GB, undefined],
      ["Operational database-shm", null, "couldn't read file details"],
      ["Operational database-wal", 400_000_000, undefined],
    ]);
  });

  test("a folded member's reason survives, and the database's own reason comes first", () => {
    const nodes = [
      node({ id: 24, rootId: 6, name: "ledger.db", kind: "file", owner: "app", bytes: 2 * GB, coverage: "partial", reason: "cancelled" }),
      node({ id: 25, rootId: 6, name: "ledger.db-wal", kind: "file", owner: "app", bytes: null, reason: "metadata-unavailable" }),
      node({ id: 26, rootId: 6, name: "ledger.db-shm", kind: "file", owner: "app", bytes: null }),
    ];
    const [ledger] = storageConsumerRows(page(nodes, appRoots[1]!.id), "allocated").rows;
    expect(ledger!.reason).toBe("scan was cancelled · scan again");
    expect(ledger!.members.map((member) => [member.name, member.reason])).toEqual([
      ["ledger.db", "scan was cancelled · scan again"],
      ["ledger.db-shm", "not measured"],
      ["ledger.db-wal", "couldn't read file details"],
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

  test("only a file folds beside a file: a sidecar-named folder keeps its own row and drill", () => {
    const nodes = [
      node({ id: 32, rootId: 6, name: "ledger", kind: "file", owner: "app", bytes: GB }),
      node({ id: 33, rootId: 6, name: "ledger-journal", kind: "directory", owner: "app", bytes: 3 * GB }),
      node({ id: 34, rootId: 6, name: "ledger-wal", kind: "symlink", owner: "app", bytes: 100 }),
    ];
    expect(
      storageConsumerRows(page(nodes, appRoots[1]!.id), "allocated").rows.map((row) => [row.name, row.bytes, row.action, row.members.length])
    ).toEqual([
      ["ledger-journal", 3 * GB, "drill", 1],
      ["ledger", GB, "inspect", 1],
      ["ledger-wal", 100, "inspect", 1],
    ]);
  });
});

// A database and its sidecars are one item everywhere (#4546, maintainer
// 2026-11-26): one tile at the combined size, one row, and never a
// "smaller items" entry of their own.
describe("the map folds sidecars as the list does", () => {
  function scene(nodes: ReturnType<typeof node>[]) {
    const sum = nodes.reduce((total, value) => total + (value.area.allocated ?? 0), 0);
    const tree = { ...page(nodes, appRoots[1]!.id), totals: { logical: sum, allocated: sum, coverage: "complete" as const } };
    const tiles = mapItems(tree, "allocated", false);
    const shown = new Set(tiles.filter((tile) => !tile.smaller).map((tile) => tile.id));
    return { tiles, smaller: tiles.find((tile) => tile.smaller), listed: storageListing(storageConsumerRows(tree, "allocated"), { shown }) };
  }
  const ledger = (database: number, wal: number) => [
    node({ id: 22, rootId: 6, name: "ledger.db", kind: "file", owner: "app", bytes: database }),
    node({ id: 23, rootId: 6, name: "ledger.db-wal", kind: "file", owner: "app", bytes: wal }),
  ];

  test("a 2 GB database and its 1 MB -wal are one tile, and no smaller item is offered for the sidecar", () => {
    const { tiles, smaller, listed } = scene(ledger(2 * GB, 1_000_000));
    expect(tiles.map((tile) => [tile.name, tile.bytes]), "STORAGE_SIDECAR_ONE_TILE").toEqual([["ledger.db", 2 * GB + 1_000_000]]);
    expect(smaller, "STORAGE_SIDECAR_NO_SMALLER_ITEM").toBeUndefined();
    expect(listed).toEqual([]);
  });

  test("a sidecar larger than its database still draws as the database's tile", () => {
    const nodes = ledger(10_000_000, 2 * GB);
    const { tiles, smaller } = scene(nodes);
    expect(tiles.map((tile) => [tile.id, tile.name, tile.bytes])).toEqual([[nodes[0]!.id, "ledger.db", 2 * GB + 10_000_000]]);
    expect(smaller).toBeUndefined();
  });

  test("a genuinely small unfolded entry is the one smaller item, and the list shows it", () => {
    const notes = node({ id: 24, rootId: 6, name: "notes.txt", kind: "file", owner: "app", bytes: 1_000_000 });
    const { smaller, listed } = scene([...ledger(2 * GB, 1_000_000), notes]);
    expect(smaller, "STORAGE_SMALLER_COUNTS_ITEMS").toMatchObject({ name: "1 smaller items", bytes: 1_000_000 });
    expect(listed.map((row) => [row.name, row.size]), "STORAGE_SMALLER_LISTS_ENTRY").toEqual([["notes.txt", bytes(1_000_000)]]);
  });

  test("a store's sidecar stores draw no tile of their own", () => {
    const stores = appRoots.map(node);
    const tree = { ...page(stores), totals: { logical: 8.4 * GB, allocated: 8.4 * GB, coverage: "partial" as const } };
    expect(mapItems(tree, "allocated", false).map((tile) => [tile.name, tile.bytes])).toEqual([
      ["Operational database", 5_400_000_000],
      ["App journal", 3 * GB],
    ]);
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

  test("folder metadata has no action: there is nothing to open or inspect", () => {
    const nodes = [
      node({ id: 42, rootId: 1, name: "charts", kind: "directory", owner: "brain", bytes: 5_000_000 }),
      node({ id: 43, rootId: 1, name: "Folder metadata", kind: "metadata", owner: "brain", bytes: 12_000 }),
    ];
    expect(storageConsumerRows(page(nodes, brainRoots[0]!.id), "allocated").rows.map((row) => [row.name, row.action, row.kind])).toEqual([
      ["charts", "drill", "folder"],
      ["Folder metadata", "none", "folder metadata"],
    ]);
  });
});

describe("the ownership legend counts only complete evidence", () => {
  const nodes = [
    node({ id: 50, rootId: 1, name: "charts", kind: "directory", owner: "brain", bytes: 3 * GB }),
    node({ id: 51, rootId: 1, name: "log.md", kind: "file", owner: "brain", bytes: 2_000_000 }),
    node({ id: 52, rootId: 1, name: "cache", kind: "directory", owner: "app", bytes: GB }),
  ];
  const folder = (nextCursor: string | null) => ({ ...page(nodes, brainRoots[0]!.id), nextCursor });
  const derived = (value: ReturnType<typeof folder>) => storageConsumerRows(value, "allocated");

  test("a folder of two pages gives its owners no totals, on either page", () => {
    const first = folder("odysseus-page-2"),
      last = folder(null);
    for (const legend of [
      storageLegend(derived(first), { nextCursor: first.nextCursor }),
      storageLegend(derived(last), { cursor: "odysseus-page-2", nextCursor: last.nextCursor }),
    ])
      expect(legend.owners).toEqual([
        { owner: "brain", total: undefined },
        { owner: "app", total: undefined },
      ]);
  });

  test("Smaller items does not change the totals of a complete page", () => {
    const whole = folder(null);
    const rows = derived(whole);
    // The map draws charts and cache as tiles; the list shows only log.md.
    const shown = new Set([nodes[0]!.id, nodes[2]!.id]);
    expect(storageListing(rows, { shown }).map((row) => row.name)).toEqual(["log.md"]);
    expect(storageLegend(rows, { nextCursor: null, shown }).owners).toEqual(storageLegend(rows, { nextCursor: null }).owners);
  });

  test("a complete page keeps its totals", () => {
    const whole = folder(null);
    expect(storageLegend(derived(whole), { nextCursor: null }).owners).toEqual([
      { owner: "brain", total: bytes(3 * GB + 2_000_000) },
      { owner: "app", total: bytes(GB) },
    ]);
  });
});
