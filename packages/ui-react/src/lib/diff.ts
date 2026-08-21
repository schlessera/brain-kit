// Standalone text-diff engine behind the Edit tool's diff view: line-level
// LCS with word-level refinement for single-line change pairs. Pure data —
// no React; rendering stays in components/chat/tool-views.tsx.

// ------------------------------------------------------------
// Diff helpers — line-level LCS with word-level refinement
// ------------------------------------------------------------

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

/** A word token, flagged when it differs from its counterpart line. */
export type WordToken = { text: string; changed: boolean };

/**
 * Token-level LCS for a single deleted/inserted line pair. Splitting on
 * `/(\s+)/` keeps the whitespace as its own tokens so we can reassemble the
 * line exactly. Unchanged tokens are shared between both sides.
 */
function wordDiff(oldLine: string, newLine: string): { del: WordToken[]; ins: WordToken[] } {
  const a = oldLine.split(/(\s+)/);
  const b = newLine.split(/(\s+)/);
  // Token-level LCS is O(words²); a pathological minified line would be slow.
  // Above the cap, skip word refinement and flag the whole line as changed.
  if (a.length * b.length > 10_000) {
    return {
      del: [{ text: oldLine, changed: true }],
      ins: [{ text: newLine, changed: true }],
    };
  }
  const ops = diffSeq(a, b);
  const del: WordToken[] = [];
  const ins: WordToken[] = [];
  for (const op of ops) {
    if (op.kind === "same") {
      del.push({ text: op.value, changed: false });
      ins.push({ text: op.value, changed: false });
    } else if (op.kind === "del") {
      del.push({ text: op.value, changed: true });
    } else {
      ins.push({ text: op.value, changed: true });
    }
  }
  return { del, ins };
}

/** A rendered diff row. `tokens` is set only for word-refined single-line edits. */
export type DiffRow = {
  kind: "same" | "del" | "ins";
  line: string;
  tokens: WordToken[] | null;
};

/**
 * Merge `old_string`/`new_string` into a single diff: unchanged lines appear
 * once as neutral, deletions/insertions keep the red/green treatment. A change
 * block that is exactly one deleted line against one inserted line gets
 * word-level highlighting.
 */
export function computeDiffRows(oldStr: string, newStr: string): DiffRow[] {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  // Line-level LCS is O(m×n) in time and memory; a huge Edit (thousands of
  // lines) would build a massive DP matrix and hang the UI. Above the cap, fall
  // back to a naive "all old removed, all new added" diff.
  if (oldLines.length * newLines.length > 250_000) {
    return [
      ...oldLines.map((line): DiffRow => ({ kind: "del", line, tokens: null })),
      ...newLines.map((line): DiffRow => ({ kind: "ins", line, tokens: null })),
    ];
  }
  const ops = diffSeq(oldLines, newLines);
  const rows: DiffRow[] = [];
  let idx = 0;
  while (idx < ops.length) {
    if (ops[idx].kind === "same") {
      rows.push({ kind: "same", line: ops[idx].value, tokens: null });
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
    if (dels.length === 1 && inss.length === 1) {
      const { del, ins } = wordDiff(dels[0], inss[0]);
      rows.push({ kind: "del", line: dels[0], tokens: del });
      rows.push({ kind: "ins", line: inss[0], tokens: ins });
    } else {
      for (const d of dels) rows.push({ kind: "del", line: d, tokens: null });
      for (const s of inss) rows.push({ kind: "ins", line: s, tokens: null });
    }
  }
  return rows;
}
