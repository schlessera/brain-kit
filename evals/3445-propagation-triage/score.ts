export type Label = "still_current" | "needs_update" | "uncertain";
export interface Row {
  id: string;
  split: "tuning" | "held-out";
  arm: "current" | "candidate" | "deterministic";
  rep: number;
  gold: Label;
  label: Label;
  invalid: boolean;
  fallback: boolean;
  confidence?: number;
}

/** Only an accepted still-current answer suppresses forwarding. */
export function gate(row: Row, floor: number): Row {
  return row.label === "still_current" && (row.invalid || (row.confidence ?? 0) < floor)
    ? { ...row, label: "uncertain", fallback: true } : { ...row };
}

export function metrics(rows: Row[]) {
  const accepts = rows.filter(r => r.label === "still_current" && !r.invalid);
  const safe = rows.filter(r => r.gold === "still_current");
  const unsafe = rows.filter(r => r.gold !== "still_current");
  const falseAcknowledgements = accepts.filter(r => r.gold !== "still_current");
  const ids = [...new Set(rows.map(r => r.id))];
  const agree = ids.filter(id => {
    const group = rows.filter(r => r.id === id);
    return group.length === 3 && new Set(group.map(r => r.rep)).size === 3 &&
      new Set(group.map(r => JSON.stringify([r.label, r.invalid, r.fallback]))).size === 1;
  });
  return {
    n: rows.length, correct: rows.filter(r => !r.invalid && r.label === r.gold).length,
    accepted: accepts.length, falseAcknowledgements: falseAcknowledgements.length,
    falseAcknowledgementCases: [...new Set(falseAcknowledgements.map(r => r.id))],
    safePrecision: accepts.length ? (accepts.length - falseAcknowledgements.length) / accepts.length : null,
    safeCoverage: safe.length ? accepts.filter(r => r.gold === "still_current").length / safe.length : null,
    forwardingRecall: unsafe.length ? unsafe.filter(r => r.label !== "still_current" || r.invalid).length / unsafe.length : null,
    invalid: rows.filter(r => r.invalid).length, fallbacks: rows.filter(r => r.fallback).length,
    uncertain: rows.filter(r => r.label === "uncertain").length,
    agreement: { cases: ids.length, agreeing: agree.length },
  };
}

export const FLOOR_GRID = [0, 0.4, 0.6, 0.8, 0.9, 0.99, 1.01];
export function calibrate(rows: Row[]) {
  if (!rows.length || rows.some(r => r.split !== "tuning" || r.arm !== "candidate")) throw new Error("Calibration requires candidate tuning rows only");
  const grid = FLOOR_GRID.map(floor => ({ floor, ...metrics(rows.map(r => gate(r, floor))) }));
  const ranked = [...grid].sort((a, b) => a.falseAcknowledgements - b.falseAcknowledgements ||
    (b.accepted - b.falseAcknowledgements) - (a.accepted - a.falseAcknowledgements) ||
    b.correct - a.correct || a.floor - b.floor);
  return { floor: ranked[0]!.floor, grid };
}
