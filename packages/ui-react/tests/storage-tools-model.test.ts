import { describe, expect, test } from "bun:test";
import { toolChange, toolHeadroom, toolRowView } from "../src/components/settings/storage/storage-tools.js";
import { storageFormat } from "../src/components/settings/storage/storage-volumes.js";
import {
  GB,
  ITHACA,
  SCHERIA,
  appRoots,
  brainRoots,
  capacity,
  evidence,
  guidance,
  observe,
  packRow,
  pressure,
  receipt,
  worldTime,
} from "./fixtures/storage-volumes.js";

const format = storageFormat("UTC");
const git = brainRoots[1]!;
const brainIds = brainRoots.map((root) => root.id);
const before = capacity(ITHACA, brainIds, 161 * GB, 14_600_000_000);
const after = capacity(ITHACA, brainIds, 161 * GB, 16_400_000_000);

describe("measured change", () => {
  test("an unattributed before → after difference on the scope's volume", () => {
    expect(toolChange(receipt({ before: observe([before], [git]), after: observe([after], [git]) }), format)).toEqual({ delta: "+1.8 GB" });
    expect(toolChange(receipt({ before: observe([after], [git]), after: observe([before], [git]) }), format)).toEqual({ delta: "−1.8 GB" });
    expect(toolChange(receipt({ before: observe([after], [git]), after: observe([after], [git]) }), format)).toEqual({ delta: "0 bytes" });
  });

  test("each missing measurement has its reason, never unknown → unknown or 0", () => {
    expect(toolChange(null)).toEqual({ notMeasured: "before measurement missing" });
    expect(toolChange(receipt({ after: observe([after], [git]) }))).toEqual({ notMeasured: "before measurement missing" });
    expect(toolChange(receipt({ before: observe([before], [git]) }))).toEqual({ notMeasured: "after measurement missing" });
    const unknown = capacity(ITHACA, brainIds, 161 * GB, null);
    expect(toolChange(receipt({ before: observe([unknown], [git]), after: observe([after], [git]) }))).toEqual({ notMeasured: "measurement incomplete" });
    expect(toolChange(receipt({ before: observe([before], [git]), after: observe([unknown], [git]) }))).toEqual({ notMeasured: "measurement incomplete" });
  });

  test("a different volume or root set after the run is a changed volume", () => {
    const moved = capacity(SCHERIA, brainIds, 161 * GB, 16 * GB);
    expect(toolChange(receipt({ before: observe([before], [git]), after: observe([moved], [git]) }))).toEqual({ notMeasured: "volume changed" });
    const grown = capacity(ITHACA, [...brainIds, appRoots[0]!.id], 161 * GB, 16 * GB);
    expect(toolChange(receipt({ before: observe([before], [git]), after: observe([grown], [git]) }))).toEqual({ notMeasured: "volume changed" });
    const resized = capacity(ITHACA, brainIds, 200 * GB, 16 * GB);
    expect(toolChange(receipt({ before: observe([before], [git]), after: observe([resized], [git]) }))).toEqual({ notMeasured: "volume changed" });
  });

  test("a scope spread over two volumes is never summed", () => {
    const other = capacity(SCHERIA, [appRoots[0]!.id], 250 * GB, 48 * GB);
    const stores = [git, appRoots[0]!];
    expect(toolChange(receipt({ before: observe([before, other], stores), after: observe([after, other], stores) }))).toEqual({
      notMeasured: "measurement incomplete",
    });
  });
});

describe("headroom", () => {
  const ran = receipt({ before: observe([before], [git]), after: observe([after], [git]) });
  const fresh = guidance([pressure(ITHACA, "low", evidence(ITHACA, 161 * GB, 1_700_000_000))]);

  test("packingRequiredBytes from the latest receipt against fresh evidence", () => {
    expect(toolHeadroom(packRow(ran), fresh, format)).toEqual({
      required: { bytes: 2_100_000_000, text: "2.1 GB" },
      available: { bytes: 1_700_000_000, text: "1.7 GB" },
      shortfall: "400 MB",
    });
  });

  test("no estimate or no fresh evidence is null, never 0", () => {
    const noFigure = receipt({ ...ran, headroom: { ...ran.headroom, packingRequiredBytes: null } });
    expect(toolHeadroom(packRow(noFigure), fresh, format)).toEqual({ required: null, available: { bytes: 1_700_000_000, text: "1.7 GB" } });
    expect(toolHeadroom(packRow(null), fresh, format)).toEqual({ required: null, available: null });
    const old = guidance([pressure(ITHACA, "low", evidence(ITHACA, 161 * GB, 1_700_000_000, { fresh: false }))]);
    expect(toolHeadroom(packRow(ran), old, format)!.available).toBeNull();
    const unknown = guidance([pressure(ITHACA, "low", evidence(ITHACA, 161 * GB, null))]);
    expect(toolHeadroom(packRow(ran), unknown, format)!.available).toBeNull();
    expect(toolHeadroom(packRow(ran), null, format)!.available).toBeNull();
  });

  test("only pack-git has an estimate", () => {
    expect(toolHeadroom(packRow(ran, { id: "prune-scratch" }), fresh, format)).toBeUndefined();
  });
});

describe("the row", () => {
  test("a finished run reads its time, change and effect", () => {
    const view = toolRowView(packRow(receipt({ before: observe([before], [git]), after: observe([after], [git]) })), null, format);
    expect(view).toMatchObject({
      name: "Pack Git objects",
      description: "Pack local objects and refs; history and reflogs remain.",
      state: "complete",
      at: "12 Jul 07:41",
      change: { delta: "+1.8 GB" },
      effect: "maintain",
      available: true,
      unavailableReason: null,
    });
  });

  test("never run, running, refused and unavailable", () => {
    expect(toolRowView(packRow(null), null, format)).toMatchObject({ state: "never" });
    expect(toolRowView(packRow(null), null, format).at).toBeUndefined();
    const running = toolRowView(packRow(receipt({ state: "running", completedAt: null, startedAt: worldTime - 60_000 })), null, format);
    expect(running).toMatchObject({ state: "running", at: "12 Jul 09:40" });
    expect(running.change).toBeUndefined();
    expect(toolRowView(packRow(receipt({ state: "refused", reason: "no_space" })), null, format)).toMatchObject({ state: "refused", reason: "no space" });
    expect(toolRowView(packRow(null, { available: false, reason: "headroom-unavailable" }), null, format)).toMatchObject({
      available: false,
      unavailableReason: "headroom unavailable",
    });
  });

  test("a partial run keeps only the counts it has", () => {
    const view = toolRowView(
      packRow(receipt({ state: "partial", outcome: { items: [], truncated: false, removed: 41, failed: null, deferred: 2, packed: null, pinnedFiles: null, pinnedBytes: null, overageBytes: null, suspended: false } })),
      null,
      format
    );
    expect(view.counts).toEqual({ packed: null, removed: 41, failed: null, deferred: 2, suspended: false });
    expect(view.change).toEqual({ notMeasured: "before measurement missing" });
  });
});
