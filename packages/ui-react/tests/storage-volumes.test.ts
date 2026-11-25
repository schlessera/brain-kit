import { describe, expect, test } from "bun:test";
import {
  STORAGE_PRESSURE_CRITICAL_PERCENT,
  STORAGE_PRESSURE_LOW_PERCENT,
} from "@schlessera/brain-ui-sdk/protocol";
import {
  STORAGE_GAUGE_THRESHOLDS,
  evidenceStale,
  latestInventory,
  storageFormat,
  storageVolumes,
  thresholdBytes,
  volumeNames,
} from "../src/components/settings/storage/storage-volumes.js";
import {
  AEAEA,
  GB,
  ITHACA,
  OGYGIA,
  SCHERIA,
  appRoots,
  brainRoots,
  capacity,
  evidence,
  guidance,
  inventory,
  memoryRoots,
  pressure,
  twoVolumes,
  unavailable,
  unknownRoots,
  worldTime,
} from "./fixtures/storage-volumes.js";

const format = storageFormat("UTC");
const names = (...args: Parameters<typeof inventory>) =>
  storageVolumes({ guidance: null, inventory: inventory(...args), format }).map((volume) => volume.name);

describe("volume naming (#4537 D7)", () => {
  test("a single disk is Disk, whatever it holds", () => {
    const all = [...brainRoots, ...appRoots];
    expect(names([capacity(ITHACA, all.map((root) => root.id), 161 * GB, 16 * GB)], all)).toEqual(["Disk"]);
  });

  test("a disk shared by the brain and the app is the Brain disk; an app-only disk is the App data disk", () => {
    const shared = [...brainRoots, appRoots[0]!];
    expect(
      names(
        [
          capacity(ITHACA, shared.map((root) => root.id), 161 * GB, 16 * GB),
          capacity(SCHERIA, appRoots.slice(1).map((root) => root.id), 250 * GB, 48 * GB),
        ],
        [...brainRoots, ...appRoots]
      )
    ).toEqual(["Brain disk", "App data disk"]);
  });

  test("separate disks are named by their contents", () => {
    const { inventory: snapshot } = twoVolumes();
    expect(storageVolumes({ guidance: null, inventory: snapshot, format }).map((volume) => volume.name)).toEqual([
      "Brain disk",
      "App data disk",
    ]);
  });

  test("a disk holding transcripts and the brain is never named after transcripts", () => {
    // Voyage transcripts are the largest store on Ithaca's disk (30 GB of 37 GB).
    const [volume] = storageVolumes({ guidance: null, inventory: twoVolumes().inventory, format });
    expect(volume!.name).toBe("Brain disk");
    expect(volume!.name).not.toMatch(/transcript/i);
    // Only a brain, Git or index root makes the Brain disk: the transcripts alone are App data.
    const transcripts = [brainRoots[3]!];
    expect(volumeNames([{ identified: true, kind: "filesystem", roots: transcripts }, { identified: true, kind: "filesystem", roots: appRoots }])).toEqual([
      "App data disk",
      "App data disk 2",
    ]);
  });

  test("Git or index roots alone name the Brain disk", () => {
    const git = [{ owner: "app" as const, category: "git" as const }];
    const index = [{ owner: "operator" as const, category: "index" as const }];
    expect(volumeNames([{ identified: true, kind: "filesystem", roots: git }, { identified: true, kind: "filesystem", roots: index }])).toEqual([
      "Brain disk",
      "Brain disk 2",
    ]);
  });

  test("tmpfs is Memory (tmpfs), even alone", () => {
    const all = [...brainRoots, ...memoryRoots];
    expect(
      names(
        [capacity(ITHACA, brainRoots.map((root) => root.id), 161 * GB, 16 * GB), capacity(AEAEA, [memoryRoots[0]!.id], 2 * GB, 1 * GB, { kind: "tmpfs" })],
        all
      )
    ).toEqual(["Brain disk", "Memory (tmpfs)"]);
    expect(names([capacity(AEAEA, [memoryRoots[0]!.id], 2 * GB, 1 * GB, { kind: "tmpfs" })], memoryRoots)).toEqual(["Memory (tmpfs)"]);
  });

  test("an unknown identity is Unidentified volume, even alone, and never named after its stores", () => {
    expect(
      names([capacity(OGYGIA, [unknownRoots[0]!.id], null, null, { identity: "unknown", kind: "unknown", reason: "overlay-capacity-unknown" })], unknownRoots)
    ).toEqual(["Unidentified volume"]);
    // A pressure record whose identity inventory does not hold: the server could not join it.
    const [volume] = storageVolumes({
      guidance: guidance([pressure(OGYGIA, "critical", null, { stores: [{ label: "Brain files", owner: "brain" }] })]),
      inventory: inventory([], []),
      format,
    });
    expect(volume!.name).toBe("Unidentified volume");
    expect(volume!.identified).toBe(false);
  });

  test("a clash appends 2 in measurement order, and severity reordering keeps the names", () => {
    const a = capacity(SCHERIA, [appRoots[0]!.id], 250 * GB, 48 * GB),
      b = capacity(AEAEA, [appRoots[1]!.id], 120 * GB, 30 * GB);
    const snapshot = inventory([a, b], appRoots);
    expect(storageVolumes({ guidance: null, inventory: snapshot, format }).map((volume) => volume.name)).toEqual([
      "App data disk",
      "App data disk 2",
    ]);
    const worst = storageVolumes({
      guidance: guidance([pressure(SCHERIA, "observed", null), pressure(AEAEA, "critical", null)]),
      inventory: snapshot,
      format,
    });
    expect(worst.map((volume) => [volume.id, volume.name])).toEqual([
      [AEAEA, "App data disk 2"],
      [SCHERIA, "App data disk"],
    ]);
  });
});

describe("volume order", () => {
  test("worst severity first, then measurement order", () => {
    const roots = [...brainRoots, ...appRoots, ...memoryRoots];
    const snapshot = inventory(
      [
        capacity(ITHACA, brainRoots.map((root) => root.id), 161 * GB, 16 * GB),
        capacity(SCHERIA, appRoots.map((root) => root.id), 250 * GB, 48 * GB),
        capacity(AEAEA, [memoryRoots[0]!.id], 2 * GB, 1 * GB, { kind: "tmpfs" }),
      ],
      roots
    );
    const order = (severities: Parameters<typeof pressure>[1][]) =>
      storageVolumes({
        guidance: guidance([ITHACA, SCHERIA, AEAEA].map((id, index) => pressure(id, severities[index]!, null))),
        inventory: snapshot,
        format,
      }).map((volume) => volume.id);
    expect(order(["observed", "observed", "observed"])).toEqual([ITHACA, SCHERIA, AEAEA]);
    expect(order(["low", "observed", "critical"])).toEqual([AEAEA, ITHACA, SCHERIA]);
    expect(order(["low", "low", "observed"])).toEqual([ITHACA, SCHERIA, AEAEA]);
  });

  test("pressure records inventory does not hold follow inventory's volumes", () => {
    const { inventory: snapshot } = twoVolumes();
    const volumes = storageVolumes({
      guidance: guidance([pressure(OGYGIA, "observed", null), pressure(ITHACA, "observed", null)]),
      inventory: snapshot,
      format,
    });
    expect(volumes.map((volume) => volume.id)).toEqual([ITHACA, SCHERIA, OGYGIA]);
  });
});

describe("gauge figures and thresholds", () => {
  test("the ticks are the #4539 policy constants as fractions", () => {
    expect(STORAGE_GAUGE_THRESHOLDS).toEqual({
      low: STORAGE_PRESSURE_LOW_PERCENT / 100,
      veryLow: STORAGE_PRESSURE_CRITICAL_PERCENT / 100,
    });
    expect(thresholdBytes(161 * GB)).toEqual({
      low: (161 * GB * STORAGE_PRESSURE_LOW_PERCENT) / 100,
      veryLow: (161 * GB * STORAGE_PRESSURE_CRITICAL_PERCENT) / 100,
    });
  });

  test("each volume carries its own used, reserved and available figures", () => {
    const { brain, app, inventory: snapshot, guidance: response } = twoVolumes();
    const [first, second] = storageVolumes({ guidance: response, inventory: snapshot, format });
    // Scheria is Very low, so it leads.
    expect(first!.capacity).toEqual({ total: app.total!, used: app.used!, free: app.free!, available: app.available! });
    expect(second!.capacity).toEqual({ total: brain.total!, used: brain.used!, free: brain.free!, available: brain.available! });
    expect([first!.status, second!.status]).toEqual(["very-low", "low"]);
    expect(first!.thresholdBytes).toEqual(thresholdBytes(app.total));
  });

  test("an unknown total leaves the figures and threshold bytes out, never 0", () => {
    const snapshot = inventory([capacity(ITHACA, brainRoots.map((root) => root.id), null, null, { kind: "unknown", reason: "statfs-unavailable" })], brainRoots);
    const [volume] = storageVolumes({ guidance: guidance([pressure(ITHACA, "observed", null)]), inventory: snapshot, format });
    expect(volume!.capacity).toBeUndefined();
    expect(volume!.thresholdBytes).toBeNull();
    expect(volume!.unknownReason).toBe("statfs unavailable");
    expect(volume!.status).toBe("not-measured");
    expect(thresholdBytes(null)).toBeNull();
    expect(thresholdBytes(0)).toBeNull();
  });

  test("figures that do not add up are not drawn", () => {
    const broken = { ...capacity(ITHACA, brainRoots.map((root) => root.id), 161 * GB, 16 * GB), used: null };
    const [volume] = storageVolumes({ guidance: null, inventory: inventory([broken], brainRoots), format });
    expect(volume!.capacity).toBeUndefined();
    expect(volume!.unknownReason).toBe("capacity not reported");
  });

  test("a volume with no pressure record is never called OK", () => {
    const [volume] = storageVolumes({ guidance: null, inventory: twoVolumes().inventory, format });
    expect(volume!.status).toBe("not-measured");
    expect(volume!.severity).toBeNull();
    expect(volume!.capacity).toBeDefined();
  });
});

describe("facts and qualifiers", () => {
  test("stale is the scenario evidence's own verdict, passed through", () => {
    const { inventory: snapshot } = twoVolumes();
    const old = evidence(ITHACA, 161 * GB, 16 * GB, {
      at: worldTime - 7 * 3_600_000,
      fresh: false,
      short: unavailable("stale"),
      long: unavailable("stale"),
    });
    const [volume] = storageVolumes({ guidance: guidance([pressure(ITHACA, "low", old)]), inventory: snapshot, format });
    expect(volume!.stale).toBe(true);
    expect(volume!.measured).toBe("Measured 12 Jul 02:41");
    expect(volume!.runway).toBe("not projected · latest measurement is out of date");
    // Not fresh for another reason is not stale.
    expect(evidenceStale(pressure(ITHACA, "low", { ...old, short: unavailable("incomplete"), long: unavailable("gap") }))).toBe(false);
    expect(evidenceStale(null)).toBe(false);
  });

  test("trend and runway come from the evidence; a missing rate is unknown, never 0", () => {
    const { inventory: snapshot, guidance: response } = twoVolumes();
    const [scheria, ithaca] = storageVolumes({ guidance: response, inventory: snapshot, format });
    expect(scheria!.trend).toBe("−1.2 GB/day");
    expect(scheria!.runway).toBe("~6 days");
    expect(ithaca!.runway).toBe("~20 days");
    const [none] = storageVolumes({
      guidance: guidance([pressure(ITHACA, "low", evidence(ITHACA, 161 * GB, 16 * GB, { availableChange: null }))]),
      inventory: snapshot,
      format,
    });
    expect(none!.trend).toBe("unknown");
  });

  test("a changed scope projects nothing and says when", () => {
    const { inventory: snapshot } = twoVolumes();
    const [volume] = storageVolumes({
      guidance: guidance([pressure(ITHACA, "low", evidence(ITHACA, 161 * GB, 16 * GB), { scopeChanged: true, at: Date.UTC(2026, 6, 12, 9, 10) })]),
      inventory: snapshot,
      format,
    });
    expect(volume!.scopeChanged).toBe("12 Jul 09:10");
    expect(volume!.runway).toBe("not projected · scope changed");
    expect(volume!.trend).toBe("unknown");
  });

  test("an unidentified volume says which event exposed it, with no facts", () => {
    const refused = pressure(OGYGIA, "critical", null, {
      causes: { capacity: false, forecast: false, refusals: [{ target: "c".repeat(32), resource: "bytes", at: Date.UTC(2026, 6, 12, 14, 2) - 86_400_000, successAt: null }] },
    });
    const [volume] = storageVolumes({ guidance: guidance([refused]), inventory: inventory([], []), format });
    expect(volume!.unidentified).toBe("Write refused 11 Jul 14:02");
    expect(volume!.trend).toBeUndefined();
    expect(volume!.runway).toBeUndefined();
    expect(volume!.capacity).toBeUndefined();
  });

  test("store labels fold sidecars into their database", () => {
    const [, ithaca] = storageVolumes({ guidance: twoVolumes().guidance, inventory: twoVolumes().inventory, format });
    expect(ithaca!.stores).toEqual(["Brain files", "Git store", "Content index", "Voyage transcripts"]);
    const scheria = storageVolumes({ guidance: null, inventory: twoVolumes().inventory, format })[1]!;
    expect(scheria.stores).toEqual(["App journal", "Operational database"]);
  });

  test("the newest inventory is the one guidance joins", () => {
    const older = { ...twoVolumes().inventory, id: "older", observedAt: worldTime - 60_000 };
    const newer = twoVolumes().inventory;
    expect(latestInventory({ snapshot: older, previous: newer })?.id).toBe(newer.id);
    expect(latestInventory({ snapshot: null, previous: older })?.id).toBe("older");
    expect(latestInventory(null)).toBeNull();
  });
});
