export interface Prediction {
  id: string; arm: string; repetition: number; type: string | null; tags: string[];
  needsSummary: boolean | null; completed: boolean; invalid: boolean; abstained: boolean;
  vetoes: string[]; summaries: string[];
}
export interface Golden { id: string; split: string; type: string; tags: string[]; summaryNeed: boolean }

/** A skill may report duplicate files individually; agree before collapsing them. */
export function canonicalReport(value: Record<string, unknown>, paths: string[]) {
  function collapse(field: unknown) {
    if (field && typeof field === 'object' && !Array.isArray(field)) {
      const map = field as Record<string, unknown>;
      const values = paths.map(p => map[p]);
      if (values.some(v => v === undefined) || new Set(values.map(v => JSON.stringify(v))).size !== 1) throw new Error('Conflicting per-file report');
      return values[0];
    }
    return field;
  }
  const need = value.needsSummary;
  if (Array.isArray(need) && !need.every(p => paths.includes(p))) throw new Error('Unknown summary target');
  return { type: collapse(value.type), tags: collapse(value.tags),
    needsSummary: Array.isArray(need) ? need.length > 0 : need, completed: value.completed };
}

/** Mutable YAML values may span lines; comments and other fields still belong to the owner. */
export function protectedFrontmatter(raw: string, mutable: string[]) {
  const frontmatter = raw.split(/^---\r?$/m)[1] ?? '';
  let skipping = false;
  return (frontmatter.match(/[^\n]*\n|[^\n]+$/g) ?? []).filter(line => {
    if (mutable.some(key => line.startsWith(`${key}:`))) { skipping = true; return false; }
    if (skipping && /^[ \t]+\S/.test(line)) return line.trimStart().startsWith('#');
    skipping = false; return true;
  }).join('');
}

/** Micro counts keep omissions, extra tags and invalid answers in the denominator. */
export function score(goldens: Golden[], rows: Prediction[]) {
  let correct = 0, tp = 0, fp = 0, fn = 0, summaryNeed = 0;
  const confusion: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    const gold = goldens.find(c => c.id === row.id)!;
    correct += Number(!row.invalid && row.type === gold.type);
    const predicted = new Set(row.invalid ? [] : row.tags), expected = new Set(gold.tags);
    tp += [...predicted].filter(t => expected.has(t)).length;
    fp += [...predicted].filter(t => !expected.has(t)).length;
    fn += [...expected].filter(t => !predicted.has(t)).length;
    summaryNeed += Number(!row.invalid && row.needsSummary === gold.summaryNeed);
    const bucket = confusion[gold.type] ??= {};
    const key = row.invalid ? 'invalid' : row.type ?? 'abstain';
    bucket[key] = (bucket[key] ?? 0) + 1;
  }
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const groups = goldens.map(g => rows.filter(r => r.id === g.id));
  const signature = (r: Prediction) => JSON.stringify([r.invalid, r.type, [...r.tags].sort(), r.needsSummary, r.completed]);
  return { n: rows.length, typeCorrect: correct, typeAccuracy: correct / rows.length,
    tags: { tp, fp, fn, precision, recall, f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0 },
    summaryNeedCorrect: summaryNeed, confusion, invalid: rows.filter(r => r.invalid).length,
    abstentions: rows.filter(r => r.abstained).length,
    falseCompletions: rows.filter(r => r.completed && (r.invalid || goldens.find(g => g.id === r.id)!.type === 'unclear')).length,
    mislabeledCompletions: rows.filter(r => r.completed && r.type !== goldens.find(g => g.id === r.id)!.type).length,
    vetoes: rows.flatMap(r => r.vetoes).reduce<Record<string, number>>((a, v) => { a[v] = (a[v] ?? 0) + 1; return a; }, {}),
    agreement: { cases: groups.length, identical: groups.filter(g => g.length === 3 && new Set(g.map(signature)).size === 1).length },
  };
}
