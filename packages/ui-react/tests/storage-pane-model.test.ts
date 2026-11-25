import { describe, expect, test } from "bun:test";
import type { StorageGuidanceResponse, StorageStatus } from "@schlessera/brain-ui-sdk/protocol";
import {
  LARGER_PRESETS,
  appAddedSummary,
  storageAlertsLine,
  storageBanner,
  storageStatusLine,
} from "../src/components/settings/storage/storage-pane-model.js";
import { storageConsumerRows } from "../src/components/settings/storage/storage-consumers.js";
import { storageFormat, storageVolumes } from "../src/components/settings/storage/storage-volumes.js";
import {
  DAY,
  GB,
  ITHACA,
  brainRoots,
  capacity,
  evidence,
  finite,
  guidance,
  inventory,
  node,
  page,
  pressure,
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
