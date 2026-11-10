# The worksheet

One JSON file per cluster, at `<runDir>/cluster-<n>.json`. It is the only thing
you write by hand that the metrics read, so its fields are enumerations, not
prose. The brief ends with a skeleton to start from; its lens verdicts say
`TODO` and will not validate until you replace each one.

```json
{
  "schemaVersion": 1,
  "runId": "th-20260712090000-a1b2c3",
  "cluster": 0,
  "seed": "packages/ithaca/tests/oars.test.ts",
  "members": ["packages/ithaca/tests/oars.test.ts", "packages/ithaca/tests/sails.test.ts"],
  "context": ["packages/pylos/tests/harbour-runtime.test.ts"],
  "measurements": { "before": "baseline-0.json", "after": "after-0.json" },
  "audits": [
    { "file": "packages/ithaca/tests/oars.test.ts", "lenses": {
      "cannot-fail": "findings", "overlap": "clean", "nondeterminism": "findings", "failure-issues": "not-applicable",
      "cost": "clean", "not-running": "clean", "tier-and-doubles": "clean", "hygiene": "clean" } },
    { "file": "packages/ithaca/tests/sails.test.ts", "lenses": {
      "cannot-fail": "clean", "overlap": "clean", "nondeterminism": "clean", "failure-issues": "not-applicable",
      "cost": "clean", "not-running": "clean", "tier-and-doubles": "clean", "hygiene": "clean" } }
  ],
  "findings": [
    { "id": "F1", "file": "packages/ithaca/tests/oars.test.ts", "test": "counts the oars", "line": 14,
      "lens": "cannot-fail", "smell": "weak-matcher", "action": "strengthen", "status": "fixed",
      "note": "toBeDefined could not tell 12 oars from none; it now asserts the count.",
      "evidence": { "mutation": "receipts/F1.json" } },
    { "id": "F2", "file": "packages/ithaca/tests/oars.test.ts", "test": "waits for the tide", "line": 31,
      "lens": "nondeterminism", "smell": "settling-sleep", "action": "deflake", "status": "fixed",
      "note": "A 50 ms sleep replaced by awaiting the tide event.",
      "evidence": { "before": "baseline-0.json", "after": "after-F2.json" } },
    { "id": "F3", "file": "packages/ithaca/tests/oars.test.ts", "line": 40,
      "lens": "nondeterminism", "smell": "settling-sleep", "action": "none", "status": "accepted",
      "note": "The timer is the losing branch of a failure race, not a wait." }
  ]
}
```

## Fields

- **`members`** are the files you audited. You may list fewer than the plan
  gave you (a member you did not get to is left out and stays in the rotation),
  never more, and the seed always stays. **`context`** is copied from the plan.
- **`measurements`** names the `measure` output from before your changes and
  the one from after them. It is required as soon as a Bun test file changed:
  the recorder compares the executed cases of each changed file between the two.
- **`audits`**: one entry per member, with a verdict for each of the eight
  lenses.
  - `findings`: at least one finding for this file and lens is `fixed`,
    `filed` or `deferred`.
  - `clean`: you looked and found nothing to act on. `accepted` findings are
    allowed under `clean`.
  - `not-applicable`: the lens has nothing to examine here, for example
    `failure-issues` with no open issue.
- **`findings`**: one per problem.
  - `id` is unique in the worksheet. `file` is a member or a context file.
  - `lens` and `smell` come from `scripts/test-health/catalog.ts`; a smell
    belongs to exactly one lens.
  - `action` is one of `strengthen`, `rewrite`, `remove`, `merge`, `move-tier`,
    `split`, `deflake`, `speed-up`, `unskip`, `cleanup`, `file-issue`, `none`.
  - `status` is `fixed`, `filed`, `deferred` or `accepted`.
  - `note` is one sentence: what was wrong, and what you did or why you left it.
  - `evidence` paths are relative to the run directory.

## Evidence a fixed finding must carry

| The finding | Needs | Produced by |
| --- | --- | --- |
| Any lens `cannot-fail` finding, or action `strengthen` or `rewrite` | `mutation`: a receipt with verdict `killed`, for the finding's own file | `mutate --out` |
| Action `remove`, `merge` or `move-tier` | `obligations`: each original assertion and its retained owner, **and** `mutation`: a killed receipt on a member or context file | You, and `mutate --out` |
| Action `deflake` | `after`: at least 10 runs with no failure | `measure --out` |
| Action `speed-up` | `before` and `after`: both free of failures, after faster | `measure --out` |
| Action `unskip` | `after`: a passing run | `measure --out` |
| Action `split` or `cleanup` outside lens `cannot-fail` | Nothing more | |
| Status `filed` | `issue`: the issue number, with action `file-issue` | The GitHub skill |

`obligations` is a list of `{ "claim": "...", "owner": "<file> > <case name>" }`.

## Declaring every test that disappears

A test may leave a file only on purpose. Two fields say so, and the recorder
and the batch gate hold the change to them:

| Field | On | Meaning |
| --- | --- | --- |
| `evidence.removes` | A fixed `remove`, `merge` or `move-tier` finding | The titles of the test declarations this finding removes, written `describe > title` exactly as the source nests them. One entry accounts for one disappearance. |
| `evidence.removedCases` | The same | How many executed cases go, when that is not the number of `removes` entries: a table shortened by three rows removes three cases and no declaration. |
| `evidence.renames` | Any fixed finding | `[{ "from": "<old title>", "to": "<new title>" }]`. A renamed test is not a removed one, but it must be said. |

```json
{ "id": "F4", "file": "packages/ithaca/tests/oars.test.ts", "lens": "overlap", "smell": "duplicate-case",
  "action": "remove", "status": "fixed", "note": "The second count repeats the first with the same input.",
  "evidence": { "removes": ["the ship > counts the oars again"], "mutation": "receipts/F4.json",
    "obligations": [{ "claim": "a ship of Odysseus has 12 oars", "owner": "packages/ithaca/tests/oars.test.ts > the ship > counts the oars" }] } }
```

What is checked, for every file a cluster changed:

- **By name, from git, in every tier.** Each title present before and absent
  after must be in a `removes` or a `renames`. A title you declared removed
  must really be gone, and a rename's new title must exist.
- **By count, from the two measurements, for Bun test files.** The number of
  passing cases may fall by at most the declared number. A case that newly
  passes without executing an assertion, or that ran before and is skipped
  now, is refused.

When a title is missing from your declarations, the message quotes it:
copy it from there. If you did not mean to remove it, you have just been
stopped from losing a test; restore it.

A context file's finding can never be `fixed`: defer it, and its own package's
run will pick it up.

## Validating and recording

```sh
bun scripts/test-health.ts validate <runDir>/cluster-<n>.json --run <runId>
bun scripts/test-health.ts record cluster --run <runId> --cluster <n> --worksheet <runDir>/cluster-<n>.json [--commit HEAD]
```

`validate` prints every problem. Common ones and what they mean:

| Message | Cause |
| --- | --- |
| `lens cost needs one of clean, findings, not-applicable` | A `TODO` verdict is left |
| `lens X says clean but has N finding(s)` | A finding that is not `accepted` sits under a `clean` lens |
| `needs a mutation receipt` | A cannot-fail or strengthen fix with no `evidence.mutation` |
| `the mutation was not killed (survived)` | The test still cannot fail; fix it and mutate again |
| `needs 10 clean runs after the change` | Too few runs, or one of them failed |
| `not faster` | The after median is not below the before median |
| `a context file is read-only` | A finding on a context file is marked `fixed` |
| `N test(s) disappeared without being declared: "..."` | A test is gone that no fixed finding names; declare it or restore it |
| `N executed case(s) fewer than before, and the findings declare M` | Fewer cases run than you declared: a table or loop shrank, or a test is no longer collected |
| `measurements.before and measurements.after must both measure it` | A Bun test file changed and one of the two measurements does not cover it |

`record cluster` refuses a worksheet that does not validate, a member whose
content changed without `--commit`, a commit whose message lacks the cluster's
`Test-Health:` trailer, and a change that loses a test no finding declared. Record a clean cluster too: that is what
marks its files as audited.

Do not edit a worksheet to match a result you did not get. If the proof will
not come out, the finding is `deferred`.
