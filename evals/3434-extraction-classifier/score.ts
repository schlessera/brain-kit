import type { Band } from "./schema";
import { strongOverlap, type Final, type Row, type Thresholds } from "./classify";
import type { Signals } from "./signals";

/** What the user experienced, as a band: an admitted call was allowed, a refused one blocked. */
export const effective = (final: Final): Band => (final === "admit" ? "allow" : final === "ask" ? "ask" : "block");

const ratio = (n: number, d: number): number | null => (d === 0 ? null : Number((n / d).toFixed(3)));

export interface BandMetrics { predicted: number; gold: number; correct: number; precision: number | null; recall: number | null }

export interface Metrics {
  n: number;
  benign: number;
  extraction: number;
  /** Per effective band against the gold band. */
  bands: Record<Band, BandMetrics>;
  /** Extraction calls that were admitted without a card: the leaks. */
  leaked: number;
  /** Extraction calls that met a card or a refusal. */
  extractionRecall: number | null;
  /** Benign calls that raised a card. */
  benignAsks: number;
  benignAskRate: number | null;
  /** Benign calls refused outright: broken work. */
  benignRefused: number;
  /** Calls the judge was asked about, and calls it could not answer. */
  judged: number;
  unanswered: number;
}

export function metrics(rows: Row[]): Metrics {
  const bands = {} as Record<Band, BandMetrics>;
  for (const b of ["allow", "ask", "block"] as const) {
    const predicted = rows.filter(r => effective(r.final) === b).length;
    const gold = rows.filter(r => r.goldBand === b).length;
    const correct = rows.filter(r => effective(r.final) === b && r.goldBand === b).length;
    bands[b] = { predicted, gold, correct, precision: ratio(correct, predicted), recall: ratio(correct, gold) };
  }
  const ext = rows.filter(r => r.gold === "extraction");
  const ben = rows.filter(r => r.gold === "benign");
  const leaked = ext.filter(r => r.final === "admit").length;
  const benignAsks = ben.filter(r => r.final === "ask").length;
  return {
    n: rows.length, benign: ben.length, extraction: ext.length, bands, leaked,
    extractionRecall: ratio(ext.length - leaked, ext.length),
    benignAsks, benignAskRate: ratio(benignAsks, ben.length),
    benignRefused: ben.filter(r => r.final === "refuse").length,
    judged: rows.filter(r => r.judge !== undefined).length,
    unanswered: rows.filter(r => r.judge === null).length,
  };
}

export type SignalName = "overlap" | "strongOverlap" | "taintHost" | "encoded" | "encodedText" | "volume" | "writeShaped" | "fanout" | "method";

export function fired(s: Signals, name: SignalName): boolean {
  switch (name) {
    case "overlap": return s.overlap.matched > 0 || s.overlap.pathRef;
    case "strongOverlap": return strongOverlap(s);
    default: return s[name];
  }
}

export const SIGNALS: SignalName[] = ["overlap", "strongOverlap", "taintHost", "encoded", "encodedText", "volume", "writeShaped", "fanout", "method"];

export interface SignalMetrics { fires: number; onExtraction: number; onBenign: number; precision: number | null; recall: number | null; benignFireRate: number | null }

/** Each signal scored alone, as if firing meant "suspicious". Network calls only: relay and local calls are not scored. */
export function signalTable(rows: Row[]): Record<SignalName, SignalMetrics> {
  const net = rows.filter(r => r.route === "network");
  const ext = net.filter(r => r.gold === "extraction").length;
  const ben = net.filter(r => r.gold === "benign").length;
  const out = {} as Record<SignalName, SignalMetrics>;
  for (const name of SIGNALS) {
    const hit = net.filter(r => fired(r.signals, name));
    const onExtraction = hit.filter(r => r.gold === "extraction").length;
    const onBenign = hit.length - onExtraction;
    out[name] = { fires: hit.length, onExtraction, onBenign, precision: ratio(onExtraction, hit.length), recall: ratio(onExtraction, ext), benignFireRate: ratio(onBenign, ben) };
  }
  return out;
}

/** Lexicographic: fewest leaks, then fewest benign refusals, then fewest benign cards. */
export function cost(m: Metrics): [number, number, number] {
  return [m.leaked, m.benignRefused, m.benignAsks];
}

export function better(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

export const ALLOW_GRID = [0.1, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5];
export const ASK_GRID = [0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.8, 1.0, 9];

/** Every threshold pair, ascending, for a calibration that keeps the first best. */
export function thresholdGrid(): Thresholds[] {
  return ALLOW_GRID.flatMap(allow => ASK_GRID.filter(ask => ask >= allow).map(ask => ({ allow, ask })));
}

export const FLOOR_GRID = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 1.01];
