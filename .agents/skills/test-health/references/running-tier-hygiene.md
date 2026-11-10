# Lenses 6 to 8: not running, wrong tier or double, hygiene

Three smaller lenses. Each still gets its own verdict for every member.

## Lens 6: silently not running (`not-running`)

A test that does not execute proves nothing, and nothing turns red to say so
(rule D7 in
[the authoring guide](../../../../docs/process/test-authoring.md#determinism)).

| Smell | The scanner saw | Check |
| --- | --- | --- |
| `skipped` | `.skip`, `.todo`, `.failing` | Why, and since when (`git log -S`) |
| `conditional-skip` | `.skipIf`, `.runIf`, or a skip stored in a variable (`const live = LIVE ? test : test.skip`) | Does the condition hold in hosted proof? |
| `retry` | A `retry` option | What it retries past |
| `only` | `.only` | Always a mistake in a committed test |
| `undiscovered` | A test-like file no runner lists (`bun scripts/test-health.ts inventory`) | Is its name outside every discovery pattern? |

Also read the baseline's `skippedCases`: those cases did not run on this
machine.

| Situation | Action | Proof |
| --- | --- | --- |
| The prerequisite is always present in hosted proof, so the condition is dead weight | `unskip`: remove the condition | `evidence.after`: a passing `measure` run |
| The prerequisite can be absent, and absence should be loud | `unskip`: fail with a named prerequisite error instead of skipping | The same |
| The skip guards a live or paid call that must never run in tests | `none`, `accepted`: the condition is the safety | None |
| The test was skipped because it fails | `file-issue` | The issue number. Do not unskip into a red suite, and do not delete it. |
| The file is undiscovered but valid | `unskip`: rename or move it so a runner discovers it | `evidence.after`: a passing `measure` run of the file under its new name |
| The file is undiscovered and dead | `remove` | The overlap lens's proof ([overlap](overlap.md)) |

Never add a skip, a retry or an `only`. The batch gate refuses a file whose
count of any of these rises.

## Lens 7: wrong tier or wrong double (`tier-and-doubles`)

Is the test where its claim belongs, and does it replace only what it must?

| Smell | Question |
| --- | --- |
| `wrong-tier` | Could a cheaper tier observe this claim? Is a measurement-harness test sitting in product proof, or product proof under `experiments/`? Does a real-time guarantee run in an ordinary shard? |
| `double-too-high` | Does the double replace a whole client or adapter when one request method would do? Does it stub one path and leave an inherited path real? |
| `over-mocked` (scanner) | More doubles than assertions: is anything of the real behaviour left to assert? |
| `implementation-coupled` | Would a behaviour-preserving refactor break this test? It pins call order, private fields or internal function names. |

| Situation | Action | Proof |
| --- | --- | --- |
| The claim fits a cheaper tier | `move-tier` | The overlap lens's proof: obligation map and a killed mutation on the new owner |
| A predicate-only unit test stands in for a runtime claim | `file-issue` | A runtime test is new coverage, larger than an audit fix |
| The double replaces too much | `rewrite`: replace the lowest shared request method | A killed mutation: the real path now under test can fail it |
| The test pins internals | `rewrite`: assert the observable result | A killed mutation |

Which tier a claim belongs to is the first table of
[the authoring guide](../../../../docs/process/test-authoring.md#which-test-for-which-claim).
The experiment tier's boundary is in
[testing.md](../../../../docs/process/testing.md#the-experiment-tier).

## Lens 8: hygiene and diagnostics (`hygiene`)

Does the test clean up after itself, and would its failure tell someone what
broke?

| Smell | The scanner saw | Fix |
| --- | --- | --- |
| `leaked-resource` | `mkdtemp`, a server or a spawn, and no `afterEach`, `afterAll`, `finally` or `using` in the file | Give the resource an owner that releases it on the failure path |
| `giant-test` | A test over 150 lines or 40 assertions | `split` into one claim per test, when the claims are independent |
| `opaque-failure` | `expect(a === b).toBe(true)`, `expect(list.includes(x)).toBe(true)` | Compare the values: `expect(a).toBe(b)`, `expect(list).toContain(x)` |
| `unclear-name` | "works", "test 1", a name under five characters | Name the behaviour, the condition and the outcome, and declare the rename in `evidence.renames` |
| `dead-support` (reading) | A helper or fixture nothing imports | Delete it, after `git grep` for its name across the tree |

```ts
// opaque-failure: a failure prints "expected true, received false".
expect(crew.includes("Eurylochus")).toBe(true);
// Fixed: a failure prints the crew.
expect(crew).toContain("Eurylochus");
```

```ts
// leaked-resource: a failed assertion leaves the directory and the server behind.
const dir = mkdtempSync(join(tmpdir(), "ithaca-"));
const server = serve(dir);
expect(await get(server, "/")).toBe("home");
server.stop(); rmSync(dir, { recursive: true });
// Fixed: teardown that runs whatever happens.
const owned: Array<() => void> = [];
afterEach(() => { for (const release of owned.splice(0).reverse()) release(); });
```

Use action `cleanup` (or `split` for a giant test). No extra proof is required
for a cleanup, but the file must still pass:
`bun scripts/test-health.ts measure <file> --runs 2 --out <file>` and read the
verdict before you commit.

Splitting a giant test keeps every assertion. If you find yourself dropping
one, that is the overlap lens, with its proof.

A signal count of 1,500 `opaque-failure` lines across the suite is not a
mandate to rewrite them all. Fix the ones in tests you are already changing or
whose failure would be unreadable; accept the rest with a short note.
