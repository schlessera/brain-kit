<!--
Title: conventional commit form — feat(ui-server): …, fix(core): …, docs: …
A change to the machine surface is prefixed CONTRACT: instead.
-->

Closes #

## What changed

<!-- One paragraph. What the system does now that it did not do before, or
     stopped doing. Not a list of files. -->

## Why this shape

<!-- The alternative you did not take, and what decided it. If this follows a
     decision record or an issue's stated approach, link it and keep this
     short. -->

## Proof

<!-- What you ran, and what it showed. This repo's standard: a test that
     covers a fix is shown FAILING on the tree before the change. A
     predicate-only unit test is not proof for anything with a runtime — the
     renderer's isolation holes were found by launching real Chrome, not by
     testing its allowlist function. -->

```sh
bun run test
bun run typecheck
bun run lint
```

## Checklist

- [ ] Acceptance criteria from the issue are all met, or the gap is named below.
- [ ] A changeset is included, or this changes nothing a consumer can see.
- [ ] No personal data anywhere in the diff — the leakage gate covers the whole tree.
- [ ] `docs/integration-contract.md` is updated in this same commit, or nothing in the machine surface moved.
- [ ] Docs under `docs/` reflect the change, or nothing documented moved.

## Anything left open

<!-- Known gaps, follow-up issues to file, decisions deferred. Say "nothing"
     rather than deleting the section. -->
