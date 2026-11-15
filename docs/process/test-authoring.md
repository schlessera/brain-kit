# Writing tests

How to write a test in this repository: which kind of test proves which kind
of claim, how to structure it, and what keeps it deterministic and cheap.

[testing.md](testing.md) holds the rules and the incidents behind them,
[test-waits.md](test-waits.md) holds the rules for delays, and
[proof-domains.md](proof-domains.md) says which CI category runs which file.
This guide is the positive counterpart: what a good test looks like before
anyone has to repair it.

The `test-health` skill
([SKILL.md](../../.agents/skills/test-health/SKILL.md)) audits existing tests
against these rules. Each rule below names the smells it prevents, by the ids in
`scripts/test-health/catalog.ts`, so a finding and its fix point at the same
sentence. When an audit keeps finding the same smell in new code, the rule here
is tightened in the same change ([the ratchet](#keeping-this-guide-true)).

## Which test for which claim

Pick the cheapest tier that can observe the claim. Cost rises down the table.

| The claim is about | Write | Where | Run it with |
| --- | --- | --- | --- |
| Logic, parsing, formatting, every edge case and error path | A unit test | A package's `tests/` directory, `*.test.ts` | `bun run test <path>` |
| A CLI `--json` envelope or an MCP tool schema | A contract test | The package's `tests/`, listed in `FAST_TESTS` in `scripts/ci-plan.ts` when it guards the contract | `bun run test <path>` |
| Behaviour over real content: retrieval, indexing, ranking | An integration test against the corpus | `packages/core/fixtures/corpus/` is the only fixture world | `bun run test <path>` |
| A boundary only a real runtime decides: Chrome, a native worker, a sandbox, a process | A runtime test | `*-runtime.test.ts` in the owning package | `bun run test <path>` |
| A component's rendering, interaction and light/dark parity | A story with a play function | `packages/ui-kit/stories/` | `bun run test:browser` |
| Painted layout or offline behaviour of the composed app | A layout or offline test | `packages/ui-react/tests/browser/`, `*.layout.tsx` or `*.offline.tsx` | `bun run test:layout` |
| Native pointer and touch behaviour | A pointer test | `packages/ui-react/tests/browser/`, `*.pointer.tsx` | `bun run test:browser` |
| Pixels | A visual baseline | `packages/ui-kit/tests/visual/` | `bun run visual` |
| A real-time guarantee that controlled time cannot establish | An endurance test | `*.endurance.tsx` | `bun run test:endurance` |
| A measurement or eval harness, not the product | An experiment test | `experiments/` | `bun run test:experiments` |

A predicate-only unit test is not proof for anything with a runtime
([testing.md](testing.md#runtimes-browsers-and-doubles)). The reverse also
holds: a runtime test is the wrong place to enumerate cases that a unit test
can observe.

## Enumerate low, prove the seam high

- **T1. Every scenario and edge case is enumerated at the lowest tier that can
  observe it.** Table-driven unit tests carry the bulk: every input class,
  every boundary value, every error path. Prevents `edge-cases-at-high-tier`
  and `missing-lower-tier-owner`.
- **T2. A higher tier proves the seam, once per independent failure mode.** It
  shows that the larger thing works for one representative case and relies on
  the lower tier for the rest. If the browser test passes for one valid date
  and the unit tests cover every date format, the browser test does not repeat
  the formats. Prevents `duplicate-case` across tiers.
- **T3. A matrix dimension needs its own failure mode.** Repeating a scenario
  per theme, width or backend is justified only by a defect that dimension can
  cause ([testing.md](testing.md#light-and-dark-parity)). Storybook owns theme
  parity centrally. Prevents `matrix-multiplier`.
- **T4. Add the cheap owner before reducing the expensive test.** When an
  expensive test is the only place a case is asserted, write the unit test
  first, prove it with a mutation, then reduce. Map every original assertion to
  the test that keeps it ([proof-domains.md](proof-domains.md), step 3 of the
  reconciliation). Prevents losing coverage while fixing `wrong-tier`.

```ts
// Unit tier: every case, in a table.
test.each([
  ["2026-07-12", { year: 2026, month: 7, day: 12 }],
  ["2026-7-2", { year: 2026, month: 7, day: 2 }],
  ["12 July 2026", null],
  ["", null],
])("parseDate(%p)", (input, expected) => {
  expect(parseDate(input)).toEqual(expected);
});

// Runtime tier: the seam, once. The form reaches the parser and shows its answer.
test("the date field shows the parsed date and refuses an unparseable one", async () => {
  await field.fill("2026-07-12");
  await expect(summary).toHaveText("12 July 2026");
  await field.fill("soon");
  await expect(error).toHaveText("Enter a date as YYYY-MM-DD");
});
```

## Structure

- **S1. One claim per test, and the name states it.** Name the behaviour, the
  condition and the outcome: "an expired approval is recorded as expired, not
  declined". A reader should know what broke from the name alone. Prevents
  `giant-test`, `unclear-name` and `masked-assertion`.
- **S2. Every test asserts, unconditionally.** No assertion that only runs
  inside an `if`, a `catch` or a loop over a collection that may be empty.
  Assert the collection's size first; in a `try`, fail the test on the line
  after the call that should throw. Prevents `no-assertion` and
  `conditional-assertion`.
- **S3. Assert the value, not that there is one.** `toEqual(["Eurylochus"])`
  instead of `toBeDefined()`. An assertion that almost any value satisfies
  cannot tell right from wrong. Prevents `weak-matcher`, `not-throw-only` and
  `self-comparison`.
- **S4. Compare values, not booleans.** `expect(island).toBe("Ithaca")`, not
  `expect(island === "Ithaca").toBe(true)`: the failure should print both
  sides. The same goes for a predicate over a collection:
  `expect(crew.every(c => c.rowed)).toBe(true)` hides which sailor failed and
  passes on an empty crew. Map or filter to values instead,
  `expect(crew.filter(c => !c.rowed)).toEqual([])` or
  `expect(crew.map(c => c.name)).not.toContain("Eurylochus")`, and pin the
  size when an empty collection would be wrong. Prevents `opaque-failure`.
- **S5. The expected value does not come from the code under test.** Write it
  as a literal or derive it independently. A test that resolves the same tokens
  the component paints with proves wiring and nothing else. Prevents
  `derived-expectation`.
- **S6. Assert on what the call site uses.** Test the object, route or entry
  the product path actually builds, with a harness that wires the thing the
  assertion observes, and build inputs whose covered part is non-empty.
  Prevents `wrong-object`, `earlier-layer-answers`, `nothing-to-observe` and
  `empty-by-construction`. An absence needs a presence beside it: a test made
  only of `toBeNull()`, `toHaveLength(0)` or `not.toHaveBeenCalled()` also
  passes when nothing rendered or nothing ran, so first assert what must still
  be there (`expect(await canvas.findByText("omens")).toBeVisible()`), then
  what must not be. The same goes for a selector nothing emits: asserting
  `.bk-colour-only` absent holds whatever the components drew.
- **S7. Double the lowest shared request path, and assert the outcome.** A
  double replaces the one method every request goes through; the assertions
  are about what the code did with the answer, not about the double being
  called. Pin behaviour, not the order of internal calls. Prevents
  `double-too-high`, `asserts-the-double`, `over-mocked` and
  `implementation-coupled`.

## Determinism

- **D1. Wait for the thing, not for a while.** Await the acknowledgement, the
  saved revision or the rendered state; advance a test clock through production
  timers. A fixed delay is either too short under load or wasted when idle
  ([test-waits.md](test-waits.md)). Prevents `settling-sleep` and
  `load-sensitive`.
- **D2. Inject time and randomness.** Pass a clock and a seed. Fixtures use the
  pinned date `2026-07-12`. Prevents `wall-clock` and `unseeded-random`.
- **D3. No state shared between tests.** Module-level values are `const`. Each
  test builds or resets what it mutates, so any order and any subset passes.
  Prevents `shared-state` and `order-dependent`.
- **D4. Every resource has an owner and a teardown that runs on failure.**
  Temporary directories come from `mkdtemp`, servers listen on port 0, and
  processes, servers and directories are released in `afterEach`, a `finally`
  or a `using` declaration. Prevents `fixed-resource` and `leaked-resource`.
- **D5. A replaced global is restored completely.** Save and restore the whole
  property descriptor, and delete only what was absent
  ([testing.md](testing.md#runtimes-browsers-and-doubles)). Prevents
  `unrestored-global`.
- **D6. Await every asynchronous assertion.** An `expect(...).resolves` without
  `await` passes before it has checked anything. Prevents `unawaited-async`.
- **D7. A test that does not run proves nothing.** No `skip`, `todo`, `only` or
  `retry` in committed tests. A condition that skips a test must hold in hosted
  proof, with the reason in source; a file must match a pattern a runner
  discovers. Prevents `skipped`, `conditional-skip`, `retry`, `only` and
  `undiscovered`.

## Cost

- **C1. Know the budget of the tier.** Most unit files finish in under a
  second. A file that reaches 30 seconds is a heavy command for
  [host admission](testing.md#host-admission-for-heavy-local-commands) and
  needs a reason a reader can find. Prevents `slow-file`.
- **C2. Pay for setup once.** Build immutable fixtures in `beforeAll` and share
  them read-only. Do not spawn a process per assertion: cover the logic
  in-process and keep one spawned test for the process boundary. Size a fixture
  to the claim. Prevents `per-test-setup`, `spawn-per-assertion` and
  `oversized-fixture`.
- **C3. A real-time wait of a second or more needs its justification.** State
  the failure mode controlled time cannot reproduce and the basis for the
  window ([test-waits.md](test-waits.md)). Prevents `real-time-wait`.
- **C4. Never raise a time budget to make a test pass.** A changed timeout or
  deadline is a proof-system change with its own lane
  ([the CI decision](../decisions/ci-utility.md#proof-system-lane)). A test that
  needs a minute is telling you about its tier or its setup. Prevents
  `long-timeout`.

## Proving a test can fail

- **P1. Kill a mutant.** Break the guard the test protects and watch the named
  test fail on the expected assertion, then restore
  ([testing.md](testing.md#tests-that-cannot-fail)). The command does the
  three runs and writes the receipt:

  ```sh
  bun scripts/test-health.ts mutate --test <test file> --name "<case name>" \
    --expect "<text of the failing assertion>" --from-worktree <mutated source file>
  ```

- **P2. Fail first, for the reason claimed.** A module-load error is not a
  behavioural failure
  ([testing.md](testing.md#failing-first-for-the-reason-claimed)).

## Smells and the rule that prevents each

| Smell | Rule |
| --- | --- |
| `no-assertion`, `conditional-assertion` | S2 |
| `weak-matcher`, `not-throw-only`, `self-comparison` | S3 |
| `opaque-failure` | S4 |
| `derived-expectation` | S5 |
| `wrong-object`, `earlier-layer-answers`, `nothing-to-observe`, `empty-by-construction` | S6 |
| `asserts-the-double`, `double-too-high`, `over-mocked`, `implementation-coupled` | S7 |
| `masked-assertion`, `giant-test`, `unclear-name` | S1 |
| `duplicate-case`, `edge-cases-at-high-tier`, `missing-lower-tier-owner`, `wrong-tier` | T1, T2, T4 |
| `matrix-multiplier` | T3 |
| `settling-sleep`, `load-sensitive` | D1 |
| `wall-clock`, `unseeded-random` | D2 |
| `shared-state`, `order-dependent` | D3 |
| `fixed-resource`, `leaked-resource` | D4 |
| `unrestored-global` | D5 |
| `unawaited-async` | D6 |
| `skipped`, `conditional-skip`, `retry`, `only`, `undiscovered` | D7 |
| `slow-file` | C1 |
| `per-test-setup`, `spawn-per-assertion`, `oversized-fixture` | C2 |
| `real-time-wait` | C3 |
| `long-timeout` | C4 |
| `dead-support` | Delete support code nothing uses; D4 covers what it leaks. |
| `test-fault`, `product-fault`, `unreproduced` | Verdicts on an open failure issue, not authoring faults: a test fault is fixed under the rule it broke. |

## Keeping this guide true

The audit reports how often a later audit finds a smell that an earlier one
called clean, and which smells keep appearing in new tests. When one recurs,
the fix is here first: sharpen the rule, add the example that would have
prevented it, and where the smell is mechanical, propose a `bun run lint` check
that refuses new instances without demanding the old ones be fixed at once.
A rule nobody can follow from this page is a defect in the page.
