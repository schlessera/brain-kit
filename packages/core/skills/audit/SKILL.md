---
name: audit
description: Use when checking whether a brain is in good shape or asking what needs cleaning up — stale documents, index rows that lag their detail files, orphans, documents filed under the wrong type, noisy tags. Also use for a periodic tidy-up pass.
compatibility: Requires git.
---

# Audit — Triage and Fix Quality Findings

Runs the brain's quality audit and turns raw findings into action: mechanical fixes applied
directly, judgment calls proposed to the user. The audit is deterministic; the fixing is where
the agent adds value.

**This skill orchestrates; `brain audit` detects.** Do not re-implement detection — parse the
audit and decide what's safe to fix versus what needs the user.

## 1. Run the audit

```bash
brain audit --json
```

Parse the findings and group them by category.

## 2. Triage by category

| Category | Meaning | Disposition |
|---|---|---|
| staleness | past the type's staleness threshold | propose — needs a human to confirm it's still current |
| index-lag | an `_index.md` trails its detail files | **fix** — update the registry row to match the detail file |
| propagation | a derivative is older than its canonical source | propose — regenerating derivatives is judgment work |
| orphan | referenced target missing / unreferenced file | propose — could be a rename or a genuine loss |
| type-mismatch | document lives outside its type's directory | **fix** if the move is unambiguous; else propose |
| todo / verify | `TODO` / `VERIFY` markers in content, one info finding per document and kind (`count`, first three in `examples`); `verify` also for `verification: unverified` | propose — surface them, don't resolve silently |
| broken-link | a wiki-link that resolves to nothing (`target` names it) | propose — could be a rename, a missing alias or a genuine loss |
| tag-noise | near-duplicate or one-off tags | **fix** — normalize obvious duplicates |

## 3. Fix the safe ones

Apply mechanical fixes directly when the correct outcome is unambiguous:

- **index-lag** — edit the `_index.md` row (status/date) to match the detail file's frontmatter;
  bump the `_index.md` `updated` only if a row actually changed.
- **type-mismatch** — move the file to its type's directory when there's exactly one right home.
- **tag-noise** — merge clear duplicate tags (e.g. `k8s` → `kubernetes`) across affected files.

Never bump `updated` on a file whose content didn't change — avoid timestamp churn.

## 4. Propose the rest

For staleness, propagation, orphans, and TODO/VERIFY markers, present the finding with enough
context for the user to decide, and make the edit only on their say-so. These involve knowledge
the audit can't have (is this fact still true? should this derivative be regenerated?).

The `brain audit --fix` flow produces AI-authored fix suggestions and is a separate, interactive
path — this skill does not invoke it as part of a sweep.

## 5. Re-check and commit

After applying fixes, re-run `brain audit --json` to confirm the mechanical findings cleared, then:

```bash
brain validate
git add -A && git commit -m "audit: fix N mechanical findings"
```

Report what was fixed and what's awaiting the user's decision.

## CLI it relies on

- `brain audit --json` — the quality findings.
- `brain validate` — confirm the brain is still consistent after fixes.
- `git` — commit the mechanical fixes.
