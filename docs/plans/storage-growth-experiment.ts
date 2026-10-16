/** Offline synthetic design qualification for #2014. No production imports, collection or delivery. */
import { strict as assert } from "node:assert";

const hour = 3_600_000, day = 24 * hour;
const start = Date.parse("2026-07-12T00:00:00Z");
type Sample = { total?: number; gap?: boolean; at: number; scope: string; basis: number; complete: boolean; bytes: number | null; available: number | null };
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

const max = Number.MAX_SAFE_INTEGER;
// At most 12 nullable byte fields per capacity, all at their longest representation.
const capacity = [743, max, max, max, max, 2, max, max, max, max, max, max, max, max];
const worst = [1, 2, 1, max, max, 2, 185, 2, 5, Array.from({ length: 4 }, () => capacity)];
const sampleBytes = Buffer.byteLength(JSON.stringify(worst));
assert.ok(sampleBytes <= 1152, `sample ${sampleBytes} exceeds 1152 bytes`);
const payloadBound = 186 * 1152 + 40960 + 187;
assert.ok(payloadBound <= 256 * 1024);
type Tier = "recent" | "daily" | "weekly";
type Point = Sample & { tier: Tier; gap: boolean };
const widths = { recent: 6 * hour, daily: day, weekly: 7 * day };
const limits = { recent: 64, daily: 90, weekly: 32 };
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
assert.deepEqual([...history.values()].map(points => points.size), [64, 90, 32]);
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

// Distinct available-capacity endpoint windows; no production implementation is imported.
type Forecast = { kind: "depleting"; days: number } | { kind: "non-depleting" } | { kind: "unavailable" };
function forecast(samples: Sample[], now: number, long = false): Forecast {
  const latest = samples.at(-1), points: Sample[] = [];
  if (!latest || latest.at > now || now - latest.at > 6 * hour) return { kind: "unavailable" };
  for (let i = samples.length - 1; i >= 0; i--) {
    const point = samples[i], next = points[0];
    if (!point.complete || point.gap || point.available === null || point.scope !== latest.scope || point.basis !== latest.basis || point.total !== latest.total
      || latest.at - point.at > (long ? 28 : 7) * day || (next && (next.at <= point.at || next.at - point.at > (long ? 48 : 12) * hour))) break;
    points.unshift(point);
  }
  if (points.length < (long ? 15 : 5) || latest.at - points[0].at < (long ? 14 : 2) * day) return { kind: "unavailable" };
  const changes = points.slice(1).map((point, i) => points[i].available! - point.available!);
  const net = points[0].available! - latest.available!;
  if (net === 0) return { kind: changes.every(value => value === 0) ? "non-depleting" : "unavailable" };
  if (changes.filter(value => value * Math.sign(net) >= 0).length / changes.length < 2 / 3
    || Math.max(...changes.map(Math.abs)) > Math.abs(net) / 2) return { kind: "unavailable" };
  if (net < 0) return { kind: "non-depleting" };
  const days = latest.available! / (net / ((latest.at - points[0].at) / day));
  return Number.isFinite(days) ? { kind: "depleting", days } : { kind: "unavailable" };
}
const capacityTrace = (count: number, spacing: number, available: (i: number) => number) => Array.from({ length: count }, (_, i) => ({ ...steady[0], at: start + i * spacing, available: available(i), total: 10_000_000_000 }));
const short = capacityTrace(13, 6 * hour, i => 3_000_000_000 - i * 25_000_000).map(p => ({ ...p, at: p.at + 18 * day }));
const long = capacityTrace(22, day, i => 3_750_000_000 - i * 50_000_000);
const shortResult = forecast(short, short.at(-1)!.at), longResult = forecast(long, long.at(-1)!.at, true);
assert.deepEqual(shortResult, { kind: "depleting", days: 27 });
assert.deepEqual(longResult, { kind: "depleting", days: 54 });
assert.equal(forecast(short.map((p, i) => ({ ...p, total: i === 8 ? p.total + 1 : p.total })), short.at(-1)!.at).kind, "unavailable");
assert.equal(forecast(short, short.at(-1)!.at + 7 * hour).kind, "unavailable");
assert.equal(forecast(short, short.at(-1)!.at - 1).kind, "unavailable");
assert.equal(forecast(short.map((p, i) => ({ ...p, gap: i === 8 })), short.at(-1)!.at).kind, "unavailable");
assert.equal(forecast(short.map((p, i) => ({ ...p, scope: i === 8 ? "troy" : p.scope })), short.at(-1)!.at).kind, "unavailable");
assert.equal(forecast(capacityTrace(13, 6 * hour, i => 3e9 - (i >= 4 ? 1e9 : 0)), start + 3 * day).kind, "unavailable");
assert.equal(forecast(capacityTrace(13, 6 * hour, i => 3e9 + i * 1e7), start + 3 * day).kind, "non-depleting");
assert.equal(forecast(capacityTrace(13, 6 * hour, () => 3e9), start + 3 * day).kind, "non-depleting");
assert.equal(forecast(capacityTrace(13, 6 * hour, i => 3e9 + (i % 2 ? 1e9 : 0)), start + 3 * day).kind, "unavailable");
assert.equal(forecast(long.slice(0, 14), long[13].at, true).kind, "unavailable");
assert.equal(forecast(long.map((p, i) => ({ ...p, complete: i !== 17 })), long.at(-1)!.at, true).kind, "unavailable");
const unknownForecast: Forecast = { kind: "unavailable" };
const depletion = (days: number): Forecast => ({ kind: "depleting", days });
const within = (f: Forecast, days: number) => f.kind === "depleting" && f.days <= days;
const beyond = (f: Forecast, days: number) => f.kind === "non-depleting" || f.kind === "depleting" && f.days > days;
function severity(ratio: number | null, a: Forecast, b: Forecast, refused = false): Severity {
  if (refused || ratio !== null && ratio <= .05 || within(a, 7) && within(b, 7)) return "critical";
  if (ratio !== null && ratio <= .10 || within(a, 30) || within(b, 30)) return "low";
  return "observed";
}
assert.equal(severity(.5, depletion(6), unknownForecast), "low");
assert.equal(severity(.5, depletion(6), depletion(7)), "critical");
assert.equal(severity(.04, unknownForecast, unknownForecast), "critical");
assert.equal(severity(null, unknownForecast, unknownForecast, true), "critical");
assert.equal(severity(.5, shortResult, longResult), "low");
const recoverForecast = (state: "low" | "critical", a: Forecast, b: Forecast) => state === "critical" ? beyond(a, 10) || beyond(b, 10) : beyond(a, 45) && beyond(b, 45);
assert.equal(recoverForecast("critical", unknownForecast, depletion(9)), false);
assert.equal(recoverForecast("critical", unknownForecast, depletion(11)), true);
assert.equal(recoverForecast("low", unknownForecast, depletion(100)), false);
assert.equal(recoverForecast("low", { kind: "non-depleting" }, depletion(46)), true);
// Every active cause must recover. Missing refusal evidence never disappears in a good scan.
const clears = (ratio: number | null, forecastRecovered: boolean, refused: boolean, matchingSuccess: boolean) => ratio !== null && ratio > .07 && forecastRecovered && (!refused || matchingSuccess);
assert.equal(clears(.9, true, true, false), false);
assert.equal(clears(.9, false, false, true), false);
assert.equal(clears(null, true, true, true), false);
assert.equal(clears(.08, true, true, true), true);

// Model durable notification intent/receipt, with no transport or network call.
type Delivery = { phase: "pending" | "sending" | "accepted" | "unknown" | "rejected"; attempts: number };
function deliver(row: Delivery, input: { owner: boolean; active: boolean; fresh: boolean; hour: number | null; outcome: "accepted" | "unknown" | "rejected" }): boolean {
  if (!input.owner || !input.active || !input.fresh || input.hour === null || input.hour >= 22 || input.hour < 8 || row.attempts >= 3 || ["sending", "accepted", "unknown"].includes(row.phase)) return false;
  row.phase = "sending"; row.attempts++; row.phase = input.outcome; return true;
}
const eligible = { owner: true, active: true, fresh: true, hour: 12, outcome: "accepted" as const };
const receipt: Delivery = { phase: "pending", attempts: 0 };
for (const input of [{ ...eligible, owner: false }, { ...eligible, active: false }, { ...eligible, fresh: false }, { ...eligible, hour: 22 }, { ...eligible, hour: 7 }, { ...eligible, hour: null }]) assert.equal(deliver(receipt, input), false);
assert.equal(deliver(receipt, { ...eligible, hour: 8 }), true);
assert.equal(deliver(JSON.parse(JSON.stringify(receipt)), eligible), false); // restart
assert.equal(deliver({ phase: "unknown", attempts: 1 }, eligible), false);
assert.equal(deliver({ phase: "sending", attempts: 1 }, eligible), false); // crash after intent
const retries: Delivery = { phase: "pending", attempts: 0 };
for (let i = 0; i < 3; i++) assert.equal(deliver(retries, { ...eligible, outcome: "rejected" }), true);
assert.equal(deliver(retries, eligible), false);
console.log(JSON.stringify({ fixture: "Odysseus, 2026-07-12", sampleBytes, payloadBound, tierLimits: limits, weeklySpanDays: (weekly.at(-1)!.at - weekly[0].at) / day, scenarios: { shortResult, longResult }, states, delivery: "offline model only; no notifications sent" }, null, 2));
