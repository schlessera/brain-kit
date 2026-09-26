/**
 * `brain eval --baseline`: compare a run against a stored one, per query.
 *
 * A personal query set is small, so a threshold in percentage points does not
 * work: with 27 queries one flip is 3.7 points. Two configurations on the same
 * queries are a paired comparison, and for binary hit@k that is an exact sign
 * test over the discordant queries. The gate itself counts queries: fail on a
 * net loss of `maxNetLoss` or more on hit@1, or on any lost query in a
 * must-pass class. The sign-test p is printed as information only: with few
 * flips the test has little power (three lost and one gained is p = 0.625),
 * although a one-sided run of six is already p = 0.031, so the list of IDs
 * says more than the number.
 */

import { z } from "zod";

import { EVAL_SCHEMA_VERSION } from "./retrieval-eval.js";

/** What a comparison reads from a stored run; anything else in it is ignored. */
const storedRunSchema = z.object({
  schema_version: z.number(),
  meta: z.object({
    version: z.string(),
    set_sha256: z.string(),
    embedding_model: z.string().nullable(),
    modes: z.array(z.string()),
    k: z.array(z.number()),
    rerank: z.string().optional(),
  }),
  per_query: z.array(
    z.object({
      mode: z.string(),
      id: z.string(),
      class: z.string(),
      hit_at: z.record(z.string(), z.boolean()).nullable(),
    })
  ),
});

export type StoredRun = z.infer<typeof storedRunSchema>;

/** A stored run that cannot be read as one. */
export class BaselineError extends Error {}

export function parseStoredRun(text: string): StoredRun {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new BaselineError(`not valid JSON (${(e as Error).message})`);
  }
  const parsed = storedRunSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new BaselineError(`not a brain eval run: ${first.path.join(".") || "(root)"}: ${first.message}`);
  }
  checkCoverage(parsed.data);
  return parsed.data;
}

/**
 * A run must score every query once in every mode it names, with a hit or
 * miss at every k it names. A missing entry would otherwise read as nothing
 * to compare, and a missing key as a miss, so a truncated or hand-edited
 * baseline could hide a loss.
 */
function checkCoverage(run: StoredRun): void {
  const fail = (why: string) => {
    throw new BaselineError(`not a complete brain eval run: ${why}`);
  };
  const ks = run.meta.k.map(String);
  const seen = new Map<string, Set<string>>(run.meta.modes.map((m) => [m, new Set()]));
  for (const q of run.per_query) {
    const ids = seen.get(q.mode);
    if (!ids) fail(`per_query has mode "${q.mode}", which meta.modes does not name`);
    if (ids!.has(q.id)) fail(`query "${q.id}" appears twice in mode ${q.mode}`);
    ids!.add(q.id);
    if (q.hit_at !== null) {
      const missing = ks.filter((k) => typeof q.hit_at![k] !== "boolean");
      if (missing.length > 0) fail(`query "${q.id}" in mode ${q.mode} has no hit at k ${missing.join(", ")}`);
    }
  }
  const [first, ...rest] = [...seen.values()];
  for (const [mode, ids] of seen) {
    if (ids.size === 0) fail(`mode ${mode} scores no query`);
  }
  for (const ids of rest) {
    if (ids.size !== first.size || [...ids].some((id) => !first.has(id))) {
      fail("its modes do not all score the same queries");
    }
  }
}

/**
 * Exact two-sided sign test: the probability, under "no difference", of a
 * split of the discordant queries at least as lopsided as `lost`/`gained`.
 */
export function signTestP(lost: number, gained: number): number {
  const n = lost + gained;
  if (n === 0) return 1;
  const k = Math.min(lost, gained);
  // In log space: C(n, i) and 2^n both overflow a double long before n
  // reaches the size of a large query set (C(1024, 512) is about 10^306).
  const logFactorial = [0];
  for (let i = 1; i <= n; i++) logFactorial.push(logFactorial[i - 1] + Math.log(i));
  const logTerm = (i: number) => logFactorial[n] - logFactorial[i] - logFactorial[n - i] - n * Math.LN2;
  // log-sum-exp over i = 0..k, scaled by the largest term (the last one).
  const top = logTerm(k);
  let scaled = 0;
  for (let i = 0; i <= k; i++) scaled += Math.exp(logTerm(i) - top);
  return Math.min(1, 2 * Math.exp(top + Math.log(scaled)));
}

export interface Flips {
  lost: string[];
  gained: string[];
  unchanged: number;
}

export interface ModeComparison {
  mode: string;
  /** Keyed by each k, as in `hit_at`. */
  hit_at: Record<string, Flips & { sign_test_p: number }>;
  per_class: { class: string; hit_at: Record<string, Flips> }[];
}

export interface BaselineReport {
  /** The baseline file, brain-relative when inside the root; null when redacted. */
  file: string | null;
  /** The `@schlessera/brain` version the baseline was recorded with. */
  version: string;
  comparable: boolean;
  /** Why the runs cannot be compared; empty when they can. */
  not_comparable: string[];
  /** Query IDs only one of the two runs has (allowed with --allow-set-change). */
  only_in_baseline: string[];
  only_in_run: string[];
  modes: ModeComparison[];
  gate: {
    max_net_loss: number;
    must_pass: string[];
    failed: boolean;
    reasons: string[];
  };
}

export interface CompareOptions {
  maxNetLoss: number;
  mustPass: string[];
  allowSetChange: boolean;
}

type RunQuery = StoredRun["per_query"][number];

function flipsOf(pairs: { id: string; before: boolean; after: boolean }[]): Flips {
  const flips: Flips = { lost: [], gained: [], unchanged: 0 };
  for (const p of pairs) {
    if (p.before && !p.after) flips.lost.push(p.id);
    else if (!p.before && p.after) flips.gained.push(p.id);
    else flips.unchanged++;
  }
  return flips;
}

/**
 * Compare `run` against `baseline`, query by query, on every k both share.
 * Runs that differ in schema, mode, embedding model or k are not comparable;
 * so are different sets (hash or query IDs) unless `allowSetChange`, in
 * which case only the queries both have are compared. A no-answer query
 * (hit_at null) has nothing to lose and is not compared.
 */
export function compareRuns(baseline: StoredRun, run: StoredRun, opts: CompareOptions): Omit<BaselineReport, "file"> {
  const notComparable: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (baseline.schema_version !== EVAL_SCHEMA_VERSION) {
    notComparable.push(`the baseline's schema_version is ${baseline.schema_version}, this run's is ${EVAL_SCHEMA_VERSION}`);
  }
  if (!same(baseline.meta.modes, run.meta.modes)) {
    notComparable.push(`modes differ: baseline ${baseline.meta.modes.join(",")}, run ${run.meta.modes.join(",")}`);
  }
  if (baseline.meta.embedding_model !== run.meta.embedding_model) {
    notComparable.push(
      `embedding model differs: baseline ${baseline.meta.embedding_model ?? "none"}, run ${run.meta.embedding_model ?? "none"}`
    );
  }
  if (!same(baseline.meta.k, run.meta.k)) {
    notComparable.push(`k differs: baseline ${baseline.meta.k.join(",")}, run ${run.meta.k.join(",")}`);
  }

  const idsOf = (r: StoredRun) => new Set(r.per_query.map((q) => q.id));
  const baseIds = idsOf(baseline);
  const runIds = idsOf(run);
  const onlyInBaseline = [...baseIds].filter((id) => !runIds.has(id)).sort();
  const onlyInRun = [...runIds].filter((id) => !baseIds.has(id)).sort();
  if (!opts.allowSetChange) {
    if (baseline.meta.set_sha256 !== run.meta.set_sha256) {
      notComparable.push("the query set changed since the baseline (set_sha256 differs); pass --allow-set-change to compare the queries both runs have");
    } else if (onlyInBaseline.length > 0 || onlyInRun.length > 0) {
      notComparable.push("the runs score different queries; pass --allow-set-change to compare the queries both runs have");
    }
  }

  const gate = { max_net_loss: opts.maxNetLoss, must_pass: opts.mustPass, failed: false, reasons: [] as string[] };
  const report = {
    version: baseline.meta.version,
    comparable: notComparable.length === 0,
    not_comparable: notComparable,
    only_in_baseline: onlyInBaseline,
    only_in_run: onlyInRun,
    modes: [] as ModeComparison[],
    gate,
  };
  if (!report.comparable) return report;

  const key = (q: RunQuery) => `${q.mode}\u0000${q.id}`;
  const before = new Map(baseline.per_query.map((q) => [key(q), q]));
  for (const mode of run.meta.modes) {
    const pairs = run.per_query.flatMap((after) => {
      if (after.mode !== mode || after.hit_at === null) return [];
      const was = before.get(key(after));
      if (!was || was.hit_at === null) return [];
      return [{ after, was }];
    });
    const hitAt: ModeComparison["hit_at"] = {};
    for (const k of run.meta.k.map(String)) {
      const flips = flipsOf(pairs.map(({ after, was }) => ({ id: after.id, before: was.hit_at![k], after: after.hit_at![k] })));
      hitAt[k] = { ...flips, sign_test_p: signTestP(flips.lost.length, flips.gained.length) };
    }
    const classes = [...new Set(pairs.map((p) => p.after.class))];
    const perClass = classes.map((cls) => {
      const inClass = pairs.filter((p) => p.after.class === cls);
      const byK: Record<string, Flips> = {};
      for (const k of run.meta.k.map(String)) {
        byK[k] = flipsOf(inClass.map(({ after, was }) => ({ id: after.id, before: was.hit_at![k], after: after.hit_at![k] })));
      }
      return { class: cls, hit_at: byK };
    });
    report.modes.push({ mode, hit_at: hitAt, per_class: perClass });

    const at1 = hitAt["1"];
    const net = at1.lost.length - at1.gained.length;
    if (net >= opts.maxNetLoss) {
      gate.reasons.push(`${mode}: net loss of ${net} on hit@1 (lost ${at1.lost.length}, gained ${at1.gained.length}; limit ${opts.maxNetLoss})`);
    }
    for (const cls of opts.mustPass) {
      const lost = perClass.find((c) => c.class === cls)?.hit_at["1"].lost ?? [];
      if (lost.length > 0) gate.reasons.push(`${mode}: must-pass class "${cls}" lost ${lost.join(", ")} on hit@1`);
    }
  }
  gate.failed = gate.reasons.length > 0;
  return report;
}

/**
 * Remove the query text and every path from a run's envelope, keeping IDs,
 * classes and the metrics, so a result can be shared without the brain.
 */
export function redactEnvelope<T extends Record<string, unknown>>(envelope: T): T {
  const meta = { ...(envelope.meta as Record<string, unknown>), set: null, source: null };
  const perQuery = (envelope.per_query as Record<string, unknown>[]).map((q) => {
    const { q: _text, expected: _expected, top: _top, ...rest } = q;
    return rest;
  });
  const warnings = envelope.warnings as string[];
  const baseline = envelope.baseline as Record<string, unknown> | undefined;
  return {
    ...envelope,
    meta,
    per_query: perQuery,
    // A warning names documents; its count is what survives.
    warnings: warnings.length > 0 ? [`${warnings.length} warning(s) withheld by --redact`] : [],
    ...(baseline ? { baseline: { ...baseline, file: null } } : {}),
  };
}
