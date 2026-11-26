/**
 * The epic's two cross-cutting rules (#4537), checked over everything the
 * view models produce for one fixture: no output holds two capacities added
 * together, and no unknown input comes out as 0.
 */
import { describe, expect, test } from "bun:test";
import {
  appPoints,
  availablePoints,
  historyThresholds,
  storageMarkers,
  storageScenarios,
  storageSeries,
} from "../src/components/settings/storage/storage-history.js";
import { storageConsumerRows } from "../src/components/settings/storage/storage-consumers.js";
import { toolRowView } from "../src/components/settings/storage/storage-tools.js";
import { storageFormat, storageVolumes } from "../src/components/settings/storage/storage-volumes.js";
import {
  HOUR,
  ITHACA,
  SCHERIA,
  appRoots,
  brainRoots,
  capacity,
  evidence,
  guidance,
  historyOf,
  inventory,
  node,
  observation,
  observe,
  packRow,
  page,
  pressure,
  receipt,
  twoVolumes,
  worldTime,
} from "./fixtures/storage-volumes.js";

const format = storageFormat("UTC");

/** Every number and string anywhere in a value. */
function leaves(value: unknown, numbers: number[] = [], strings: string[] = []) {
  if (typeof value === "number") numbers.push(value);
  else if (typeof value === "string") strings.push(value);
  else if (Array.isArray(value)) for (const item of value) leaves(item, numbers, strings);
  else if (value && typeof value === "object") for (const item of Object.values(value)) leaves(item, numbers, strings);
  return { numbers, strings };
}

describe("no combined total", () => {
  test("with two volumes, no output holds any figure of one added to the other's", () => {
    const { brain, app, inventory: snapshot, guidance: response } = twoVolumes();
    const history = historyOf([
      observation("six-hour", worldTime - 6 * HOUR, [
        { identity: ITHACA, available: brain.available, app: 30_000_000_000, total: brain.total! },
        { identity: SCHERIA, available: app.available, app: 9_000_000_000, total: app.total! },
      ]),
      observation("six-hour", worldTime, [
        { identity: ITHACA, available: brain.available, app: 30_100_000_000, total: brain.total! },
        { identity: SCHERIA, available: app.available, app: 9_100_000_000, total: app.total! },
      ]),
    ]);
    const volumes = storageVolumes({ guidance: response, inventory: snapshot, history, format });
    const rows = [packRow(receipt({ before: observe([brain, app], [...brainRoots, ...appRoots]), after: observe([brain, app], [...brainRoots, ...appRoots]) }))];
    const output = {
      volumes,
      charts: [ITHACA, SCHERIA].map((identity) => {
        const series = storageSeries(history, identity, "six-hour", worldTime);
        const view = response.capacities.find((value) => value.identity === identity);
        return {
          series,
          available: availablePoints(series),
          app: appPoints(series),
          thresholds: historyThresholds(identity === ITHACA ? brain.total : app.total),
          scenarios: storageScenarios(view, format),
          markers: storageMarkers({ series, identity, pressure: view, maintenance: rows, now: worldTime, format }),
        };
      }),
      tools: rows.map((row) => toolRowView(row, response, format)),
      consumers: storageConsumerRows(page([...brainRoots, ...appRoots].map(node)), "allocated", { inventory: snapshot }),
    };
    const { numbers, strings } = leaves(output);
    const sums = (["total", "used", "free", "available"] as const).map((key) => brain[key]! + app[key]!);
    for (const sum of sums) {
      expect(numbers).not.toContain(sum);
      expect(strings.some((text) => text.includes(format.bytes(sum)))).toBe(false);
    }
    // The scope of the run spans both volumes: its change is not measured rather than summed.
    expect(output.tools[0]!.change).toEqual({ notMeasured: "measurement incomplete" });
    // Each volume keeps its own figures.
    expect(volumes.map((volume) => volume.capacity?.total ?? null)).toEqual([app.total, brain.total]);
  });
});

describe("unknown is never 0", () => {
  const unknownCapacity = capacity(ITHACA, brainRoots.map((root) => root.id), null, null, { kind: "unknown" });
  const unknownHistory = historyOf([
    observation("six-hour", worldTime, [{ identity: ITHACA, available: null, app: null }]),
    observation("six-hour", worldTime - 6 * HOUR, [], true),
  ]);
  const unknownPressure = pressure(ITHACA, "low", evidence(ITHACA, null, null, { availableChange: null, short: { ...evidence(ITHACA, 1, 1).short, state: "non-depleting", days: null } }));

  test("gauge figures and threshold bytes", () => {
    const [volume] = storageVolumes({ guidance: guidance([unknownPressure]), inventory: inventory([unknownCapacity], brainRoots), format });
    expect(volume!.capacity).toBeUndefined();
    expect(volume!.thresholdBytes).toBeNull();
    expect(volume!.trend).toBe("unknown");
  });

  test("chart points, sparkline points and bands", () => {
    const series = storageSeries(unknownHistory, ITHACA, "six-hour", worldTime);
    expect(series.map((value) => [value.available, value.appAllocated])).toEqual([
      [null, null],
      [null, null],
    ]);
    expect(availablePoints(series).map((value) => value.value)).toEqual([null, null]);
    expect(appPoints(series).map((value) => value.value)).toEqual([null, null]);
    expect(historyThresholds(null)).toEqual({});
  });

  test("scenario lines", () => {
    // Non-depleting with no latest figure: no flat line drawn at 0.
    expect(storageScenarios(unknownPressure, format)[0]!.to).toBeUndefined();
  });

  test("consumer sizes", () => {
    const unknownRoot = { ...appRoots[3]! };
    const [row] = storageConsumerRows(page([node(unknownRoot)]), "allocated").rows;
    expect([row!.bytes, row!.size, row!.share]).toEqual([null, null, undefined]);
  });

  test("tool change and headroom", () => {
    const unknown = capacity(ITHACA, brainRoots.map((root) => root.id), 161_000_000_000, null);
    const run = receipt({ before: observe([unknown], [brainRoots[1]!]), after: observe([unknown], [brainRoots[1]!]), headroom: { requiredBytes: null, packingRequiredBytes: null, reservation: false, note: "" } });
    const view = toolRowView(packRow(run), guidance([unknownPressure]), format);
    expect(view.change).toEqual({ notMeasured: "measurement incomplete" });
    expect(view.headroom).toEqual({ required: null, available: null });
  });
});
