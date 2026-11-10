# Lens 5: slow or expensive

The same guarantee for less time. This lens looks at where a test's time goes
and whether the same assertions can be had more cheaply (rules C1 to C4 in
[the authoring guide](../../../../docs/process/test-authoring.md#cost)).

Most files are fast, and a fast file with no cost signal is `clean` for this
lens without further work. Spend the effort on the expensive ones: a small
number of files holds most of the suite's time.

## Where to look

- **The brief**: the file's measured cost and, when CI case durations were
  ingested, its slowest cases.
- **The baseline**: `slowestCases` per file, from the `measure` output.
- **The scanner**:

| Smell | The scanner saw | Usual cause |
| --- | --- | --- |
| `real-time-wait` | A literal wait of a second or more | A production interval spent in real time |
| `per-test-setup` | `beforeEach` that spawns, builds or creates a server | Setup that could be shared read-only |
| `spawn-per-assertion` | Five or more spawn sites in a file | One process per assertion |
| `long-timeout` | A declared budget of a minute or more | A symptom: something above is slow |

Found by reading: `slow-file` (the file is among the most expensive of its
tier, by the brief's cost) and `oversized-fixture` (a corpus, repository or
dataset far larger than the claim needs).

## Finding the time

Before changing anything, account for the file's time. For the slowest cases,
answer: is it setup, waiting, spawning, a matrix, or real work?

| The time goes to | Fix | Guard |
| --- | --- | --- |
| Building the same fixture for every test | Build it once in `beforeAll`, share it read-only, or copy a prepared template per test | Tests must not mutate what they share: check with `--shuffle` |
| Waiting out real intervals | A controlled clock ([non-determinism](nondeterminism.md)) | Negative observations keep a real opportunity |
| Spawning a process per assertion | Assert the logic in-process; keep one spawned test for the process boundary | The spawned test still proves the boundary: arguments, exit code, output |
| A matrix | [Overlap](overlap.md): keep the cells with their own failure mode | Needs the overlap lens's proof |
| A fixture far larger than needed | The smallest fixture that still exercises the claim | The assertions do not change |
| Cases that enumerate at a dear tier | [Overlap](overlap.md): move the enumeration down | Needs the overlap lens's proof |
| Real work that is the claim | Nothing | `accepted`, with the reason |

```ts
// spawn-per-assertion: six processes for six parser cases.
test("parses --json", () => { expect(run(["search", "--json"]).stdout).toContain('"results"'); });
test("parses --limit", () => { expect(run(["search", "--limit", "3"]).stdout).toContain("3 results"); });
// Fixed: the parser in-process, in a table...
test.each([[["search", "--json"], { json: true }], [["search", "--limit", "3"], { limit: 3 }]])(
  "parseArgs(%p)", (argv, expected) => { expect(parseArgs(argv)).toMatchObject(expected); });
// ...and one process for the boundary.
test("the CLI prints a JSON envelope and exits 0", () => {
  const result = run(["search", "--json"]);
  expect([result.exitCode, JSON.parse(result.stdout).schema_version]).toEqual([0, 1]);
});
```

## Proof a fixed finding needs

Use action `speed-up`. The finding needs both `evidence.before` and
`evidence.after`: `measure` outputs of the same file, on the same machine, with
the same command, close together in time. Both must be free of failures, and
the after median must be lower.

```sh
bun scripts/test-health.ts measure <file> --runs 5 --out <runDir>/before-<finding id>.json   # before your change
bun scripts/test-health.ts measure <file> --runs 5 --out <runDir>/after-<finding id>.json    # after it
```

The assertions must be the same ones. The batch gate counts tests per file; if
your speed-up removes tests, it is an overlap fix and needs that proof.

These are local medians, not a hosted benchmark. Say "faster on this machine",
never a CI figure.

## What is not yours to change

- **Any timeout or deadline**, up or down. If a budget is no longer needed
  after your speed-up, file an issue to lower it; that change has its own lane
  ([the CI decision](../../../../docs/decisions/ci-utility.md#proof-system-lane)).
- **Shards, selection, worker counts, cost tables, workflows.** File it.
- **Product performance.** A slow product path is a `type: fix` or `type: feat`
  issue, not a test change.
