// Three ledgers: what the tooling costs, what the voyage cost, and what the
// waiting is costing at home.
//
// Only the first is denominated in money, and that is the point. The modern
// half of this world bills in cents per run; the ancient half bills in men and
// animals, and the second ledger is the one that matters. Putting them in the
// same file, in the same shape, is the whole collision in one screen.
//
// No IBAN appears anywhere in this world, and none should be added. ISO 13616
// reserves no range for testing, so every mod-97-valid IBAN a generator
// produces could belong to a live account. A world with no bank accounts in it
// sidesteps the problem entirely -- which is the cheapest way to comply.
//
// Every figure is stored as an integer (cents, men, head of livestock) and
// formatted once, on the way out.

import { usd } from "./runs.js";
import type { BarRow, TableColumn, TableRow, TrendSeries } from "./types.js";

/* ---------------------------------------------------- ledger 1: the spend */

/** Seven days of agent spend, by agent, in cents. */
export const weekSpendCents: Record<string, number> = {
  researcher: 520,
  ledger: 210,
  "note-filer": 160,
  "source-watch": 50,
};

export const weekSpendTotalCents = Object.values(weekSpendCents).reduce((a, b) => a + b, 0);

/** The spend cap, in cents. The budget-stop screen is what happens at 100%. */
export const weekCapCents = 3_500;

/** `BarList` rows for "where it went", derived so the bars cannot lie. */
export const weekSpend: BarRow[] = (
  [
    ["researcher", "amber"],
    ["ledger", "neutral"],
    ["note-filer", "teal"],
    ["source-watch", "red"],
  ] as const
).map(([label, tone]) => ({
  label,
  pct: Math.round((weekSpendCents[label]! / weekSpendTotalCents) * 100),
  value: usd(weekSpendCents[label]!),
  tone,
}));

/** The meter above the bars: percentage of the weekly cap consumed. */
export const weekSpendMeter = {
  value: Math.round((weekSpendTotalCents / weekCapCents) * 100),
  valueText: `${usd(weekSpendTotalCents)} / ${usd(weekCapCents)}`,
  label: "spend",
};

/** Seven daily totals, in cents. They sum to `weekSpendTotalCents`. */
export const weekDailyCents = [90, 120, 80, 240, 110, 260, 40];

export const spendTrend: TrendSeries = {
  label: "Spend · last 7 days",
  value: usd(weekSpendTotalCents),
  delta: "+18% vs prev",
  deltaTone: "red",
  values: weekDailyCents,
  ticks: ["M", "T", "W", "T", "F", "S", "S"],
  tone: "purple",
};

/**
 * Today's autonomy, as the queue screen's three row meters. The reserve is
 * red from the moment it exists, not from the moment it is spent.
 */
export const autonomyMeters = [
  { label: "spend", value: 38, valueText: `${usd(40)} / ${usd(105)}`, tone: "teal" as const },
  { label: "turns", value: 64, valueText: "23 / 36", tone: "amber" as const },
  { label: "reserve", value: 12, valueText: `${usd(13)} held`, tone: "red" as const },
];

/* ----------------------------------------------------- ledger 2: the crew */

export interface CrewLoss {
  place: string;
  lost: number;
  cause: string;
}

/**
 * Six hundred men out of Troy in twelve ships, and where each one of them
 * stopped. The entries sum to exactly 600 and the survivors count is 1; both
 * are asserted in the fixture test, because a ledger that does not balance is
 * not a ledger.
 */
export const crewLosses: CrewLoss[] = [
  { place: "Ismarus", lost: 72, cause: "would not leave the wine" },
  { place: "Land of the Cyclopes", lost: 6, cause: "eaten" },
  { place: "Land of the Laestrygonians", lost: 484, cause: "eleven ships, in harbour" },
  { place: "Aeaea", lost: 1, cause: "fell from a roof" },
  { place: "Scylla", lost: 6, cause: "taken from the deck" },
  { place: "Thrinacia", lost: 31, cause: "the oath, then the storm" },
];

export const crewEmbarked = 600;
export const crewLost = crewLosses.reduce((a, l) => a + l.lost, 0);
export const crewSurvivors = 1;
export const shipsEmbarked = 12;
export const shipsReturned = 0;

/** The crew ledger as a `DataTable` -- three columns, right-aligned count. */
export const crewTable: { columns: TableColumn[]; rows: TableRow[] } = {
  // `w` is a FIXED WIDTH IN PIXELS, not a percentage. These were once 40/16/44
  // -- a percentage split that sums to 100 -- which rendered a 16px "Lost"
  // column and wrapped every cell, including single digits. The design's own
  // pattern is what is used here: the prose columns carry no `w` and share the
  // remaining space, and only the numeric column is pinned.
  columns: [
    { label: "Where" },
    { label: "Lost", w: 44, align: "right" },
    { label: "Cause" },
  ],
  rows: crewLosses.map((l) => ({
    cells: [
      { v: l.place },
      { v: String(l.lost), mono: true, bold: true, tone: l.lost > 100 ? "red" : "gold" },
      { v: l.cause, tone: "neutral" },
    ],
  })),
};

/**
 * The same ledger as bars, for the screen that wants proportion, not detail.
 *
 * One tone for every row: a bar's tone is the CLASS of work, never a
 * judgement (`BarList`'s contract, #309), and these rows are one series. The
 * over-a-hundred judgement lives in `crewTable`'s cells, where a cell tone is
 * a judgement and draws its glyph.
 */
export const crewBars: BarRow[] = crewLosses.map((l) => ({
  label: l.place,
  pct: Math.round((l.lost / crewEmbarked) * 100),
  value: String(l.lost),
  tone: "neutral",
}));

/* --------------------------------------------------- ledger 3: the estate */

export interface StoreLine {
  label: string;
  consumed: number;
  held: number;
}

/**
 * What one hundred and eight guests have eaten in four years. Not money --
 * Ithaca does not keep accounts in coin -- but it is the same ledger shape,
 * and it is the number Penelope actually watches.
 */
export const estateStores: StoreLine[] = [
  { label: "swine", consumed: 1_180, held: 1_800 },
  { label: "sheep", consumed: 640, held: 1_200 },
  { label: "goats", consumed: 410, held: 1_200 },
  { label: "cattle", consumed: 96, held: 720 },
  { label: "wine, jars", consumed: 812, held: 1_000 },
];

export const estateGuests = 108;
export const estateDays = 1_460;

const estateConsumed = estateStores.reduce((a, s) => a + s.consumed, 0);
const estateHeld = estateStores.reduce((a, s) => a + s.held, 0);

/** Percentage of the household's stores already gone. */
export const estateDrawdown = Math.round((estateConsumed / estateHeld) * 100);

/** One series, one tone, as with `crewBars`: the bar says how much, and the
 * value column says it in words. Whether that is too much is a judgement,
 * which a bar's tone never is (#309). */
export const estateBars: BarRow[] = estateStores.map((s) => ({
  label: s.label,
  pct: Math.round((s.consumed / s.held) * 100),
  value: `${s.consumed} of ${s.held}`,
  tone: "neutral",
}));

/** The line under the bars, stated flatly. */
export const estateFootnote = `${estateGuests} guests · ${estateDays} days · nobody has been invoiced`;
