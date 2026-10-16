import { expect, test } from "bun:test";
import { DAY, HOUR, RECENT, HISTORY_LIMITS, bucket, bucketStart, hashScope, jsonBytes, retainAggregate, validateHistory, type Aggregate, type HistoryPayload } from "../src/storage/history-model.js";
import { capacityEvidence } from "../src/storage/history-evidence.js";

const at = Date.UTC(2026, 6, 12);
const identity = hashScope("Odysseus volume"), scope = hashScope("Odysseus stores");
const empty = (): HistoryPayload<{ marker: string }> => ({ metadata: { samples: {}, capacities: {}, state: { marker: "Odysseus" } }, samples: [] });
function observation(time: number, available = 900_000_000, partial = false): Aggregate {
  return { at: time, startedAt: time - 100, source: 0, descriptor: ["0.44.0", scope, 1], coverage: partial ? 1 : 0, reason: partial ? 1 : 0,
    capacities: [{ descriptor: [identity, scope], values: [1_000_000_000, 1_000_000_000 - available, available, available, partial ? 1 : 0, 40_000, 4096, 30_000 + (time - at) / HOUR, 8192 + (time - at) / HOUR, 20_000, 4096, 90_000, 16384] }] };
}
function steady(days = 30, available: (index: number) => number = index => 900_000_000 - index * 1_000_000) {
  let payload = empty();
  for (let index = 0; index <= days * 4; index++) payload = retainAggregate(payload, observation(at + index * RECENT, available(index)));
  return payload;
}

test("one observation updates all tiers, Monday weeks and actual endpoint timestamps", () => {
  const payload = retainAggregate(empty(), observation(at + 10 * HOUR));
  expect(payload.samples.map(row => row[1])).toEqual([0, 1, 2]);
  expect(payload.samples.every(row => row[3] === at + 10 * HOUR)).toBe(true);
  expect(new Date(bucketStart(2, bucket(2, at))).getUTCDay()).toBe(1);
  expect(payload.samples.map(row => row[2])).toEqual([0, 1, 1]);
});
test("186 full records remain bounded by tier age, slots, dictionaries and canonical bytes", () => {
  let payload = empty();
  for (let index = 0; index < 240 * 4; index++) {
    const input = observation(at + index * RECENT);
    input.capacities = Array.from({ length: 4 }, (_, slot) => ({ descriptor: [hashScope(`Odysseus ${slot}`), scope], values: [...input.capacities[0]!.values] }));
    payload = retainAggregate(payload, input);
  }
  expect(payload.samples.length, "STORAGE_HISTORY_186_SLOTS").toBe(186);
  expect(([0, 1, 2] as const).map(tier => payload.samples.filter(row => row[1] === tier).length)).toEqual([64, 90, 32]);
  const latest = payload.samples.at(-1)![3];
  expect(payload.samples.every(row => bucket(row[1], row[3]) >= bucket(row[1], latest) - HISTORY_LIMITS.slots[row[1]] + 1)).toBe(true);
  expect(jsonBytes(payload)).toBeLessThanOrEqual(262144);
  expect(jsonBytes(payload.metadata)).toBeLessThanOrEqual(40960);
  expect(Object.keys(payload.metadata.samples)).toHaveLength(1);
  expect(Object.keys(payload.metadata.capacities)).toHaveLength(4);
});
test("worst safe numeric fields obey per-sample and combined metadata limits", () => {
  const input = observation(Number.MAX_SAFE_INTEGER);
  input.startedAt = input.at;
  input.descriptor[0] = "v".repeat(32);
  input.capacities = Array.from({ length: 4 }, (_, index) => ({ descriptor: [hashScope(index), scope], values: [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER] }));
  const payload = retainAggregate(empty(), input);
  expect(Math.max(...payload.samples.map(jsonBytes))).toBeLessThanOrEqual(1152);
  payload.metadata.state.marker = "x".repeat(40960);
  expect(() => validateHistory(payload), "STORAGE_HISTORY_SHARED_METADATA_CAP").toThrow("history-metadata-budget");
});
test("partial refresh preserves complete endpoints but makes bucket gaps sticky", () => {
  let payload = retainAggregate(empty(), observation(at));
  payload = retainAggregate(payload, observation(at + HOUR, 100_000, true));
  expect(payload.samples.every(row => row[3] === at && row[2] === 1 && row[7] === 0)).toBe(true);
  payload = retainAggregate(payload, observation(at + 2 * HOUR));
  expect(payload.samples.every(row => row[3] === at + 2 * HOUR && row[2] === 1)).toBe(true);
});
test("missed final intervals, outages and scope changes mark actual points without filling gaps", () => {
  let payload = retainAggregate(empty(), observation(at));
  payload = retainAggregate(payload, observation(at + 2 * DAY));
  expect(payload.samples.filter(row => row[1] === 0).map(row => row[3])).toEqual([at, at + 2 * DAY]);
  expect(payload.samples.find(row => row[1] === 1 && row[3] === at)?.[2]).toBe(1);
  const changed = observation(at + 2 * DAY + RECENT); changed.descriptor[1] = hashScope("Troy stores");
  payload = retainAggregate(payload, changed);
  expect(payload.samples.filter(row => row[3] === changed.at).every(row => row[2] === 1)).toBe(true);
  const later = retainAggregate(payload, observation(at + 300 * DAY));
  expect(later.samples).toHaveLength(3);
});
test("clock reversal refuses before mutating previous evidence and descriptor references", () => {
  const payload = steady(1), encoded = JSON.stringify(payload);
  expect(() => retainAggregate(payload, observation(at)), "STORAGE_HISTORY_CLOCK_REVERSES_PAUSE").toThrow("history-clock-reversal");
  expect(JSON.stringify(payload)).toBe(encoded);
});
test("dictionary churn stops at the shared byte ceiling, retaining prior valid evidence", () => {
  let payload = empty(), failed = false;
  for (let index = 0; index < 1500; index++) {
    const input = observation(at + index * RECENT);
    input.descriptor = ["v".repeat(32), hashScope(`Odysseus epoch ${index}`), 1];
    input.capacities = Array.from({ length: 4 }, (_, slot) => ({ descriptor: [hashScope(`${index}:${slot}`), hashScope(`scope ${index}:${slot}`)], values: [...input.capacities[0]!.values] }));
    const before = JSON.stringify(payload);
    try { payload = retainAggregate(payload, input); }
    catch (error) {
      expect(String(error), "STORAGE_HISTORY_DICTIONARY_CHURN_PAUSES").toContain("history-metadata-budget");
      expect(JSON.stringify(payload)).toBe(before); validateHistory(payload); failed = true; break;
    }
  }
  expect(failed).toBe(true);
});
test("short/long scenarios and observed App growth use distinct endpoint quantities", () => {
  const payload = steady(), now = at + 30 * DAY, result = capacityEvidence(payload, identity, now)!;
  expect(result.short.state).toBe("finite"); expect(result.long.state).toBe("finite");
  expect(result.short.depletionPerDay).toBe(4_000_000);
  expect(result.long.depletionPerDay).toBe(4_000_000);
  expect(result.short.days).toBe(195); expect(result.long.days).toBe(195);
  expect(result.appAllocated?.bytesPerDay).toBe(24);
  expect(result.availableChange?.bytesPerDay).toBe(-4_000_000);
  expect(result.long.samples).toBeLessThanOrEqual(29);
});
test("minimum spans, stale/future evidence and gaps refuse scenarios without infinity", () => {
  const payload = steady(1), now = at + DAY;
  expect(capacityEvidence(payload, identity, now)?.short.reason).toBe("insufficient-span");
  expect(capacityEvidence(payload, identity, now + RECENT + 1)?.short.reason).toBe("stale");
  expect(capacityEvidence(payload, identity, now - 1)?.short.reason).toBe("future");
  const gapped = steady(); gapped.samples.filter(row => row[1] === 0).at(-2)![2] = 1;
  expect(capacityEvidence(gapped, identity, at + 30 * DAY)?.short.state).toBe("unavailable");
  const longGap = steady(); longGap.samples.filter(row => row[1] === 1).at(-2)![2] = 1;
  expect(capacityEvidence(longGap, identity, at + 30 * DAY)?.long.state).toBe("unavailable");
});
test("flat and smooth replenishment are qualified non-depletion; burst and zero-net reversal refuse", () => {
  for (const values of [() => 500_000_000, (i: number) => 500_000_000 + i * 1_000_000]) {
    const result = capacityEvidence(steady(30, values), identity, at + 30 * DAY)!;
    expect(result.short.state).toBe("non-depleting"); expect(result.short.days).toBeNull();
    expect(result.long.state).toBe("non-depleting");
  }
  const burst = steady(30, i => i < 119 ? 800_000_000 : 400_000_000);
  expect(capacityEvidence(burst, identity, at + 30 * DAY)?.short.reason).toBe("single-burst");
  const mixed = steady(30, i => 500_000_000 + (i % 2) * 1_000_000);
  expect(capacityEvidence(mixed, identity, at + 30 * DAY)?.short.reason).toBe("mixed-direction");
});
test("changed capacity, roots, unknown allocation and unrounded zero horizon preserve evidence boundaries", () => {
  const payload = steady();
  const latest = payload.samples.filter(row => row[1] === 0).at(-1)!;
  latest[9][0]![1] = 2_000_000_000;
  expect(capacityEvidence(payload, identity, at + 30 * DAY)?.short.state, "STORAGE_HISTORY_COMPARABLE_TOTAL").toBe("unavailable");
  const absent = steady(); absent.samples.filter(row => row[1] === 0).at(-2)![9][0]![9] = null;
  expect(capacityEvidence(absent, identity, at + 30 * DAY)?.appAllocated).toBeNull();
  const zero = steady(30, i => (120 - i) * 1_000_000);
  expect(capacityEvidence(zero, identity, at + 30 * DAY)?.short.days).toBe(0);
});

test("collector patch versions keep comparable scopes without manufacturing gaps", () => {
  const payload = steady(3), latest = payload.samples.filter(row => row[1] === 0).at(-1)![3];
  const next = observation(latest + RECENT, 887_000_000); next.descriptor[0] = "0.44.1";
  const changed = retainAggregate(payload, next);
  expect(changed.samples.find(row => row[1] === 0 && row[3] === next.at)?.[2], "STORAGE_PATCH_VERSION_SAME_BASIS").toBe(0);
  expect(capacityEvidence(changed, identity, next.at)?.short.state).toBe("finite");
});
