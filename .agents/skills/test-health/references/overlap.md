# Lens 2: overlap within and across tiers

Cheap tests should do the bulk of the work: every scenario and every edge case,
once, at the lowest tier that can observe it. Expensive tests build on that:
they prove the larger thing works for one representative case and rely on the
cheap tests for the rest. This lens finds where that division has slipped
(rules T1 to T4 in
[the authoring guide](../../../../docs/process/test-authoring.md#enumerate-low-prove-the-seam-high)).

## What to look for

The brief lists each member's neighbours: `horizontal` means the same tier,
`vertical` means a cheaper or dearer one, with the source modules or name they
share. For the seed and each neighbour, write down the scenarios (the test
names are usually enough), then compare the lists.

| Smell | You see | Where |
| --- | --- | --- |
| `duplicate-case` | The same scenario asserted twice under different names, or a copied table | Same tier. The scanner flags identical titles in one file; duplicates across files are yours to spot. |
| `edge-cases-at-high-tier` | A runtime, browser or layout test looping over formats, error codes or boundary values that a unit test already enumerates | A dear test, with a cheap owner present |
| `missing-lower-tier-owner` | The same, but **no** cheap test owns those cases | A dear test is the only owner |
| `matrix-multiplier` | A scenario repeated per theme, width, backend or browser without a defect that dimension can cause | Nested loops and tables; the scanner flags the nesting |

Tiers by cost: `fast` and `unit`, then `runtime`, then `browser` and `layout`,
then `endurance`.

## Deciding

Ask of each repeated scenario: **if the cheap test passes, what could still
break at the dear tier?**

- "Nothing new; the dear test repeats the logic": the dear copy is overlap.
  Keep one representative that proves the seam.
- "The wiring, the real runtime, the painted result": that is the seam. Keep
  it, once per independent failure mode, not once per input.
- For a matrix: name the defect only that dimension could cause. Theme parity
  is owned centrally by Storybook
  ([testing.md](../../../../docs/process/testing.md#light-and-dark-parity)); a
  theme loop in a recovery test needs a theme-sensitive defect to justify it.

Do **not** reduce:

- Security assertions repeated at more than one layer on purpose.
- Native, responsive or accessibility proof with no cheaper equivalent.
- The same file running in two browser projects: each project and file is a
  deliberate execution
  ([proof-domains.md](../../../../docs/process/proof-domains.md)).

## Fixing

| Situation | Action | Steps |
| --- | --- | --- |
| Two tests assert the same scenario in one tier | `merge` or `remove` | Keep the clearer one; make sure it holds every assertion of the other. |
| A dear test repeats cases a cheap test owns | `remove` (the repeated cases) | Reduce the dear test to its representative case. |
| A dear test is the only owner of the cases | `move-tier` | **First** add the table-driven unit test and kill a mutant with it. **Then** reduce the dear test. |
| A matrix cell has no failure mode of its own | `remove` | Keep the cells that have one; say which in the note. |

The file you change must be a member. The test that keeps the obligation may
be a member or a context file: a context file is read-only, but it can be the
owner you point to.

## Proof a fixed finding needs

These actions take assertions away, and nobody will read the diff, so both of
the following are required:

1. **An obligation map** (`evidence.obligations`): one entry per assertion of
   the removed, merged or reduced test.

   ```json
   { "claim": "an empty date string is refused", "owner": "packages/ithaca/tests/dates.test.ts > parseDate(\"\")" }
   ```

   `owner` is `<file> > <case name>` of the test that still makes that
   assertion after your change. If you cannot name an owner for an assertion,
   that assertion is unique: keep it.

2. **A killed mutation on a retained owner** (`evidence.mutation`): break the
   behaviour the removed test covered, and show the owner fails
   ([how](cannot-fail.md#confirm-with-a-mutation)). This proves the coverage
   is really still there, not just listed.

3. **The tests you removed, by name** (`evidence.removes`, and
   `evidence.removedCases` when a table lost rows): see
   [declaring every test that disappears](worksheet.md#declaring-every-test-that-disappears).

The recorder and the batch gate account for every test: each title that is
gone must be one you declared, and the executed case count may fall only by the
number you declared. A removal that takes one more test with it than you named
is refused.

## If in doubt

Defer. Two tests that look alike often guard two different regressions, and the
incident that explains the second one is in an issue you have not read. Check
`git log -p -S "<case name>" -- <file>` for why a test was added before you
remove it.
