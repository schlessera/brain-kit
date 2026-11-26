import { describe, expect, test } from "bun:test";
import type {
  StorageEvent,
  StorageEventsResponse,
  StorageMaintenanceEvent,
  StoragePressureEvent,
} from "@schlessera/brain-ui-sdk/protocol";
import {
  storageEventText,
  storageMarkers,
  storageSeries,
  storageTimelineNote,
} from "../src/components/settings/storage/storage-history.js";
import {
  TIMELINE_EVENTS,
  TIMELINE_PAGES,
  readStorageTimeline,
  type StorageTimeline,
} from "../src/components/settings/storage/storage-timeline.js";
import { storageFormat } from "../src/components/settings/storage/storage-volumes.js";
import {
  GB,
  HOUR,
  ITHACA,
  SCHERIA,
  brainRoots,
  capacity,
  historyOf,
  observation,
  observe,
  packRow,
  pressure,
  receipt,
  worldTime,
} from "./fixtures/storage-volumes.js";

const format = storageFormat("UTC");
const sixHour = (hoursAgo: number) => worldTime - hoursAgo * HOUR;
const MINUTE = 60_000;
const running = { pressure: false, refusal: false, scope: false, maintenance: false };
const timeline = (events: StorageEvent[], paused: Partial<StorageTimeline["paused"]> = {}): StorageTimeline => ({
  events,
  paused: { ...running, ...paused },
  next: events.at(-1)?.seq ?? 0,
});
const warning = (
  seq: number,
  at: number,
  phase: StoragePressureEvent["phase"],
  severity: StoragePressureEvent["severity"],
  identity = ITHACA
): StoragePressureEvent => ({ seq, at, kind: "pressure", identity, phase, severity, episode: 1 });
const finished = (seq: number, at: number, id = "pack-ithaca", state: "complete" | "refused" = "complete"): Extract<StorageMaintenanceEvent, { phase: "finished" }> => ({
  seq,
  at,
  kind: "maintenance",
  receipt: id,
  operation: "pack-git",
  phase: "finished",
  state,
  reason: null,
});
const requested = (seq: number, at: number, id = "pack-ithaca"): StorageMaintenanceEvent => ({
  seq,
  at,
  kind: "maintenance",
  receipt: id,
  operation: "pack-git",
  phase: "requested",
});

// One scope, no gaps: the series itself derives no markers.
const steady = storageSeries(
  historyOf([24, 18, 12, 6, 0].map((ago) => observation("six-hour", sixHour(ago), [{ identity: ITHACA, available: (20 - ago / 6) * GB, app: 1 }]))),
  ITHACA,
  "six-hour",
  worldTime
);
const brain = capacity(ITHACA, brainRoots.map((root) => root.id), 161 * GB, 16 * GB);
const onIthaca = (extra: Parameters<typeof receipt>[0] = {}) =>
  packRow(receipt({ before: observe([brain], [brainRoots[1]!]), after: observe([brain], [brainRoots[1]!]), ...extra }));

describe("timeline markers (#4548)", () => {
  test("low → critical → low → observed is four markers at the server's times, numbered in time order", () => {
    const events = [
      warning(1, sixHour(20) + 13 * MINUTE, "start", "low"),
      warning(2, sixHour(15) + 2 * MINUTE, "step", "critical"),
      warning(3, sixHour(8) + 41 * MINUTE, "step", "low"),
      warning(4, sixHour(4) + 5 * MINUTE, "end", "observed"),
    ];
    expect(storageMarkers({ series: steady, identity: ITHACA, timeline: timeline(events), now: worldTime, format })).toEqual([
      { at: sixHour(20) + 13 * MINUTE, n: 1, tone: "gold", time: "11 Jul 13:54", label: "Low warning started" },
      { at: sixHour(15) + 2 * MINUTE, n: 2, tone: "red", time: "11 Jul 18:43", label: "Warning changed to Very low" },
      { at: sixHour(8) + 41 * MINUTE, n: 3, tone: "gold", time: "12 Jul 02:22", label: "Warning changed to Low" },
      { at: sixHour(4) + 5 * MINUTE, n: 4, tone: "teal", time: "12 Jul 05:46", label: "Warning ended · back to OK" },
    ]);
  });

  test("events of another volume are not drawn; events outside the tier's span are not numbered", () => {
    const events = [
      warning(1, sixHour(40), "start", "low"),
      warning(2, sixHour(10), "start", "critical", SCHERIA),
      warning(3, sixHour(9), "end", "observed"),
    ];
    expect(storageMarkers({ series: steady, identity: ITHACA, timeline: timeline(events), now: worldTime, format })).toEqual([
      expect.objectContaining({ n: 1, at: sixHour(9), label: "Warning ended · back to OK" }),
    ]);
  });

  test("events that share a time keep their recording order", () => {
    const at = sixHour(10);
    const events: StorageEvent[] = [
      { seq: 7, at, kind: "refusal", identity: ITHACA, phase: "refused", target: "c".repeat(32), resource: "bytes" },
      warning(8, at, "start", "critical"),
    ];
    expect(storageMarkers({ series: steady, identity: ITHACA, timeline: timeline(events), now: worldTime, format }).map((m) => m.label)).toEqual([
      "Owner refused a write: no space",
      "Very low warning started",
    ]);
    // Recording order, not the words: the warning ended before the write succeeded.
    const later: StorageEvent[] = [
      warning(9, at, "end", "observed"),
      { seq: 10, at, kind: "refusal", identity: ITHACA, phase: "succeeded", target: "c".repeat(32), resource: "bytes" },
    ];
    expect(storageMarkers({ series: steady, identity: ITHACA, timeline: timeline(later), now: worldTime, format }).map((m) => m.n + " " + m.label)).toEqual([
      "1 Warning ended · back to OK",
      "2 Owner write succeeded after a refusal: no space",
    ]);
  });

  test("a run reported by the latest receipt and the timeline appears once, at the timeline's time", () => {
    // The receipt says 07:41; the timeline's finished event, matched by receipt id and phase, says 07:42.
    const pack = onIthaca({ requestedAt: sixHour(3), startedAt: sixHour(3), completedAt: sixHour(2) });
    const events = [requested(1, sixHour(3)), finished(2, sixHour(2) + MINUTE)];
    const markers = storageMarkers({ series: steady, identity: ITHACA, maintenance: [pack], timeline: timeline(events), now: worldTime, format });
    expect(markers).toEqual([{ at: sixHour(2) + MINUTE, n: 1, tone: "teal", time: "12 Jul 07:42", label: "Pack Git objects · done" }]);
  });

  test("runs are never matched by time: another receipt at the same time is its own marker", () => {
    const pack = onIthaca({ completedAt: sixHour(2) });
    const markers = storageMarkers({
      series: steady,
      identity: ITHACA,
      maintenance: [pack],
      timeline: timeline([finished(1, sixHour(2), "pack-earlier", "refused")]),
      now: worldTime,
      format,
    });
    // The timeline's event leads at a shared time; the receipt is still its own marker.
    expect(markers.map((m) => [m.at, m.label])).toEqual([
      [sixHour(2), "Pack Git objects · refused"],
      [sixHour(2), "Pack Git objects · done"],
    ]);
  });

  test("a running receipt and the timeline's request are one marker; its finish replaces both", () => {
    const pack = onIthaca({ state: "running", requestedAt: sixHour(3), startedAt: sixHour(3) + MINUTE, completedAt: null });
    const asked = storageMarkers({ series: steady, identity: ITHACA, maintenance: [pack], timeline: timeline([requested(1, sixHour(3))]), now: worldTime, format });
    expect(asked).toEqual([expect.objectContaining({ n: 1, at: sixHour(3), label: "Pack Git objects · requested", tone: "neutral" })]);
    const done = storageMarkers({
      series: steady,
      identity: ITHACA,
      maintenance: [pack],
      timeline: timeline([requested(1, sixHour(3)), finished(2, sixHour(1))]),
      now: worldTime,
      format,
    });
    expect(done).toEqual([expect.objectContaining({ n: 1, at: sixHour(1), label: "Pack Git objects · done" })]);
  });

  test("a run whose receipt observed another volume stays off this one; a run with no loaded receipt is drawn", () => {
    const other = capacity(SCHERIA, [], 250 * GB, 48 * GB);
    const elsewhere = packRow(receipt({ before: observe([other], []), after: observe([other], []) }));
    const events = [finished(1, sixHour(2)), finished(2, sixHour(5), "pack-older")];
    expect(
      storageMarkers({ series: steady, identity: ITHACA, maintenance: [elsewhere], timeline: timeline(events), now: worldTime, format }).map((m) => m.at)
    ).toEqual([sixHour(5)]);
  });

  test("a refusal the timeline opened is not repeated from pressure; a newer one after its resolution is", () => {
    const target = "c".repeat(32);
    const refused = (at: number) =>
      pressure(ITHACA, "critical", null, { causes: { capacity: true, forecast: false, refusals: [{ target, resource: "bytes", at, successAt: null }] } });
    const open: StorageEvent[] = [{ seq: 1, at: sixHour(5), kind: "refusal", identity: ITHACA, phase: "refused", target, resource: "bytes" }];
    // Pressure keeps the latest refusal's time; the timeline keeps the first.
    expect(
      storageMarkers({ series: steady, identity: ITHACA, pressure: refused(sixHour(3)), timeline: timeline(open), now: worldTime, format }).map((m) => [m.at, m.label])
    ).toEqual([[sixHour(5), "Owner refused a write: no space"]]);
    const resolved: StorageEvent[] = [...open, { seq: 2, at: sixHour(4), kind: "refusal", identity: ITHACA, phase: "succeeded", target, resource: "bytes" }];
    expect(
      storageMarkers({ series: steady, identity: ITHACA, pressure: refused(sixHour(3)), timeline: timeline(resolved, { refusal: true }), now: worldTime, format }).map((m) => [m.at, m.label])
    ).toEqual([
      [sixHour(5), "Owner refused a write: no space"],
      [sixHour(4), "Owner write succeeded after a refusal: no space"],
      [sixHour(3), "Owner refused a write: no space"],
    ]);
  });

  test("a scope change the timeline recorded replaces the series' own in the same bucket", () => {
    const scoped = storageSeries(
      historyOf([
        observation("six-hour", sixHour(12), [{ identity: ITHACA, rootScope: "1".repeat(32), available: 30 * GB, app: 1 }]),
        observation("six-hour", sixHour(6), [{ identity: ITHACA, available: 20 * GB, app: 1 }]),
        observation("six-hour", sixHour(0), [{ identity: ITHACA, available: 19 * GB, app: 1 }]),
      ]),
      ITHACA,
      "six-hour",
      worldTime
    );
    expect(storageMarkers({ series: scoped, identity: ITHACA, now: worldTime, format }).map((m) => m.at)).toEqual([sixHour(6)]);
    const change: StorageEvent = { seq: 1, at: sixHour(7), kind: "scope", identity: ITHACA, phase: "changed", rootScope: "b".repeat(32), previousRootScope: "1".repeat(32) };
    expect(storageMarkers({ series: scoped, identity: ITHACA, timeline: timeline([change]), now: worldTime, format })).toEqual([
      { at: sixHour(7), n: 1, tone: "purple", time: "12 Jul 02:41", label: "Scope changed" },
    ]);
  });

  test("a recorded scope change replaces the series' own across an observation that does not hold the volume", () => {
    // The series compares scopes past an observation without the volume, so
    // the change it marks at sixHour(6) happened after sixHour(12).
    const scoped = storageSeries(
      historyOf([
        observation("six-hour", sixHour(12), [{ identity: ITHACA, rootScope: "1".repeat(32), available: 30 * GB, app: 1 }]),
        observation("six-hour", sixHour(9), [{ identity: SCHERIA, available: 40 * GB, app: 1 }]),
        observation("six-hour", sixHour(6), [{ identity: ITHACA, available: 20 * GB, app: 1 }]),
        observation("six-hour", sixHour(0), [{ identity: ITHACA, available: 19 * GB, app: 1 }]),
      ]),
      ITHACA,
      "six-hour",
      worldTime
    );
    expect(storageMarkers({ series: scoped, identity: ITHACA, now: worldTime, format }).map((m) => [m.at, m.label])).toEqual([
      [sixHour(9), "Collection gap"],
      [sixHour(6), "Scope changed"],
    ]);
    const change: StorageEvent = { seq: 1, at: sixHour(10), kind: "scope", identity: ITHACA, phase: "changed", rootScope: "b".repeat(32), previousRootScope: "1".repeat(32) };
    expect(storageMarkers({ series: scoped, identity: ITHACA, timeline: timeline([change]), now: worldTime, format }).map((m) => [m.at, m.label])).toEqual([
      [sixHour(10), "Scope changed"],
      [sixHour(9), "Collection gap"],
    ]);
  });

  test("without a timeline the markers are the client's alone", () => {
    const pack = onIthaca({ completedAt: sixHour(2) });
    const refused = pressure(ITHACA, "critical", null, {
      causes: { capacity: true, forecast: false, refusals: [{ target: "c".repeat(32), resource: "bytes", at: sixHour(3), successAt: null }] },
    });
    const input = { series: steady, identity: ITHACA, pressure: refused, maintenance: [pack], now: worldTime, format };
    const client = storageMarkers(input);
    expect(client.map((m) => m.label)).toEqual(["Owner refused a write: no space", "Pack Git objects · done"]);
    expect(storageMarkers({ ...input, timeline: null })).toEqual(client);
    expect(storageMarkers({ ...input, timeline: timeline([]) })).toEqual(client);
  });
});

describe("event labels and tones", () => {
  test("each kind and phase has its words and tone", () => {
    const at = worldTime,
      target = "c".repeat(32);
    const rows: Array<[StorageEvent, string, string]> = [
      [warning(1, at, "start", "low"), "Low warning started", "gold"],
      [warning(1, at, "start", "critical"), "Very low warning started", "red"],
      [warning(1, at, "step", "critical"), "Warning changed to Very low", "red"],
      [warning(1, at, "step", "low"), "Warning changed to Low", "gold"],
      [warning(1, at, "recovery-started", "critical"), "Recovery from Very low began", "blue"],
      [warning(1, at, "end", "observed"), "Warning ended · back to OK", "teal"],
      [{ seq: 1, at, kind: "refusal", identity: ITHACA, phase: "refused", target, resource: "quota" }, "Owner refused a write: quota reached", "red"],
      [{ seq: 1, at, kind: "refusal", identity: ITHACA, phase: "succeeded", target, resource: "inodes" }, "Owner write succeeded after a refusal: no file slots", "teal"],
      [{ seq: 1, at, kind: "scope", identity: ITHACA, phase: "changed", rootScope: "b".repeat(32), previousRootScope: "1".repeat(32) }, "Scope changed", "purple"],
      [requested(1, at), "Pack Git objects · requested", "neutral"],
      [finished(1, at), "Pack Git objects · done", "teal"],
      [finished(1, at, "x", "refused"), "Pack Git objects · refused", "red"],
      [{ ...finished(1, at), operation: "cleanup-staging", state: "partial" }, "Settled share staging cleanup · partly done", "gold"],
    ];
    for (const [event, label, tone] of rows) expect(storageEventText(event)).toEqual({ label, tone } as never);
    // A loaded row names its own operation.
    expect(storageEventText(finished(1, at), [packRow(null, { label: "Pack history" })]).label).toBe("Pack history · done");
  });

  test("a paused kind is an evidence note, not an error", () => {
    expect(storageTimelineNote(null)).toBeNull();
    expect(storageTimelineNote(timeline([]))).toBeNull();
    expect(storageTimelineNote(timeline([], { pressure: true, maintenance: true }))).toBe(
      "Event timeline paused for warnings, maintenance runs · earlier events kept; later ones are not marked"
    );
  });
});

describe("reading the timeline with since", () => {
  const page = (since: number, events: StorageEvent[], paused = running): StorageEventsResponse => ({
    version: 1,
    since,
    next: events.at(-1)?.seq ?? since,
    limits: { pressure: 256, refusal: 128, scope: 64, maintenance: 512, payloadBytes: 262144 },
    paused,
    events,
  });
  /** Serves `pages`, then empty pages that report `paused`. */
  function server(pages: StorageEventsResponse[], paused = running) {
    const asked: number[] = [];
    return {
      asked,
      read: async (since: number) => {
        asked.push(since);
        return pages.shift() ?? page(since, [], paused);
      },
    };
  }

  test("continues from next until a page is empty, then continues from there on the next read", async () => {
    const s = server([page(0, [warning(1, 1, "start", "low"), warning(2, 2, "end", "observed")]), page(2, [warning(5, 5, "start", "low")])]);
    const first = await readStorageTimeline(s.read, null);
    expect(s.asked).toEqual([0, 2, 5]);
    expect(first).toEqual({ events: [expect.objectContaining({ seq: 1 }), expect.objectContaining({ seq: 2 }), expect.objectContaining({ seq: 5 })], paused: running, next: 5 });
    // The latest page's paused state is the timeline's.
    const more = server([page(5, [warning(6, 6, "end", "observed")])], { ...running, scope: true });
    const second = await readStorageTimeline(more.read, first);
    expect(more.asked).toEqual([5, 6]);
    expect(second!.events.map((event) => event.seq)).toEqual([1, 2, 5, 6]);
    expect(second!.paused.scope).toBe(true);
  });

  test("stops at its page bound and keeps the newest events within its event bound", async () => {
    let seq = 0;
    const endless = async (since: number) =>
      page(since, Array.from({ length: 400 }, () => warning(++seq, seq, "step", "low")));
    const value = await readStorageTimeline(endless, null);
    expect(seq).toBe(TIMELINE_PAGES * 400);
    expect(value!.events).toHaveLength(TIMELINE_EVENTS);
    expect(value!.events.at(-1)!.seq).toBe(seq);
    expect(value!.next).toBe(seq);
  });

  test("an older host's 404, a failure or a malformed page leaves what was read", async () => {
    const before = timeline([warning(1, 1, "start", "low")]);
    const missing = async () => {
      throw new Error("Storage request failed (404).");
    };
    await expect(readStorageTimeline(missing, before)).rejects.toThrow("404");
    expect(await readStorageTimeline(async () => ({ version: 2 }) as never, before)).toEqual(before);
    expect(await readStorageTimeline(async () => ({ version: 2 }) as never, null)).toBeNull();
    // A page that does not continue from its since is not this timeline.
    expect(await readStorageTimeline(async () => page(0, []), timeline([warning(9, 9, "start", "low")]))).toEqual(
      timeline([warning(9, 9, "start", "low")])
    );
  });
});
