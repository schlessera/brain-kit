/**
 * Three-way merge of two unit sequences against their base.
 *
 * Each side is aligned with the base by a longest common subsequence of unit
 * keys (`align`). A base unit both sides kept is an anchor. Between anchors, each
 * side's edits are hunks — a base range and what the side put there — and
 * hunks from the two sides that overlap or touch are merged together, slot by
 * slot: a base unit, or the gap before one. In each slot a side either kept
 * the base unit, removed it, or put a unit of its own there. One-sided edits
 * apply; a unit one side removed and the other changed is kept; two new units
 * in the same slot are the passage both sides changed, and go to `pair`.
 *
 * The units are anything with a `key` that aligns them and a `norm` that says
 * whether they changed: blocks of a section, or the sections of a body. What
 * comes out is units that went in, except where a hook returns a unit it
 * assembled from the two or three it was handed (a section merged block by
 * block, a table merged row by row).
 */

/** What the merge reads of a unit: what aligns it, and what "unchanged" compares. */
export interface Mergeable {
  key: string;
  norm: string;
}

/**
 * Index pairs `[i, j]` with `a[i].key === b[j].key`, ascending: the alignment
 * with the most matches, where a match that is also unchanged (`norm` equal)
 * counts double. Without that weight, a unit keyed by less than its text (a
 * whole table, keyed by its header) could align with a new neighbour of the
 * same key instead of with itself, and a merge would read the move as an edit.
 */
export function align<T extends Mergeable>(a: readonly T[], b: readonly T[]): [number, number][] {
  const identical = (x: T, y: T) => x.key === y.key && x.norm === y.norm;
  let lo = 0;
  while (lo < a.length && lo < b.length && identical(a[lo]!, b[lo]!)) lo++;
  let hiA = a.length;
  let hiB = b.length;
  while (hiA > lo && hiB > lo && identical(a[hiA - 1]!, b[hiB - 1]!)) {
    hiA--;
    hiB--;
  }
  const pairs: [number, number][] = [];
  for (let i = 0; i < lo; i++) pairs.push([i, i]);

  const n = hiA - lo;
  const m = hiB - lo;
  if (n > 0 && m > 0) {
    const weight = (i: number, j: number) => {
      const x = a[lo + i]!;
      const y = b[lo + j]!;
      return x.key !== y.key ? 0 : x.norm === y.norm ? 2 : 1;
    };
    // scores[i][j] = best alignment of a[lo+i..hiA) and b[lo+j..hiB), row-major.
    const width = m + 1;
    const scores = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        const w = weight(i, j);
        const skip = Math.max(scores[(i + 1) * width + j]!, scores[i * width + j + 1]!);
        scores[i * width + j] = w > 0 ? Math.max(skip, scores[(i + 1) * width + j + 1]! + w) : skip;
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      const w = weight(i, j);
      if (w > 0 && scores[i * width + j] === scores[(i + 1) * width + j + 1]! + w) {
        pairs.push([lo + i, lo + j]);
        i++;
        j++;
      } else if (scores[(i + 1) * width + j]! >= scores[i * width + j + 1]!) {
        i++;
      } else {
        j++;
      }
    }
  }

  const shift = b.length - a.length;
  for (let i = hiA; i < a.length; i++) pairs.push([i, i + shift]);
  return pairs;
}

interface Hunk<T> {
  side: "ours" | "theirs";
  /** Base range `[s, e)` the side replaced with `units`. */
  s: number;
  e: number;
  units: T[];
}

function hunksOf<T>(side: Hunk<T>["side"], matches: [number, number][], baseLength: number, units: T[]): Hunk<T>[] {
  const hunks: Hunk<T>[] = [];
  let b = 0;
  let u = 0;
  for (const [bi, ui] of [...matches, [baseLength, units.length] as [number, number]]) {
    if (bi > b || ui > u) hunks.push({ side, s: b, e: bi, units: units.slice(u, ui) });
    b = bi + 1;
    u = ui + 1;
  }
  return hunks;
}

/** What one side did with one base slot of a group. */
type Cell<T> = { kind: "kept"; unit: T } | { kind: "gone" } | { kind: "new"; unit: T };

export interface UnitMergeHooks<T> {
  /**
   * Both sides put a different unit in the same place: the units to keep, in
   * order.
   */
  pair(ours: T, theirs: T): T[];
  /** A unit aligned in all three versions that both sides changed. Defaults to OURS. */
  both?(base: T, ours: T, theirs: T): T[];
  /** A unit one side removed and the other changed, kept because content wins. */
  keptOverRemoval?(unit: T, keptBy: "ours" | "theirs"): void;
  /** A unit one side removed and the other left as it was: the removal applies. */
  removed?(unit: T, removedBy: "ours" | "theirs"): void;
}

export function mergeUnits<T extends Mergeable>(base: T[], ours: T[], theirs: T[], hooks: UnitMergeHooks<T>): T[] {
  const matchesA = align(base, ours);
  const matchesB = align(base, theirs);
  const inA = new Map(matchesA);
  const inB = new Map(matchesB);

  const hunks = [
    ...hunksOf("ours", matchesA, base.length, ours),
    ...hunksOf("theirs", matchesB, base.length, theirs),
  ].sort((x, y) => x.s - y.s || x.e - y.e);

  // Hunks that overlap or touch form one group, merged slot by slot.
  const groups: { s: number; e: number; hunks: Hunk<T>[] }[] = [];
  for (const hunk of hunks) {
    const last = groups[groups.length - 1];
    if (last && hunk.s <= last.e) {
      last.hunks.push(hunk);
      last.e = Math.max(last.e, hunk.e);
    } else {
      groups.push({ s: hunk.s, e: hunk.e, hunks: [hunk] });
    }
  }

  const out: T[] = [];
  const anchor = (i: number) => {
    const b = base[i]!;
    const a = ours[inA.get(i)!]!;
    const t = theirs[inB.get(i)!]!;
    if (a.norm === t.norm) out.push(a);
    else if (a.norm === b.norm) out.push(t);
    else if (t.norm === b.norm) out.push(a);
    else out.push(...(hooks.both ? hooks.both(b, a, t) : [a]));
  };

  let next = 0;
  for (const group of groups) {
    while (next < group.s) anchor(next++);
    out.push(...mergeGroup(group, base, ours, theirs, inA, inB, hooks));
    next = group.e;
  }
  while (next < base.length) anchor(next++);
  return out;
}

function mergeGroup<T extends Mergeable>(
  group: { s: number; e: number; hunks: Hunk<T>[] },
  base: T[],
  ours: T[],
  theirs: T[],
  inA: Map<number, number>,
  inB: Map<number, number>,
  hooks: UnitMergeHooks<T>
): T[] {
  const cellsOf = (side: Hunk<T>["side"]) => {
    const units = side === "ours" ? ours : theirs;
    const matched = side === "ours" ? inA : inB;
    const slots = new Map<number, Cell<T>>();
    const inserts = new Map<number, T[]>();
    for (let i = group.s; i < group.e; i++) {
      const j = matched.get(i);
      if (j === undefined) slots.set(i, { kind: "gone" });
      // A unit aligned by a key other than its text (a whole table) can
      // still have changed: that is a change, not a keep.
      else if (units[j]!.norm !== base[i]!.norm) slots.set(i, { kind: "new", unit: units[j]! });
      else slots.set(i, { kind: "kept", unit: units[j]! });
    }
    for (const hunk of group.hunks) {
      if (hunk.side !== side) continue;
      hunk.units.forEach((unit, k) => {
        if (k < hunk.e - hunk.s) slots.set(hunk.s + k, { kind: "new", unit });
        else inserts.set(hunk.e, [...(inserts.get(hunk.e) ?? []), unit]);
      });
    }
    return { slots, inserts };
  };
  const a = cellsOf("ours");
  const b = cellsOf("theirs");

  // A unit both sides added, wherever in the group, is kept once, where OURS has it.
  const newUnits = (cells: ReturnType<typeof cellsOf>) => {
    const list: T[] = [];
    for (let g = group.s; g <= group.e; g++) {
      list.push(...(cells.inserts.get(g) ?? []));
      const cell = cells.slots.get(g);
      if (cell?.kind === "new") list.push(cell.unit);
    }
    return list;
  };
  const common = new Set<T>();
  const absorbed = new Set<T>();
  const pool = newUnits(a);
  for (const unit of newUnits(b)) {
    const match = pool.find((candidate) => !common.has(candidate) && candidate.norm === unit.norm);
    if (match) {
      common.add(match);
      absorbed.add(unit);
    }
  }

  const out: T[] = [];
  const both = (x: T, y: T) => {
    if (common.has(x)) out.push(x, y);
    else if (x.norm === y.norm) out.push(x);
    else out.push(...hooks.pair(x, y));
  };
  for (let g = group.s; g <= group.e; g++) {
    const insA = a.inserts.get(g) ?? [];
    const insB = (b.inserts.get(g) ?? []).filter((unit) => !absorbed.has(unit));
    for (let k = 0; k < Math.max(insA.length, insB.length); k++) {
      const x = insA[k];
      const y = insB[k];
      if (x && y) both(x, y);
      else out.push((x ?? y)!);
    }
    if (g === group.e) break;

    const ca = a.slots.get(g)!;
    const cb = b.slots.get(g)!;
    if (cb.kind === "new" && absorbed.has(cb.unit)) {
      // THEIRS replaced this base unit with one OURS also has: its content is
      // already placed; only a change OURS made here is left to keep.
      if (ca.kind === "new") out.push(ca.unit);
      continue;
    }
    if (ca.kind === "new" && cb.kind === "new") both(ca.unit, cb.unit);
    else if (ca.kind === "new") {
      out.push(ca.unit);
      if (cb.kind === "gone" && !common.has(ca.unit)) hooks.keptOverRemoval?.(ca.unit, "ours");
    } else if (cb.kind === "new") {
      out.push(cb.unit);
      if (ca.kind === "gone") hooks.keptOverRemoval?.(cb.unit, "theirs");
    } else if (ca.kind === "kept" && cb.kind === "kept") {
      out.push(ca.unit);
    } else if (ca.kind === "kept") {
      // Kept on one side and removed on the other: the removal is the only
      // change, so it applies.
      hooks.removed?.(ca.unit, "theirs");
    } else if (cb.kind === "kept") {
      hooks.removed?.(cb.unit, "ours");
    }
    // Removed on both: gone.
  }
  return out;
}
