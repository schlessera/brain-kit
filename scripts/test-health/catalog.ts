/**
 * The one vocabulary of the test-health audit: lenses, the smells each lens
 * looks for, the actions a finding may take and the evidence a fixed finding
 * must carry. The scanner, the worksheet validator, the metrics report, the
 * skill references (`.agents/skills/test-health/references/`) and the
 * authoring guide (`docs/process/test-authoring.md`) all use these ids, and
 * `scripts/skill-tests/test-health-docs.test.ts` fails when one of them drifts.
 *
 * `detect` says who finds a smell: `static` is a scanner signal (a lead, never
 * a finding by itself), `runtime` comes from `measure`, and `judgment` is the
 * auditing agent's reading of the test. `weight` ranks static signals when the
 * selector scores a file; it is zero for smells the scanner does not emit.
 */

export const LENSES = [
  { id: "cannot-fail", title: "Tests that cannot fail" },
  { id: "overlap", title: "Overlap within and across tiers" },
  { id: "nondeterminism", title: "Non-determinism" },
  { id: "failure-issues", title: "Open failure issues" },
  { id: "cost", title: "Slow or expensive" },
  { id: "not-running", title: "Silently not running" },
  { id: "tier-and-doubles", title: "Wrong tier or wrong double" },
  { id: "hygiene", title: "Hygiene and diagnostics" },
] as const;

export type LensId = (typeof LENSES)[number]["id"];
export type Detect = "static" | "runtime" | "judgment";

export interface Smell { id: string; lens: LensId; title: string; detect: Detect; weight: number }

const smell = (lens: LensId, id: string, title: string, detect: Detect, weight = 0): Smell =>
  ({ id, lens, title, detect, weight });

export const SMELLS: readonly Smell[] = [
  smell("cannot-fail", "no-assertion", "A test body makes no assertion", "static", 3),
  smell("cannot-fail", "weak-matcher", "A matcher that almost any value satisfies", "static", 1),
  smell("cannot-fail", "not-throw-only", "The only assertion is that nothing throws", "static", 2),
  smell("cannot-fail", "conditional-assertion", "An assertion that only runs on one branch", "static", 2),
  smell("cannot-fail", "self-comparison", "A value compared with itself or a literal with a literal", "static", 3),
  smell("cannot-fail", "asserts-the-double", "Every assertion is about the test double", "static", 1),
  smell("cannot-fail", "wrong-object", "The guard is asserted on an object the call site does not use", "judgment"),
  smell("cannot-fail", "earlier-layer-answers", "An earlier layer answers before the code under test", "judgment"),
  smell("cannot-fail", "nothing-to-observe", "The harness wires nothing the assertion could observe", "judgment"),
  smell("cannot-fail", "empty-by-construction", "The field under test is empty in the input the test builds", "judgment"),
  smell("cannot-fail", "derived-expectation", "The expected value is computed by the code under test", "judgment"),
  smell("cannot-fail", "masked-assertion", "An earlier assertion fails first and hides the named one", "judgment"),

  smell("overlap", "duplicate-case", "The same scenario is asserted twice in one tier", "static", 1),
  smell("overlap", "edge-cases-at-high-tier", "An expensive test re-enumerates cases a cheaper test owns", "judgment"),
  smell("overlap", "matrix-multiplier", "A matrix dimension without its own failure mode", "static", 1),
  smell("overlap", "missing-lower-tier-owner", "Edge cases are owned only by an expensive test", "judgment"),

  smell("nondeterminism", "settling-sleep", "A fixed delay stands in for a completion condition", "static", 2),
  smell("nondeterminism", "wall-clock", "The outcome reads the real clock", "static", 1),
  smell("nondeterminism", "unseeded-random", "The outcome depends on unseeded randomness", "static", 1),
  smell("nondeterminism", "shared-state", "Mutable state is shared between tests", "static", 1),
  smell("nondeterminism", "fixed-resource", "A hard-coded port or path can collide", "static", 2),
  smell("nondeterminism", "unrestored-global", "A global is replaced without a complete restore", "static", 2),
  smell("nondeterminism", "unawaited-async", "An asynchronous assertion is not awaited", "static", 3),
  smell("nondeterminism", "order-dependent", "The result changes with test order", "runtime"),
  smell("nondeterminism", "load-sensitive", "The result changes under host load", "runtime"),

  smell("failure-issues", "test-fault", "An open failure issue is the test's own fault", "judgment"),
  smell("failure-issues", "product-fault", "An open failure issue shows a real product defect", "judgment"),
  smell("failure-issues", "unreproduced", "An open failure issue could not be reproduced", "judgment"),

  smell("cost", "slow-file", "The file is among the most expensive in its tier", "runtime"),
  smell("cost", "real-time-wait", "A wait of a second or more runs in real time", "static", 2),
  smell("cost", "per-test-setup", "Expensive setup repeats for every test", "static", 1),
  smell("cost", "spawn-per-assertion", "A process is spawned for each assertion", "static", 1),
  smell("cost", "long-timeout", "A test declares a budget of a minute or more", "static", 1),
  smell("cost", "oversized-fixture", "The fixture is far larger than the claim needs", "judgment"),

  smell("not-running", "skipped", "A test is skipped, todo or marked failing", "static", 3),
  smell("not-running", "conditional-skip", "A test runs only when a condition holds", "static", 2),
  smell("not-running", "retry", "A test retries until it passes", "static", 3),
  smell("not-running", "only", "A focused test hides its siblings", "static", 3),
  smell("not-running", "undiscovered", "A test file no runner discovers", "static", 3),

  smell("tier-and-doubles", "wrong-tier", "The test lives in a tier that does not fit its claim", "judgment"),
  smell("tier-and-doubles", "double-too-high", "The double replaces more than the lowest shared request path", "judgment"),
  smell("tier-and-doubles", "over-mocked", "More doubles than assertions", "static", 1),
  smell("tier-and-doubles", "implementation-coupled", "The test pins internals rather than behaviour", "judgment"),

  smell("hygiene", "leaked-resource", "A process, server or directory outlives the test", "static", 1),
  smell("hygiene", "giant-test", "One test makes many unrelated claims", "static", 1),
  smell("hygiene", "opaque-failure", "A failure would not say what went wrong", "static", 1),
  smell("hygiene", "unclear-name", "The name does not state the claim", "static", 1),
  smell("hygiene", "dead-support", "A helper or fixture nothing uses", "judgment"),
];

export const ACTIONS = [
  "strengthen", // make an existing assertion able to fail
  "rewrite", // replace the test's approach, same claim, same tier
  "remove", // delete a test whose every obligation has a retained owner
  "merge", // fold duplicate cases into one
  "move-tier", // move the claim to a cheaper or more fitting tier
  "split", // separate unrelated claims into their own tests
  "deflake", // replace a nondeterministic input with a controlled one
  "speed-up", // same assertions, less time
  "unskip", // make a not-running test run
  "cleanup", // teardown, naming, diagnostics, dead support code
  "file-issue", // out of scope for this run: a product fault, a proof-system change
  "none", // looked at, deliberately left
] as const;
export type ActionId = (typeof ACTIONS)[number];

export const STATUSES = ["fixed", "filed", "deferred", "accepted"] as const;
export type StatusId = (typeof STATUSES)[number];

/** A lens verdict for one audited file. */
export const LENS_VERDICTS = ["clean", "findings", "not-applicable"] as const;
export type LensVerdict = (typeof LENS_VERDICTS)[number];

/** Evidence a `fixed` finding must carry; checked by `validateWorksheet`. */
export type EvidenceKind = "mutation" | "obligations" | "stable-runs" | "faster" | "runs";

/** Actions that take assertions away. They need an obligation map and a killed
 * mutation on the retained owner, because nobody reads the diff. */
export const REDUCING_ACTIONS: readonly ActionId[] = ["remove", "merge", "move-tier"];

export function requiredEvidence(lens: LensId, action: ActionId): EvidenceKind[] {
  const kinds = new Set<EvidenceKind>();
  if (REDUCING_ACTIONS.includes(action)) { kinds.add("obligations"); kinds.add("mutation"); }
  // A new assertion or a new approach is only worth having if it can fail.
  if (lens === "cannot-fail" || action === "strengthen" || action === "rewrite") kinds.add("mutation");
  if (action === "deflake") kinds.add("stable-runs");
  if (action === "speed-up") kinds.add("faster");
  if (action === "unskip") kinds.add("runs");
  return [...kinds];
}

const smellIndex = new Map(SMELLS.map(entry => [entry.id, entry]));
export const smellById = (id: string): Smell | undefined => smellIndex.get(id);
export const isLens = (value: unknown): value is LensId => LENSES.some(lens => lens.id === value);
export const LENS_IDS: readonly LensId[] = LENSES.map(lens => lens.id);
