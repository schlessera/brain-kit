import { describe, expect, test } from "bun:test";
import type { StorageGuidanceResponse, StorageStatus } from "@schlessera/brain-ui-sdk/protocol";
import {
  LARGER_PRESETS,
  appAddedSummary,
  appUsage,
  relevantTools,
  storageAlertsLine,
  storageBanner,
  storageStatusLine,
} from "../src/components/settings/storage/storage-pane-model.js";
import { storageConsumerRows } from "../src/components/settings/storage/storage-consumers.js";
import { storageFormat, storageVolumes } from "../src/components/settings/storage/storage-volumes.js";
import {
  DAY,
  GB,
  HOUR,
  ITHACA,
  SCHERIA,
  brainRoots,
  capacity,
  evidence,
  finite,
  guidance,
  historyOf,
  inventory,
  node,
  observation,
  page,
  pressure,
  root,
  unavailable,
  worldTime,
} from "./fixtures/storage-volumes.js";

const format = storageFormat("UTC");
const status = (extra: Partial<StorageStatus> = {}): StorageStatus => ({
  version: 1,
  state: "idle",
  activeScanId: null,
  snapshot: null,
  previous: null,
  lastFailure: null,
  limits: { entries: 1, page: 1, roots: 1, milliseconds: 1, cacheBytes: 1 },
  ...extra,
});
const scanned = (extra: Parameters<typeof inventory>[2] = []) => {
  const value = inventory([capacity(ITHACA, brainRoots.map((root) => root.id), 161 * GB, 16.4 * GB)], brainRoots, extra);
  value.entries = 14_212;
  return value;
};

describe("header status line (#4549 brief, item 4)", () => {
  test("complete, partial, out of date, measuring, never measured and failed each have a glyph and an action", () => {
    const complete = { ...scanned(), coverage: "complete" as const };
    expect(storageStatusLine({ status: status({ snapshot: complete }), snapshot: complete, now: worldTime, format })).toEqual({
      state: "complete",
      glyph: "●",
      text: "Measured 12 Jul 09:41 · complete · 14,212 entries",
      action: "measure-again",
    });
    const partial = scanned();
    partial.roots = [...partial.roots, { ...partial.roots[0]!, id: "x", coverage: "unknown" }, { ...partial.roots[0]!, id: "y", coverage: "unknown" }];
    expect(storageStatusLine({ status: status({ snapshot: partial }), snapshot: partial, now: worldTime, format }).text).toBe(
      "Measured 12 Jul 09:41 · partial · ≥ 14,212 entries · 2 stores not measured"
    );
    expect(storageStatusLine({ status: status({ snapshot: complete }), snapshot: complete, now: worldTime + 36 * 3_600_000, format })).toMatchObject({
      state: "out-of-date",
      glyph: "◷",
      text: "Out of date · measured 12 Jul 09:41 (36 h ago)",
    });
    expect(storageStatusLine({ status: status({ state: "scanning", snapshot: complete }), snapshot: complete, now: worldTime, format })).toMatchObject({
      glyph: "◐",
      text: "Measuring… · showing 12 Jul 09:41",
      action: "cancel",
    });
    expect(storageStatusLine({ status: status({ state: "scanning" }), snapshot: null, now: worldTime, format }).text).toBe("Measuring… · nothing measured yet");
    expect(storageStatusLine({ status: status(), snapshot: null, now: worldTime, format })).toEqual({
      state: "never",
      glyph: "○",
      text: "Not measured yet",
      action: "measure",
    });
    const failure = { scanId: "s", at: worldTime + 1, reason: "cancelled-or-revoked" };
    expect(storageStatusLine({ status: status({ snapshot: complete, lastFailure: failure }), snapshot: complete, now: worldTime, format })).toMatchObject({
      glyph: "!",
      text: "Last measurement failed · cancelled or revoked · showing 12 Jul 09:41",
      action: "measure-again",
    });
    expect(storageStatusLine({ status: null, snapshot: null, now: worldTime, format }).action).toBeNull();
    expect(storageStatusLine({ status: null, snapshot: null, now: worldTime, format, unavailable: true })).toEqual({
      state: "unavailable",
      glyph: "?",
      text: "Not measured · Storage could not be read",
      action: null,
    });
  });

  test("only never measured asks for the primary Measure", () => {
    expect(storageStatusLine({ status: status(), snapshot: null, now: worldTime, format }).action).toBe("measure");
    const failure = { scanId: "s", at: worldTime, reason: "budget" };
    expect(storageStatusLine({ status: status({ lastFailure: failure }), snapshot: null, now: worldTime, format }).action).toBe("measure");
  });
});

describe("Alerts row (#4549 decision, 2026-11-25)", () => {
  const notifications = (subscriptions: StorageGuidanceResponse["notifications"]["subscriptions"], start = 22, end = 8) =>
    ({
      permission: "browser-managed",
      quietHours: { start, end, unknownZone: "defer" },
      subscriptionsTruncated: false,
      receiptsTruncated: false,
      subscriptions,
      receipts: [],
    }) as unknown as StorageGuidanceResponse["notifications"];
  test("copy follows the server: Very low only, strict quiet hours, an unknown timezone sends nothing", () => {
    expect(storageAlertsLine(notifications([{ zoneKnown: true, quiet: false }]), true).text).toBe("On · at Very low · quiet 22:00–08:00");
    expect(storageAlertsLine(notifications([{ zoneKnown: true, quiet: true }]), true).text).toBe("On · ◑ quiet until 08:00");
    expect(storageAlertsLine(notifications([{ zoneKnown: false, quiet: null }]), true).text).toBe("On · ? no alerts · timezone unknown");
    expect(storageAlertsLine(notifications([]), true)).toEqual({ state: "off", text: "Off · you won't be told when space runs very low", link: "change" });
    expect(storageAlertsLine(notifications([]), false)).toEqual({ state: "no-device", text: "? no device to notify · add one in Devices", link: "devices" });
    expect(storageAlertsLine(null, true).state).toBe("unavailable");
  });
  test("the quiet-hour bounds come from the response, not literals", () => {
    expect(storageAlertsLine(notifications([{ zoneKnown: true, quiet: false }], 21, 7), true).text).toBe("On · at Very low · quiet 21:00–07:00");
    expect(storageAlertsLine(notifications([{ zoneKnown: true, quiet: true }], 21, 7), true).text).toBe("On · ◑ quiet until 07:00");
  });
  test("one known device outside quiet hours keeps alerts on", () => {
    expect(storageAlertsLine(notifications([{ zoneKnown: false, quiet: null }, { zoneKnown: true, quiet: false }]), true).state).toBe("on");
    expect(storageAlertsLine(notifications([{ zoneKnown: true, quiet: true }, { zoneKnown: true, quiet: false }]), true).state).toBe("on");
  });
});

describe("attention banner (D4)", () => {
  const snapshot = scanned();
  const at = (severity: "observed" | "low" | "critical", extra: Parameters<typeof evidence>[3] = {}) =>
    guidance([pressure(ITHACA, severity, evidence(ITHACA, 161 * GB, 16.4 * GB, extra))]);
  test("no banner while every volume is OK", () => {
    const value = at("observed");
    expect(storageBanner(storageVolumes({ guidance: value, inventory: snapshot, format }), value, format)).toBeNull();
  });
  test("Low names the volume, its own figures and the rate's own window", () => {
    const value = at("low", { short: finite(14, 7) });
    const banner = storageBanner(storageVolumes({ guidance: value, inventory: snapshot, format }), value, format)!;
    expect(banner).toMatchObject({ severity: "low", title: "Disk is Low" });
    expect(banner.text).toBe("16.4 GB available of 161 GB. At the 7-day rate it runs out in about 14 days.");
  });
  test("without a finite scenario the sentence stops at the figures; an unknown capacity is never 0", () => {
    const value = at("critical", { short: unavailable("gap"), long: unavailable("gap") });
    const banner = storageBanner(storageVolumes({ guidance: value, inventory: snapshot, format }), value, format)!;
    expect(banner.title).toBe("Disk is Very low");
    expect(banner.text).toBe("16.4 GB available of 161 GB.");
    const unknown = inventory([capacity(ITHACA, brainRoots.map((root) => root.id), null, null, { kind: "unknown" })], brainRoots);
    const missing = storageBanner(storageVolumes({ guidance: value, inventory: unknown, format }), value, format)!;
    expect(missing.text).toBe("Available space not measured.");
    expect(missing.text).not.toMatch(/\b0\b/);
  });
});

describe("What this app added", () => {
  test("the change over the rate's own window, or a mark", () => {
    expect(appAddedSummary({ start: worldTime - 7 * DAY, end: worldTime, samples: 28, bytesPerDay: 0.49 * GB }, format)).toEqual({
      value: "+3.43 GB",
      window: "7 d",
      spoken: "App changed +3.43 GB in 7 days",
    });
    expect(appAddedSummary(null, format).value).toBe("? rate unavailable");
  });
});

test("Larger than keeps D11's 5 MB default among its presets", () => {
  expect(LARGER_PRESETS[0]).toEqual({ value: "5", label: "5 MB" });
});

describe("breakdown rows", () => {
  test("a hard-linked alias is listed with its own size as Shared · counted once, never hidden as empty", () => {
    const alias = node({ id: 7, rootId: 1, name: "Troy-charts.PDF", kind: "file", owner: "brain", bytes: 48_200_000 });
    alias.area = { logical: 0, allocated: 0, coverage: "complete" };
    const { rows, empty } = storageConsumerRows(page([alias]), "allocated");
    expect(empty).toEqual([]);
    expect(rows[0]).toMatchObject({ name: "Troy-charts.PDF", size: "48.2 MB", meta: "Shared · counted once", shared: true });
  });
  test("a measured zero-byte row is still the hidden empty row", () => {
    const zero = node({ id: 8, rootId: 1, name: "placeholder.pdf", kind: "file", owner: "brain", bytes: 0 });
    const { rows, empty } = storageConsumerRows(page([zero]), "allocated");
    expect(rows).toEqual([]);
    expect(empty.map((row) => row.name)).toEqual(["placeholder.pdf"]);
  });
});

test("a repeated capacity id is one volume, never two to add", () => {
  const roots = brainRoots.map((root) => root.id);
  const twice = inventory([capacity(ITHACA, roots, 161 * GB, 16.4 * GB), capacity(ITHACA, roots, 161 * GB, 16.4 * GB)], brainRoots);
  const volumes = storageVolumes({ guidance: null, inventory: twice, format });
  expect(volumes.map((volume) => volume.name)).toEqual(["Disk"]);
});

// #4549 review F6: Free up space lists the tools for the selected volume and
// for every Low or Very low one, by the stores each tool's scope reaches.
describe("Free up space relevance", () => {
  const backups = root(11, "Backups", "backup", "operator", 40 * GB);
  const roots = [...brainRoots, root(12, "Scratch", "scratch", "app", 1 * GB), backups];
  const brain = capacity(ITHACA, [...brainRoots.map((value) => value.id), roots[4]!.id], 161 * GB, 48 * GB);
  const disk = capacity(SCHERIA, [backups.id], 250 * GB, 48 * GB);
  const snapshot = inventory([brain, disk], roots);
  const tools = [
    { id: "pack-git" as const, scope: ["git" as const] },
    { id: "prune-scratch" as const, scope: ["scratch" as const] },
    { id: "cleanup-staging" as const, scope: ["staging" as const] },
  ];
  const volumesAt = (brainSeverity: "observed" | "low" | "critical") =>
    storageVolumes({
      guidance: guidance([
        pressure(ITHACA, brainSeverity, evidence(ITHACA, brain.total, brain.available)),
        pressure(SCHERIA, "observed", evidence(SCHERIA, disk.total, disk.available)),
      ]),
      inventory: snapshot,
      format,
    });
  const ids = (value: { tools: ReadonlyArray<{ id: string }> }) => value.tools.map((tool) => tool.id);
  test("a healthy host lists only the tools whose stores sit on the selected volume", () => {
    const volumes = volumesAt("observed");
    expect(ids(relevantTools(tools, { inventory: snapshot, volumes, selected: ITHACA })), "STORAGE_TOOLS_FOR_SELECTED").toEqual([
      "pack-git",
      "prune-scratch",
    ]);
  });
  test("selecting a volume no tool reaches says so in one line instead of an empty list", () => {
    const result = relevantTools(tools, { inventory: snapshot, volumes: volumesAt("observed"), selected: SCHERIA });
    expect(ids(result), "STORAGE_TOOLS_NONE_FOR_BACKUPS").toEqual([]);
    expect(result.empty).toBe("No owner-supported tool frees space on Backups.");
  });
  test("a Low or Very low volume keeps its tools listed while another volume is selected", () => {
    for (const severity of ["low", "critical"] as const) {
      const result = relevantTools(tools, { inventory: snapshot, volumes: volumesAt(severity), selected: SCHERIA });
      expect(ids(result), `STORAGE_TOOLS_FOR_PRESSURED ${severity}`).toEqual(["pack-git", "prune-scratch"]);
      expect(result.empty).toBeNull();
    }
  });
  test("an unknown mapping is never 'not relevant': without inventory, or for an unmapped volume, every tool stays", () => {
    const volumes = volumesAt("observed");
    expect(ids(relevantTools(tools, { inventory: null, volumes, selected: SCHERIA })), "STORAGE_TOOLS_UNKNOWN_KEPT").toEqual(ids({ tools }));
    expect(ids(relevantTools(tools, { inventory: snapshot, volumes, selected: "f".repeat(32) }))).toEqual(ids({ tools }));
  });
  test("a tool whose run the pane holds stays listed on any volume", () => {
    const result = relevantTools(tools, { inventory: snapshot, volumes: volumesAt("observed"), selected: SCHERIA, keep: "pack-git" });
    expect(ids(result), "STORAGE_TOOLS_KEEP_RUNNING").toEqual(["pack-git"]);
    expect(result.empty).toBeNull();
  });
});

// #4549 review F7: the usage sparkline, its value and its description follow
// one size basis.
describe("usage sparkline basis", () => {
  const history = historyOf([0, 1, 2].map((step) => {
    const row = observation("six-hour", worldTime - (2 - step) * 6 * HOUR, [{ identity: ITHACA, available: 48 * GB, app: 24 * GB + step * GB }]);
    row.capacities[0]!.owners.app.logical = 20 * GB + step * GB;
    return row;
  }));
  const rated = pressure(ITHACA, "observed", evidence(ITHACA, 161 * GB, 48 * GB, {
    appAllocated: { start: worldTime - 7 * DAY, end: worldTime, samples: 28, bytesPerDay: 0.49 * GB },
    appLogical: { start: worldTime - 7 * DAY, end: worldTime, samples: 28, bytesPerDay: 0.47 * GB },
  }));
  test("File size draws, values and describes logical bytes; On disk draws allocated bytes", () => {
    const logical = appUsage({ pressure: rated, history, identity: ITHACA, metric: "logical", now: worldTime, format });
    expect(logical.points.map((point) => point.value), "STORAGE_SPARKLINE_FOLLOWS_BASIS").toEqual([20 * GB, 21 * GB, 22 * GB]);
    expect(logical.value).toBe("+3.29 GB");
    const allocated = appUsage({ pressure: rated, history, identity: ITHACA, metric: "allocated", now: worldTime, format });
    expect(allocated.points.map((point) => point.value)).toEqual([24 * GB, 25 * GB, 26 * GB]);
    expect(allocated.value).toBe("+3.43 GB");
  });
});
