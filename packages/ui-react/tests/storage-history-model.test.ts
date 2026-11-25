import { describe, expect, test } from "bun:test";
import {
  STORAGE_TIER_BUCKET,
  appPoints,
  availablePoints,
  historyThresholds,
  storageMarkers,
  storageScenarios,
  storageSeries,
} from "../src/components/settings/storage/storage-history.js";
import { storageFormat, thresholdBytes } from "../src/components/settings/storage/storage-volumes.js";
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
  flat,
  historyOf,
  observation,
  observe,
  packRow,
  pressure,
  receipt,
  unavailable,
  worldTime,
} from "./fixtures/storage-volumes.js";

const format = storageFormat("UTC");
// Six-hour buckets: 12 Jul 06:00 is the current one at 09:41.
const sixHour = (hoursAgo: number) => worldTime - hoursAgo * HOUR;

describe("series per identity and tier", () => {
  const history = historyOf([
    observation("six-hour", sixHour(18), [{ identity: ITHACA, available: 20 * GB, app: 30 * GB }, { identity: SCHERIA, available: 50 * GB, app: 8 * GB }]),
    observation("six-hour", sixHour(12), [{ identity: ITHACA, available: 19 * GB, app: 31 * GB }], true),
    observation("six-hour", sixHour(6), [{ identity: SCHERIA, available: 49 * GB, app: 8 * GB }]),
    observation("six-hour", sixHour(0), [{ identity: ITHACA, available: 16.4 * GB, app: null }, { identity: SCHERIA, available: 48 * GB, app: 9 * GB }]),
    observation("daily", worldTime - 2 * DAY, [{ identity: ITHACA, available: 25 * GB, app: 28 * GB }]),
  ]);

  test("points follow the identity and the tier, oldest first", () => {
    const series = storageSeries(history, ITHACA, "six-hour", worldTime);
    expect(series.map((value) => value.at)).toEqual([sixHour(18), sixHour(12), sixHour(6), sixHour(0)]);
    expect(series[0]).toEqual({ at: sixHour(18), available: 20 * GB, appAllocated: 30 * GB, gap: false, provisional: false, otherScope: false });
    expect(storageSeries(history, ITHACA, "daily", worldTime).map((value) => value.available)).toEqual([25 * GB]);
    expect(storageSeries(history, SCHERIA, "six-hour", worldTime).map((value) => value.available)).toEqual([50 * GB, null, 49 * GB, 48 * GB]);
  });

  test("a gap, or an observation without this volume, is null and never 0", () => {
    const series = storageSeries(history, ITHACA, "six-hour", worldTime);
    expect(series[1]).toMatchObject({ gap: true, available: null, appAllocated: null });
    expect(series[2]).toMatchObject({ gap: true, available: null, appAllocated: null });
    expect(availablePoints(series)[1]!.value).toBeNull();
    expect(availablePoints(series)[2]!.value).toBeNull();
  });

  test("an unmeasured App figure stays null beside a measured available", () => {
    const series = storageSeries(history, ITHACA, "six-hour", worldTime);
    expect(series[3]).toMatchObject({ available: 16.4 * GB, appAllocated: null, gap: false });
    expect(appPoints(series)[3]!.value).toBeNull();
  });

  test("only the last point in the current bucket is provisional", () => {
    const series = storageSeries(history, ITHACA, "six-hour", worldTime);
    expect(series.map((value) => value.provisional)).toEqual([false, false, false, true]);
    expect(availablePoints(series)[3]!.provisional).toBe(true);
    // Measured in the previous bucket: final, not provisional.
    expect(storageSeries(history, ITHACA, "six-hour", worldTime + 6 * HOUR).at(-1)!.provisional).toBe(false);
    // Weekly buckets start four days after the epoch: Monday 6 Jul 00:00 UTC opens this week.
    const weekly = historyOf([observation("weekly", Date.UTC(2026, 6, 6, 1), [{ identity: ITHACA, available: 16 * GB, app: 1 }])]);
    expect(storageSeries(weekly, ITHACA, "weekly", worldTime)[0]!.provisional).toBe(true);
    expect(storageSeries(weekly, ITHACA, "weekly", Date.UTC(2026, 6, 13, 0, 1))[0]!.provisional).toBe(false);
  });

  test("points measured under another root scope break from the current series", () => {
    const scoped = historyOf([
      observation("six-hour", sixHour(12), [{ identity: ITHACA, rootScope: "1".repeat(32), available: 30 * GB, app: 1 }]),
      observation("six-hour", sixHour(6), [{ identity: ITHACA, available: 20 * GB, app: 1 }]),
      observation("six-hour", sixHour(0), [{ identity: ITHACA, available: 19 * GB, app: 1 }]),
    ]);
    const series = storageSeries(scoped, ITHACA, "six-hour", worldTime);
    expect(series.map((value) => value.otherScope)).toEqual([true, false, false]);
    expect(availablePoints(series)[0]!.otherScope).toBe(true);
    expect(availablePoints(series)[1]!.otherScope).toBeUndefined();
  });

  test("each tier's bucket interval is the server's, for the chart's single-point padding", () => {
    expect(Object.fromEntries(Object.entries(STORAGE_TIER_BUCKET).map(([tier, value]) => [tier, value.interval]))).toEqual({
      "six-hour": 6 * HOUR,
      daily: DAY,
      weekly: 7 * DAY,
    });
  });

  test("no history is no series", () => {
    expect(storageSeries(null, ITHACA, "six-hour", worldTime)).toEqual([]);
  });

  test("bands are the policy thresholds in this volume's bytes, and absent when its total is unknown", () => {
    expect(historyThresholds(161 * GB)).toEqual(thresholdBytes(161 * GB)!);
    expect(historyThresholds(null)).toEqual({});
  });
});

describe("scenario lines (D9)", () => {
  test("a finite window heads to empty at its days, named by its real span", () => {
    const value = pressure(ITHACA, "low", evidence(ITHACA, 161 * GB, 16 * GB, { short: finite(8, 7), long: finite(20, 30) }));
    expect(storageScenarios(value, format)).toEqual([
      { window: "short", name: "7-day", detail: "empty ~20 Jul", to: { at: worldTime + 8 * DAY, value: 0 } },
      { window: "long", name: "30-day", detail: "empty ~1 Aug", to: { at: worldTime + 20 * DAY, value: 0 } },
    ]);
  });

  test("a non-depleting window runs flat across its own span", () => {
    const value = pressure(ITHACA, "observed", evidence(ITHACA, 161 * GB, 48 * GB, { short: flat(7), long: unavailable("insufficient-span") }));
    expect(storageScenarios(value, format)[0]).toEqual({
      window: "short",
      name: "7-day",
      detail: "not running out",
      to: { at: worldTime + 7 * DAY, value: 48 * GB },
    });
  });

  test("an unavailable window draws no line and passes its reason through", () => {
    const value = pressure(ITHACA, "low", evidence(ITHACA, 161 * GB, 16 * GB, { short: unavailable("gap"), long: unavailable("insufficient-span") }));
    const [short, long] = storageScenarios(value, format);
    expect(short).toEqual({ window: "short", name: "7-day", reason: "gap inside the 7-day window" });
    expect(long).toEqual({ window: "long", name: "30-day", reason: "under 30 days of history" });
    expect("to" in short!).toBe(false);
    const counted = pressure(ITHACA, "low", evidence(ITHACA, 161 * GB, 16 * GB, { short: unavailable("mixed-direction") }));
    expect(storageScenarios(counted, format)[0]!.reason).toBe("space went up and down; no steady rate");
  });

  test("with one qualified window, one line; with none, each says why", () => {
    const one = storageScenarios(pressure(ITHACA, "low", evidence(ITHACA, 161 * GB, 16 * GB)), format);
    expect(one.filter((value) => value.to)).toHaveLength(1);
    expect(storageScenarios(null, format)).toEqual([
      { window: "short", name: "7-day", reason: "no measurements yet" },
      { window: "long", name: "30-day", reason: "no measurements yet" },
    ]);
  });

  test("a changed scope projects nothing", () => {
    const value = pressure(ITHACA, "low", evidence(ITHACA, 161 * GB, 16 * GB, { short: finite(8, 7) }), { scopeChanged: true });
    expect(storageScenarios(value, format).map((line) => [line.to, line.reason])).toEqual([
      [undefined, "volume changed in the window"],
      [undefined, "volume changed in the window"],
    ]);
  });

  test("an unknown latest figure draws no flat line from 0", () => {
    const value = pressure(ITHACA, "observed", evidence(ITHACA, 161 * GB, null, { short: flat(7) }));
    expect(storageScenarios(value, format)[0]).toEqual({ window: "short", name: "7-day", reason: "latest measurement is incomplete" });
  });
});

describe("client-side markers", () => {
  const history = historyOf([
    observation("six-hour", sixHour(30), [{ identity: ITHACA, rootScope: "1".repeat(32), available: 30 * GB, app: 1 }]),
    observation("six-hour", sixHour(24), [{ identity: ITHACA, available: 22 * GB, app: 1 }]),
    observation("six-hour", sixHour(18), [], true),
    observation("six-hour", sixHour(12), [], true),
    observation("six-hour", sixHour(6), [{ identity: ITHACA, available: 18 * GB, app: 1 }]),
    observation("six-hour", sixHour(0), [{ identity: ITHACA, available: 16 * GB, app: 1 }]),
  ]);
  const series = storageSeries(history, ITHACA, "six-hour", worldTime);
  const brain = capacity(ITHACA, brainRoots.map((root) => root.id), 161 * GB, 16 * GB);
  const refused = pressure(ITHACA, "critical", null, {
    causes: { capacity: true, forecast: false, refusals: [{ target: "c".repeat(32), resource: "bytes", at: sixHour(3), successAt: null }] },
  });
  const pack = packRow(receipt({ before: observe([brain], [brainRoots[1]!]), after: observe([brain], [brainRoots[1]!]), completedAt: sixHour(2) }));

  test("gaps, scope changes, refusals and each operation's latest run, numbered in time order", () => {
    const markers = storageMarkers({ series, identity: ITHACA, pressure: refused, maintenance: [pack], now: worldTime, format });
    expect(markers).toEqual([
      { at: sixHour(24), n: 1, tone: "purple", time: "11 Jul 09:41", label: "Scope changed" },
      { at: sixHour(18), n: 2, tone: "neutral", time: "11 Jul 15:41", label: "Collection gap" },
      { at: sixHour(3), n: 3, tone: "red", time: "12 Jul 06:41", label: "Owner refused a write: no space" },
      { at: sixHour(2), n: 4, tone: "teal", time: "12 Jul 07:41", label: "Pack Git objects · done" },
    ]);
  });

  test("a run on another volume, or outside the chart's span, is not marked", () => {
    const other = capacity(SCHERIA, [], 250 * GB, 48 * GB);
    const elsewhere = packRow(receipt({ before: observe([other], []), after: observe([other], []) }));
    const early = packRow(receipt({ before: observe([brain], []), completedAt: sixHour(40) }));
    expect(storageMarkers({ series, identity: ITHACA, maintenance: [elsewhere, early], now: worldTime, format })).toEqual([
      expect.objectContaining({ label: "Scope changed" }),
      expect.objectContaining({ label: "Collection gap" }),
    ]);
    expect(storageMarkers({ series: [], identity: ITHACA, pressure: refused, now: worldTime, format })).toEqual([]);
  });
});
