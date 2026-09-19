// Standalone line-diff engine behind the Edit tool's diff view: a line-level
// LCS that merges `old_string` / `new_string` into one signed listing. Pure
// data — no React; rendering is the kit `DiffBlock` (tinted) in
// components/chat/tool-views.tsx.
//
// There used to be a word-level refinement here (a changed-token highlight
// inside a single-line change pair). The design's diff has no such thing —
// the sign column and the row grounds are the whole vocabulary — so it went
// with the seventh drop rather than surviving as an app-only decoration.

type DiffOp<T> = { kind: "same" | "del" | "ins"; value: T };

/**
 * Hand-rolled LCS diff (standard DP + forward walk) so we avoid pulling in the
 * `diff` package. Returns ops in source order: `same` where the sequences
 * agree, `del` for items only in `a`, `ins` for items only in `b`.
 */
function diffSeq<T>(
  a: T[],
  b: T[],
  eq: (x: T, y: T) => boolean = (x, y) => x === y
): DiffOp<T>[] {
  const m = a.length;
  const n = b.length;
  // dp[i][j] = length of the LCS of a[i:] and b[j:]
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = eq(a[i], b[j])
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffOp<T>[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (eq(a[i], b[j])) {
      ops.push({ kind: "same", value: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "del", value: a[i] });
      i++;
    } else {
      ops.push({ kind: "ins", value: b[j] });
      j++;
    }
  }
  while (i < m) ops.push({ kind: "del", value: a[i++] });
  while (j < n) ops.push({ kind: "ins", value: b[j++] });
  return ops;
}

/** A rendered diff row. */
export type DiffRow = { kind: "same" | "del" | "ins"; line: string };

/**
 * Merge `old_string`/`new_string` into a single diff: unchanged lines appear
 * once as context, deletions before insertions within each change block.
 */
export function computeDiffRows(oldStr: string, newStr: string): DiffRow[] {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  // Line-level LCS is O(m×n) in time and memory; a huge Edit (thousands of
  // lines) would build a massive DP matrix and hang the UI. Above the cap, fall
  // back to a naive "all old removed, all new added" diff.
  if (oldLines.length * newLines.length > 250_000) {
    return [
      ...oldLines.map((line): DiffRow => ({ kind: "del", line })),
      ...newLines.map((line): DiffRow => ({ kind: "ins", line })),
    ];
  }
  const ops = diffSeq(oldLines, newLines);
  const rows: DiffRow[] = [];
  let idx = 0;
  while (idx < ops.length) {
    if (ops[idx].kind === "same") {
      rows.push({ kind: "same", line: ops[idx].value });
      idx++;
      continue;
    }
    // Collect a maximal run of changes, grouping deletes before inserts.
    const dels: string[] = [];
    const inss: string[] = [];
    while (idx < ops.length && ops[idx].kind !== "same") {
      if (ops[idx].kind === "del") dels.push(ops[idx].value);
      else inss.push(ops[idx].value);
      idx++;
    }
    for (const d of dels) rows.push({ kind: "del", line: d });
    for (const s of inss) rows.push({ kind: "ins", line: s });
  }
  return rows;
}

const SIGNS: Record<DiffRow["kind"], string> = { same: " ", del: "-", ins: "+" };

/**
 * The rows as the signed text the kit `DiffBlock` reads: `- ` / `+ ` / two
 * spaces before each line, so a context line that itself starts with `-` or
 * `+` cannot be read as a change.
 */
export function diffText(rows: DiffRow[]): string {
  return rows.map((r) => `${SIGNS[r.kind]} ${r.line}`).join("\n");
}
