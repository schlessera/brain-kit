# Lens 1: tests that cannot fail

A green test is evidence only if it could have been red. This lens finds tests
that stay green whatever the code does, and makes them able to fail. Each shape
below shipped in this repository with a green suite; the incidents are in
[testing.md](../../../../docs/process/testing.md#tests-that-cannot-fail).

## What to look for

Scanner signals (leads in the brief; read the test before you believe one):

| Smell | The scanner saw | Usually wrong when |
| --- | --- | --- |
| `no-assertion` | A test body with no `expect` | Nothing the test calls asserts either. If a helper asserts, accept it. |
| `weak-matcher` | `toBeDefined()`, `toBeTruthy()`, `not.toBeNull()` | The value has a knowable exact shape. |
| `not-throw-only` | Only `not.toThrow()` | The call also returns or changes something. |
| `conditional-assertion` | `expect` inside `if`, `catch`, or only inside loops | The branch may not run, or the collection may be empty. |
| `self-comparison` | `expect(x).toBe(x)`, or a literal against a literal | Always. |
| `asserts-the-double` | Only `toHaveBeenCalled...` | The code's effect is observable and unasserted. |

Shapes only reading finds. Ask each question of every test:

| Smell | Question | Example of the fault |
| --- | --- | --- |
| `wrong-object` | Is this the object the product path uses? | The test asserts a factory, but the call site builds its own entry. |
| `earlier-layer-answers` | Would it still pass with the code under test deleted? | A 401 assertion passes with the route removed, because the auth guard answers first. |
| `nothing-to-observe` | Does the harness wire the thing the assertion reads? | "principal B is recorded" passes with no store wired at all. |
| `empty-by-construction` | Is the part of the input this test is about non-empty? | A `toEqual` over a request whose `questions` map the test built as `{}`. |
| `derived-expectation` | Does the expected value come from the code under test? | The expected colour is resolved from the same tokens the component paints with. |
| `masked-assertion` | Does an earlier assertion fail first for every break of the later one? | An overflow check fires before the assertion the test is named for. |

Also read the baseline: `zeroAssertionCases` in the `measure` output lists
cases that passed without executing a single assertion. Those are confirmed,
not suspected.

## Confirm with a mutation

Reasoning is not enough: break the guard and watch.

1. Stage your real edits so far: `git add <test files>`.
2. In the working tree, make the smallest change to the **source** that the
   test claims to protect: return the wrong constant, flip a comparison, delete
   the guard, remove the route, skip the write. Keep exports and types intact so
   the module still loads.
3. Run it. The command captures your unstaged change as the mutation, reverts
   it, and runs the test before, with, and after the mutation:

   ```sh
   bun scripts/test-health.ts mutate --test <test file> --name "<case name>" \
     --expect "<text the failure must contain>" \
     --from-worktree <mutated source file> --out <runDir>/receipts/<finding id>.json
   ```

   `--expect` is the assertion you expect to fail: its message (`Expected: 12`)
   or the case name. For a table test (`test.each`), give `--name` the title
   up to its first placeholder: the runner matches names before filling them in.

| Verdict | Meaning | What you do |
| --- | --- | --- |
| `killed` | The test fails on the broken guard and passes again once restored | The test can fail. This receipt is your evidence. |
| `survived` | The test stays green with the guard broken | It cannot fail. That is a finding; fix it and mutate again. |
| `wrong-reason` | It failed, but not on the assertion you named | Usually `masked-assertion` or `wrong-object`. Fix the test, or correct `--expect` if you named the wrong text. |
| `load-error` | The mutant did not load | Your mutation broke an import. Mutate behaviour, not names. |
| `unstable-baseline` | The test fails without any mutation | Not this lens: see [non-determinism](nondeterminism.md) and [failure issues](failure-issues.md). |

Which tests to mutate: every test you suspect, plus one test you do **not**
suspect in each member file, as a control. If a control's mutant survives,
mutate every test in that file.

## Fixing

Assert the thing that differs between right and wrong.

```ts
// weak-matcher: almost anything is defined.
expect(crew()).toBeDefined();
// Fixed: the value itself.
expect(crew()).toEqual(["Eurylochus", "Perimedes"]);
```

```ts
// conditional-assertion: an empty list asserts nothing.
for (const oar of oars) expect(oar.length).toBe(4);
// Fixed: pin the size first.
expect(oars).toHaveLength(12);
for (const oar of oars) expect(oar.length).toBe(4);
```

```ts
// conditional-assertion: passes when nothing throws.
try { await enter(suitor); } catch (error) { expect(String(error)).toContain("refused"); }
// Fixed: the success path fails the test.
await expect(enter(suitor)).rejects.toThrow("refused");
```

```ts
// earlier-layer-answers: the auth guard returns 401 before routing.
expect((await fetch("/api/ledger")).status).toBe(401);
// Fixed: prove the route exists, then that it is guarded.
expect((await fetch("/api/ledger", { headers: session })).status).toBe(200);
expect((await fetch("/api/ledger")).status).toBe(401);
```

```ts
// derived-expectation: the test asks the implementation for the answer.
expect(render(button).color).toBe(resolveToken("button.hover"));
// Fixed: an independent expectation, here the contrast the token must meet.
expect(contrast(render(button).color, render(button).background)).toBeGreaterThanOrEqual(4.5);
```

```ts
// empty-by-construction: the stripped field was never there.
expect(strip({ questions: {} })).toEqual({ questions: {} });
// Fixed: the input carries what the code must remove, and the test says so.
const request = { questions: { depth: { threshold: 3, text: "How deep?" } } };
expect(strip(request)).toEqual({ questions: { depth: { text: "How deep?" } } });
```

For `masked-assertion`, reorder or split until the named assertion is the one
that fails. For `nothing-to-observe`, wire the real collaborator into the
harness and assert a non-empty observation.

## Proof a fixed finding needs

A `killed` mutation receipt for the **same test file**, named in the finding as
`evidence.mutation`. No receipt, no `fixed`.

## When the fix exposes a failure

If the strengthened assertion fails against unmutated code, you have found
either a wrong expectation or a product defect. Do not adjust the expectation
until the test passes. Work out which it is from the product's documented
behaviour; if the product is wrong, file a `type: fix` issue and set the
finding to `filed`, leaving the test as it was.
