import { describe, expect, test } from "bun:test";
import { historySeries, parseHistory } from "../src/lib/stats-history";
import { evaluateStatsTrends, type TrendMetric } from "../src/lib/stats-trends";

const NOW = new Date("2026-09-30T12:00:00.000Z");
const thresholds = { coverageFloor: 0.9, brokenLinkCeiling: 0.05 };
interface Row { date: string; at: string; version: string | null; links: number | null; brokenLinks: number | null; health: { embeddingCoverage: number | null; brokenLinkRate: number | null; orphans: number | null } }
function rows(): Row[] {
  return Array.from({ length: 14 }, (_, i) => {
    const date = new Date(Date.UTC(2026, 8, 17 + i)).toISOString().slice(0, 10);
    const recent = i >= 7;
    return { date, at: `${date}T12:00:00.000Z`, version: "0.40.0", links: 100, brokenLinks: recent ? 10 : 3,
      health: { embeddingCoverage: recent ? 0.7 : 0.9, brokenLinkRate: recent ? 0.1 : 0.03, orphans: recent ? 15 : 10 } };
  });
}
function verdict(metric: TrendMetric, data = rows(), levels = thresholds, now = NOW) {
  const history = historySeries(parseHistory(data.map(r => JSON.stringify(r)).join("\n")));
  const result = evaluateStatsTrends(history, levels, now);
  expect(result.verdicts).toHaveLength(3);
  return result.verdicts.find(v => v.metric === metric)!;
}

describe("core-owned stats trends", () => {
  test("compares exact non-overlapping UTC windows with nonempty evidence", () => {
    const v = verdict("embeddingCoverage");
    expect(v.state).toBe("warning");
    expect(v.baseline).toMatchObject({ start: "2026-09-17", end: "2026-09-23", samples: 7, median: 0.9 });
    expect(v.recent).toMatchObject({ start: "2026-09-24", end: "2026-09-30", samples: 7, median: 0.7 });
    expect(v.baseline.dates).toHaveLength(7);
    expect(v.recent.dates).toHaveLength(7);
    expect(v.message).toContain("2026-09-17");
    expect(v.message).toContain("0.7");
  });

  test("ordinary even medians average the two middle observations", () => {
    const data = rows().filter((_, i) => i < 4 || i >= 10);
    [1, 0.5, 0, 0.75, 0.75, 0.25, 0.625, 0.375].forEach((x, i) => data[i].health.embeddingCoverage = x);
    const v = verdict("embeddingCoverage", data);
    expect(v.baseline.samples).toBe(4);
    expect(v.baseline.median).toBe(0.625);
    expect(v.recent.median).toBe(0.5);
    expect(v.state).toBe("warning");
  });

  test.each([
    [0.1, 0.05, 0.09, "warning"],
    [0.1, 0.050001, 0.09, "measured-no-warning"],
    [0.1, 0.05, 0.05, "measured-no-warning"],
    [0.1, 0.05, 0.051, "warning"],
  ] as const)("coverage change/floor boundary %s to %s, floor %s", (baseline, recent, floor, expected) => {
    const data = rows();
    data.forEach((r, i) => r.health.embeddingCoverage = i < 7 ? baseline : recent);
    const v = verdict("embeddingCoverage", data, { ...thresholds, coverageFloor: floor });
    expect(v.state).toBe(expected);
    expect(v.rule.currentThreshold).toBe(floor);
    expect(v.change).toBe(recent - baseline);
    expect(v.message).toContain(String(recent));
  });

  test.each([
    [3, 300, 0, "warning"],
    [3, 301, 0, "measured-no-warning"],
    [1, 100, 0, "measured-no-warning"],
    [3, 300, 0.01, "measured-no-warning"],
    [3, 300, 0.009, "warning"],
  ] as const)("broken-link paired change/count/ceiling boundary %s/%s ceiling %s", (n, links, ceiling, expected) => {
    const data = rows();
    data.forEach((r, i) => { r.brokenLinks = i < 7 ? 0 : n; r.links = links; r.health.brokenLinkRate = i < 7 ? 0 : n / links; });
    const v = verdict("brokenLinks", data, { ...thresholds, brokenLinkCeiling: ceiling });
    expect(v.state).toBe(expected);
    expect(v.countChange).toBe(n);
    expect(v.change).toBe(n / links);
    expect(v.baseline.countMedian).toBe(0);
    expect(v.recent.countMedian).toBe(n);
  });

  test.each([
    [25, 30, "warning"],
    [30, 35, "measured-no-warning"],
    [10, 14, "measured-no-warning"],
    [0, 5, "warning"],
    [0, 4, "measured-no-warning"],
  ] as const)("orphan absolute/relative/zero boundary %s to %s", (baseline, recent, expected) => {
    const data = rows();
    data.forEach((r, i) => r.health.orphans = i < 7 ? baseline : recent);
    const v = verdict("orphans", data);
    expect(v.state).toBe(expected);
    expect(v.relativeChange).toBe(baseline === 0 ? null : (recent - baseline) / baseline);
    expect(v.message).not.toContain("Infinity");
  });

  test("broken-link rate and count medians use identical paired rows", () => {
    const data = rows();
    data.slice(7).forEach((r, i) => {
      r.links = 100;
      r.brokenLinks = i < 3 ? 2 : i < 5 ? null : 100;
      r.health.brokenLinkRate = i < 3 ? 0.02 : i < 5 ? 0.5 : null;
    });
    data[9].at = "2026-09-26T12:00:00Z";
    // Make the paired observations fresh while retaining actual daily slots.
    data[13].brokenLinks = 2; data[13].health.brokenLinkRate = 0.02;
    const v = verdict("brokenLinks", data);
    expect(v.recent.samples).toBe(4);
    expect(v.recent.median).toBe(0.02);
    expect(v.recent.countMedian).toBe(2);
    expect(v.state).toBe("measured-no-warning");
  });

  test("independent rate/count samples would fabricate a warning where paired history is insufficient", () => {
    const data = rows();
    data.slice(7).forEach((r, i) => {
      r.links = 100;
      r.health.brokenLinkRate = i < 3 ? 0.5 : i < 5 ? null : 0.02;
      r.brokenLinks = i < 3 ? null : i < 5 ? 100 : 2;
    });
    const v = verdict("brokenLinks", data);
    expect(v.recent.samples).toBe(2);
    expect(v.recent.median).toBe(0.02);
    expect(v.recent.countMedian).toBe(2);
    expect(v.state).toBe("insufficient");
    // Independent lists give rate median 0.5, count median 51: all warning
    // gates would appear met against the actual baseline 0.03 / 3.
    expect(v.baseline).toMatchObject({ median: 0.03, countMedian: 3 });
  });

  test.each(["zero", "missing", "inconsistent", "negative", "fractional"])("invalid broken-link denominator/count (%s) is excluded", kind => {
    const data = rows();
    data.slice(7).forEach(r => {
      if (kind === "zero") r.links = 0;
      if (kind === "missing") r.links = null;
      if (kind === "inconsistent") r.health.brokenLinkRate = 0.9;
      if (kind === "negative") r.brokenLinks = -1;
      if (kind === "fractional") r.brokenLinks = 0.5;
    });
    const v = verdict("brokenLinks", data);
    expect(v.recent.samples).toBe(0);
    expect(v.recent.median).toBeNull();
    expect(v.state).toBe("insufficient");
  });

  test("three valid days per metric per window are required; missing is never zero", () => {
    const data = rows();
    data.forEach((r, i) => { if (i < 5 || (i > 6 && i < 11)) r.health.embeddingCoverage = null; });
    let v = verdict("embeddingCoverage", data);
    expect(v.baseline.samples).toBe(2);
    expect(v.recent.samples).toBe(3);
    expect(v.state).toBe("insufficient");
    expect(v.change).toBeNull();
    data[4].health.embeddingCoverage = 0.9;
    v = verdict("embeddingCoverage", data);
    expect(v.state).toBe("warning");
    data[13].health.embeddingCoverage = null;
    expect(verdict("embeddingCoverage", data).state).toBe("insufficient");
  });

  test("sparse observations outside the calendar windows cannot pad the baseline", () => {
    const data = rows();
    data.slice(0, 5).forEach((r, i) => { r.date = `2026-08-${17 + i}`; r.at = `${r.date}T12:00:00Z`; });
    const v = verdict("orphans", data);
    expect(v.baseline.samples).toBe(2);
    expect(v.state).toBe("insufficient");
  });

  test("latest used observation must be within 48 hours, inclusively", () => {
    const data = rows().slice(0, 12);
    expect(verdict("orphans", data).state).toBe("warning");
    data[11].at = "2026-09-28T11:59:59.000Z";
    const v = verdict("orphans", data);
    expect(v.state).toBe("stale");
    expect(v.latestAt).toBe(data[11].at);
    expect(v.change).toBeNull();
  });

  test("future dates and future recording timestamps cannot influence evaluation", () => {
    const data = rows();
    data.push({ ...data[0], date: "2026-10-01", at: "2026-10-01T00:00:00Z", version: "unknown" });
    data.push({ ...data[13] }); // A valid older duplicate must not be a fallback.
    data[13].at = "2026-09-30T12:00:00.001Z";
    data[13].version = "unknown";
    const v = verdict("embeddingCoverage", data);
    expect(v.recent.samples).toBe(6);
    expect(v.latestAt).toBe("2026-09-29T12:00:00.000Z");
    expect(v.state).toBe("warning");
  });

  test("missing/invalid recordings and retimestamped calendar days are not valid observations", () => {
    const data = rows();
    data.slice(7).forEach((r, i) => { r.at = i === 0 ? "" : i === 1 ? "not-a-date" : "2026-09-17T12:00:00Z"; });
    const v = verdict("orphans", data);
    expect(v.recent.samples).toBe(0);
    expect(v.state).toBe("insufficient");
  });

  test("same-day entries use the existing reader's later-recording semantics", () => {
    const data = rows();
    const newer = { ...data[13], at: "2026-09-30T11:00:00Z", health: { ...data[13].health, orphans: 999 } };
    data.push(newer);
    const v = verdict("orphans", data);
    expect(v.recent.samples).toBe(7);
    expect(v.recent.median).toBe(15);
    expect(v.latestAt).toBe(data[13].at);
  });

  test.each([null, "bogus", "0.41.0", "0.40.1", "0.40.0-dev"])("unknown/unsupported version %s is incomparable", version => {
    const data = rows();
    data[13].version = version;
    const v = verdict("orphans", data);
    expect(v.state).toBe("incomparable");
    expect(v.change).toBeNull();
  });

  test("pre/post eligibility coverage definitions are incomparable, while counts remain comparable", () => {
    const data = rows();
    data.slice(0, 7).forEach(r => r.version = "0.38.0");
    expect(verdict("embeddingCoverage", data).state).toBe("incomparable");
    expect(verdict("brokenLinks", data).state).toBe("warning");
    expect(verdict("orphans", data).state).toBe("warning");
  });

  test("0.39.0 development coverage provenance is ambiguous even within one version", () => {
    const data = rows(); data.forEach(r => r.version = "0.39.0");
    expect(verdict("embeddingCoverage", data).state).toBe("incomparable");
    expect(verdict("orphans", data).state).toBe("warning");
  });

  test("missing, nonfinite and out-of-range metric values are excluded without mutating history", () => {
    const h = historySeries(parseHistory(rows().map(r => JSON.stringify(r)).join("\n")));
    h.health.embeddingCoverage = [null, -1, 2, NaN, Infinity, null, 0.9, ...Array(7).fill(0.7)];
    const saved = structuredClone(h);
    const result = evaluateStatsTrends(h, thresholds, NOW);
    expect(result.verdicts[0].baseline.samples).toBe(1);
    expect(result.verdicts[0].state).toBe("insufficient");
    expect(h).toEqual(saved);
    expect(evaluateStatsTrends(h, thresholds, NOW)).toEqual(result);
  });
});
