# Real-time wait re-census, second pass — 2026-11-08 (#3332)

The first pass (`../wait-census-3332-2026-11-02/`) classified every wait in
files that started matching after the #1849 inventory source, at
`3984040f`. This pass re-runs the same expression at a later `main` and covers
what was added since then. https://github.com/schlessera/brain-kit/issues/3332
owns the work, under epic https://github.com/schlessera/brain-kit/issues/1849.

## Sources

| Role | Commit |
| --- | --- |
| Census source (`main`) | `a63e564f02f9b1ab0462bb0ac02dbf8ea6eacee7` |
| First re-census source | `3984040f199cbadbee6e4ce3f1beff816b68dc36` |
| #1849 inventory source | `5dc2595ca07042f2e2024c95bbc361f31637559f` |

## Commands

From a brain-kit checkout with all three commits fetched:

```sh
P='setTimeout|Bun.sleep|waitForTimeout|sleep\('
files() { git grep -l -E "$P" "$1" -- tests experiments ':(glob)packages/*/tests/**' | sed "s/^$1://" | sort; }
{ printf 'source\tfile\n'; { files 5dc2595ca07042f2e2024c95bbc361f31637559f; files 3984040f199cbadbee6e4ce3f1beff816b68dc36; } | sort -u | sed 's/^/base\t/'; } > base.tsv
bun classify-waits.ts a63e564f02f9b1ab0462bb0ac02dbf8ea6eacee7 base.tsv > wait-census-lines-a63e564f.tsv
{ printf 'file\tline\ttext\n'; bun changed-lines.ts 3984040f199cbadbee6e4ce3f1beff816b68dc36 a63e564f02f9b1ab0462bb0ac02dbf8ea6eacee7; } > changed-lines-since-3984040f.tsv
```

`classify-waits.ts` is byte-identical to the first pass's classifier. Its
baseline is now the union of the files matching at both earlier sources, so
only files new since `3984040f` are classified. `changed-lines.ts` is new: for
files that already matched at `3984040f`, it lists the matching lines whose
trimmed text does not occur there (with multiplicity).

## Counts

- 66 files started matching after `3984040f`: 128 lines
  (`scope-files-new-since-3984040f.txt`, `wait-census-lines-a63e564f.tsv`).
  The rules give 77 justified, 37 replaceable and 14 not a wait
  (`summary.tsv`).
- 35 lines were added to files that already matched
  (`changed-lines-since-3984040f.tsv`). Most are the replacements and reason
  comments of the first pass's slices.

## Reviewed outcome

`reviewed-outcome.tsv` records a hand review of every row the rules called
replaceable or a negative observation (50 rows), the changed lines that were
neither a slice's own edit nor already justified by shape (8 rows), and the
two residues the earlier slices left open. Each row was re-read in its
enclosing test. 25 rows now use a deterministic signal (for the
`hygiene-media` `settle` alias, at two of its six callers), 34 are justified (each
negative window or kept real-time wait with its reason in source) and one is
not a wait. The pull request that delivers these slices records a mutation
receipt for each replacement, and names the one replacement no mutation turned
red (`refused-launch-gate` case 1).

## Limits

- The classification is rule-based, as in the first pass. Rows the rules
  called justified by shape (failure maxima, condition polls, yields, holds)
  were not each re-read.
- `ms` is the literal in the call, not an execution count or elapsed time.
- New waits keep landing on `main`. This bundle is a census at one commit, not
  a standing guard; a guard was option C of the 2026-11-02 ruling and was not
  chosen.
