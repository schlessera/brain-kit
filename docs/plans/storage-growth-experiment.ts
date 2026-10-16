/** Offline synthetic design qualification for #2014. No production imports or policy. */
import { strict as assert } from "node:assert";

const hour = 3_600_000, day = 24 * hour;
const start = Date.parse("2026-07-12T00:00:00Z");
type Sample = { gap?: boolean; at: number; scope: string; basis: number; complete: boolean; bytes: number | null; available: number | null };
function rate(samples: Sample[]): number | null {
  const last = samples.at(-1);
  if (!last?.complete || last.gap || last.bytes === null) return null;
  const window: Sample[] = [last];
  for (let i = samples.length - 2; i >= 0; i--) {
    const value = samples[i], next = window[0];
    if (!value.complete || value.gap || value.bytes === null || value.scope !== last.scope || value.basis !== last.basis || next.at <= value.at || next.at - value.at > 12 * hour || last.at - value.at > 7 * day) break;
    window.unshift(value);
  }
  const first = window[0], span = last.at - first.at;
  return window.length >= 5 && span >= 2 * day ? (last.bytes - first.bytes!) / (span / day) : null;
}
const trace = (value: (i: number) => number): Sample[] => Array.from({ length: 13 }, (_, i) => ({ at: start + i * 6 * hour, scope: "ithaca", basis: 1, complete: true, bytes: value(i), available: 8_000_000_000 }));
const steady = trace(i => 1_000_000_000 + i * 30_000_000);
const burst = trace(i => 1_000_000_000 + (i >= 4 ? 600_000_000 : 0));
const reclaim = trace(i => 1_000_000_000 - i * 10_000_000);
const changed = steady.map((s, i) => ({ ...s, scope: i >= 8 ? "new-ithaca" : s.scope }));
const partial = steady.map((s, i) => ({ ...s, complete: i !== 8 }));
const unknown = steady.map((s, i) => ({ ...s, bytes: i === 8 ? null : s.bytes }));
const concurrent = trace(() => 1_000_000_000).map((s, i) => ({ ...s, available: 8_000_000_000 - i * 100_000_000 }));
assert.equal(rate(steady), 120_000_000);
assert.equal(rate(burst), 200_000_000);
assert.equal(rate(reclaim), -40_000_000);
assert.equal(rate(steady.map((sample, i) => ({ ...sample, at: i === 10 ? start + 80 * hour : sample.at }))), null);
assert.equal(rate(steady.map((sample, i) => ({ ...sample, gap: i === 8 }))), null);
assert.equal(rate(changed), null); assert.equal(rate(partial), null); assert.equal(rate(unknown), null);
assert.equal(rate(concurrent), 0); assert.equal(concurrent[0].available! - concurrent.at(-1)!.available!, 1_200_000_000);

type Severity = "observed" | "low" | "critical";
function episode(values: { at: number; available: number | null; fresh: boolean; refused?: boolean }[]): Severity[] {
  let state: Severity = "observed", qualifying: number | null = null;
  return values.map(sample => {
    const ratio = sample.available === null ? null : sample.available / 100;
    if (sample.refused || (sample.fresh && ratio !== null && ratio <= 0.05)) { state = "critical"; qualifying = null; }
    else if (sample.fresh && ratio !== null) {
      if (state === "observed" && ratio <= 0.10) state = "low";
      const clears = state === "critical" ? ratio > 0.07 : state === "low" ? ratio > 0.12 : false;
      if (!clears) qualifying = null;
      else if (qualifying === null) qualifying = sample.at;
      else if (sample.at - qualifying >= 60_000) { state = state === "critical" ? "low" : "observed"; qualifying = null; }
    } else qualifying = null;
    return state;
  });
}
const oscillation = [9, 11, 9, 13, 13, 4, null, 8, 8].map((available, i) => ({ at: start + i * 60_000, available, fresh: true }));
const states = episode(oscillation);
assert.deepEqual(states, ["low", "low", "low", "low", "observed", "critical", "critical", "critical", "low"]);
assert.deepEqual(episode([{ at: start, available: null, fresh: true, refused: true }]), ["critical"]);
assert.deepEqual(episode([{ at: start, available: 4, fresh: true }, { at: start + hour, available: 90, fresh: false }]), ["critical", "critical"]);

const max = Number.MAX_SAFE_INTEGER, hash = "f".repeat(32);
const capacity = { id: hash, scope: hash, total: max, used: max, free: max, available: max, coverage: "complete", owners: [[max, max], [max, max], [max, max]], union: [max, max] };
const worst = { v: 1, tier: "weekly", gap: false, at: max, start: max, source: "scheduled", collector: "x".repeat(32), scope: hash, basis: 1, coverage: "complete", reason: "scope-limit", caps: Array.from({ length: 4 }, () => capacity) };
const sampleBytes = Buffer.byteLength(JSON.stringify(worst));
assert.ok(sampleBytes <= 1792, `sample ${sampleBytes} exceeds 1792 bytes`);
const payloadBound = 128 * 1792 + 2048;
assert.ok(payloadBound <= 256 * 1024);
type Tier = "recent" | "daily" | "weekly";
type Point = Sample & { tier: Tier; gap: boolean };
const widths = { recent: 6 * hour, daily: day, weekly: 7 * day };
const limits = { recent: 64, daily: 32, weekly: 32 };
const epoch = Date.parse("1970-01-05T00:00:00Z"); // Monday
const bucket = (at: number, tier: Tier) => Math.floor((at - epoch) / widths[tier]);
const history = new Map<Tier, Map<number, Point>>(
  (["recent", "daily", "weekly"] as Tier[]).map(tier => [tier, new Map()]),
);
let last: Sample | null = null;
function retain(sample: Sample): boolean {
  if (last && sample.at < last.at) return false;
  for (const [tier, points] of history) {
    const key = bucket(sample.at, tier), previous = points.get(key);
    // Closing a bucket with no observation in its final six-hour interval is a gap.
    for (const [oldKey, point] of points) {
      if (oldKey < key && bucket(point.at, "recent") < (oldKey + 1) * widths[tier] / widths.recent - 1) point.gap = true;
      if (oldKey < key - limits[tier] + 1) points.delete(oldKey);
    }
    const missed = previous
      ? bucket(sample.at, "recent") - bucket(previous.at, "recent") > 1
      : bucket(sample.at, "recent") > key * widths[tier] / widths.recent;
    const changed = !!last && (last.scope !== sample.scope || last.basis !== sample.basis);
    const gap = !!previous?.gap || missed || changed || !sample.complete || sample.bytes === null;
    // A failed refresh preserves complete evidence, but never erases its gap.
    points.set(key, { ...(previous?.complete && !sample.complete ? previous : sample), tier, gap });
    assert.ok(points.size <= limits[tier]);
  }
  last = sample;
  return true;
}
for (let i = 0; i < 365 * 4; i++) retain({ ...steady[0], at: start + i * 6 * hour });
assert.deepEqual([...history.values()].map(points => points.size), [64, 32, 32]);
const weekly = [...history.get("weekly")!.values()];
assert.ok(weekly.at(-1)!.at - weekly[0].at >= 210 * day);
const beforeReverse = JSON.stringify([...history.values()].map(points => [...points]));
assert.equal(retain(steady[0]), false);
assert.equal(JSON.stringify([...history.values()].map(points => [...points])), beforeReverse);
// Three missed intervals within the next UTC day remain visible after a good endpoint.
const nextDay = start + 365 * day;
retain({ ...steady[0], at: nextDay });
retain({ ...steady[0], at: nextDay + 18 * hour });
assert.equal(history.get("daily")!.get(bucket(nextDay, "daily"))!.gap, true);
retain({ ...steady[0], at: nextDay + 19 * hour });
assert.equal(history.get("daily")!.get(bucket(nextDay, "daily"))!.gap, true);
const afterOutage = nextDay + 400 * day;
retain({ ...steady[0], at: afterOutage });
assert.deepEqual([...history.values()].map(points => points.size), [1, 1, 1]);
console.log(JSON.stringify({ fixture: "Odysseus, 2026-07-12", ratesBytesPerDay: { steady: rate(steady), burst: rate(burst), reclaim: rate(reclaim), changed: rate(changed), partial: rate(partial), unknown: rate(unknown), concurrent: rate(concurrent) }, states, retainedOnly: "critical; no eligible cleanup; provide capacity", exhaustionEstimate: null, sampleBytes, payloadBound, tierLimits: limits, weeklySpanDays: (weekly.at(-1)!.at - weekly[0].at) / day }, null, 2));
