# brain-kit measurement archive

This orphan branch of the public `schlessera/brain-kit` repository holds
historical measurement outputs and two experiment spikes. They were removed
from the main tree by [#1385](https://github.com/schlessera/brain-kit/issues/1385)
because nothing in the current tree reads them. The decision records and
investigations that rely on them stay on `main` and link here.

The branch shares no history with `main` and is never merged into it. Nothing
on it is a package, a release or a test input. Tests on `main` never download
anything from it.

## Citing it

The branch name `archive/measurements` only helps you find the archive. A
durable link names an **exact archive commit**:

```text
https://github.com/schlessera/brain-kit/tree/<archive-commit>/<original-path>
https://github.com/schlessera/brain-kit/blob/<archive-commit>/<original-path>
```

Later bundles arrive as new commits on top of this one. The branch is never
rebased, squashed or force-pushed, so every archive commit that has been
cited stays reachable.

## Layout and identity

Every file sits at its **original repository path**, byte for byte. Nothing
was redacted, re-serialised or regenerated. Each byte sequence was copied with
`git show <commit>:<path>` from main-tree commit
`9adc62e70b4f5eac9b5e3ef779552cd1858a6bd2`, and its SHA-256 was checked against
that source before it was committed here.

Some archived Markdown uses relative links into the main tree, for example
`../../docs/...`. Those links resolve only against the main tree. Read them at
the copied-from commit:
`https://github.com/schlessera/brain-kit/tree/9adc62e70b4f5eac9b5e3ef779552cd1858a6bd2/`.

[`manifest.json`](manifest.json) records each bundle and each file. Four kinds
of SHA appear in it, and they answer different questions:

| Field | Meaning |
| --- | --- |
| archive commit | The commit on this branch that contains the file. Cite this one. |
| `copiedFrom.commit` | The main-tree commit the bytes were copied from. |
| `introducedBy` / `lastChangedBy` | The main-tree commits that first added the file and last changed it. |
| `measuredSource` | The source commit the measurement itself recorded, if it recorded one. An empty list means it did not. That is not the same as the introducing commit. |

The manifest also records each file's size, SHA-256 and git blob ID. Where a
bundle's own data or its durable document records a runtime or method, the
manifest records that too.

## Verifying

```sh
sha256sum -c SHA256SUMS
```

To check the archive against the original main-tree bytes as well:

```sh
git fetch origin <archive-commit> 9adc62e70b4f5eac9b5e3ef779552cd1858a6bd2
git show <archive-commit>:SHA256SUMS | while read -r sum path; do
  a=$(git show "<archive-commit>:$path" | sha256sum | cut -d' ' -f1)
  b=$(git show "9adc62e70b4f5eac9b5e3ef779552cd1858a6bd2:$path" | sha256sum | cut -d' ' -f1)
  [ "$a" = "$sum" ] && [ "$b" = "$sum" ] || echo "MISMATCH $path"
done
```

The archive content passed the repository's public leakage gate
(`bun scripts/check-leakage.ts <archive-root>`, run from the copied-from
commit) before it was committed.

## Bundles

| Bundle | Files | Durable record on `main` | Measured source recorded |
| --- | --- | --- | --- |
| `scripts/measurements/claude-runtime-2026-10-07/` | 8 | `docs/decisions/claude-code-runtime.md` | `86ca7f2408993113f3cba4287b7a01846a8b26ee` (`identity.json` `sourceBase`) |
| `scripts/measurements/claude-runtime-2026-10-08/` | 8 | `docs/decisions/claude-code-runtime.md` | none |
| `scripts/measurements/pi-schema-2026-10-08/` | 2 | `docs/decisions/design-kit.md` | `86ca7f2408993113f3cba4287b7a01846a8b26ee` |
| `scripts/measurements/suggestions-2026-10-07/` (partial) | 24 | `docs/decisions/design-kit.md` | `db2f42cb50c4d220df0c2f5a23aaa8be8ab45a43` |
| `scripts/fixtures/turn-surface-live-2026-10-07/` | 9 | `docs/decisions/turn-surface-routing.md` | `380ad6eaf2f05807e15a67410cae64daaba7be5b`; baseline `e8504586a152a8e2a2090accb132841f96a877aa` |
| `scripts/fixtures/turn-surface-mechanics.json` | 1 | `docs/turn-surface-routing-investigation.md` | `91995dcf1bbf0dbbc3aa7b0f3b2fda6a07c63e6a` (source inspected) |
| `scripts/evals/audit-capabilities/results/2026-10-10/` | 15 | `docs/decisions/audit-repair-suggestions.md` | none; `freeze.json` hashes every source |
| `scripts/evals/note-disposition/results/2026-10-07/` | 7 | `docs/note-disposition-investigation.md` | none; `protocol.json` hashes sources |
| `scripts/evals/opportunity-lifecycle/` keyless reports | 2 | `docs/opportunity-lifecycle-investigation.md` | none |
| `packages/ui-server/evals/triage/experiment/results/` | 3 | `docs/decisions/triage-classifier.md` | none |
| `docs/decisions/design-kit-schema-forms-2026-10-07.json` | 1 | `docs/decisions/design-kit.md` | `6e49ff9e` (recorded abbreviated) |
| `scripts/site-model-spike/` | 12 | `docs/decisions/public-website.md`, `docs/public-website-investigation.md` | none |
| `scripts/policy-boundary-spike/` | 2 | `docs/plans/policy-write-boundary.md` | none |

The suggestions and triage bundles are partial. Their remaining files stay
in the main tree because current code reads them or names them as provenance:

- `scripts/measurements/suggestions-2026-10-07/executed-manifest.json`
- `scripts/measurements/suggestions-2026-10-07/input-review-snapshot.json`
- `scripts/measurements/suggestions-2026-10-07/review-receipt.json`
- `scripts/measurements/suggestions-2026-10-07/shared-corpus-review-receipt.json`
- `packages/ui-server/evals/triage/experiment/results/2026-10-09-answers.json`

The file-level inventory, including everything that was retained and why, is
`docs/decisions/measurement-archive.md` on `main`.

## Reproducing the spikes

Both spikes import from, or read, the rest of the repository at its paths at
the time. Reproduce them in a full checkout of the copied-from commit, where
both are still present at their original paths:

```sh
git clone https://github.com/schlessera/brain-kit.git brain-kit-repro
cd brain-kit-repro
git checkout 9adc62e70b4f5eac9b5e3ef779552cd1858a6bd2
```

To overlay this archive on another checkout instead, run
`git restore --source <archive-commit> -- scripts/site-model-spike scripts/policy-boundary-spike`
after fetching the archive commit. Neither spike was rerun for this archive.
The runtimes below are the ones recorded when each was measured. Later
toolchains are not known to work.

### `scripts/site-model-spike/` (#611)

This is a standalone npm project with its own `package-lock.json`, outside the
Bun workspaces. Its own `README.md` is the full procedure, and it was copied
unchanged. Historical requirements:

- Astro 7.3.5, pinned by the lockfile, which requires Node >= 22.12. The final
  proof used Node 22.18.0. A fresh install warns that transitive `undici`
  8.11.2 requires Node >= 22.19.0.
- The repository installed with `bun install --frozen-lockfile`, for its
  pinned Playwright.
- A local Chrome at `/usr/bin/google-chrome`, used by `verify.mjs`.

```sh
bun install --frozen-lockfile
npm ci --prefix scripts/site-model-spike --ignore-scripts --no-audit --no-fund
npm --prefix scripts/site-model-spike run build
npm --prefix scripts/site-model-spike run preview -- --port 43811 --ignore-lock
# in another terminal, same Node:
node scripts/site-model-spike/verify.mjs http://127.0.0.1:43811 /brain-kit/
```

Recorded failure: a later Node 24.21.0 cold build crashed in V8 after earlier
runs had succeeded. The investigation keeps that failure and does not count
it as a pass.

### `scripts/policy-boundary-spike/` (#750)

`probe.py` drives `worker.ts`. `worker.ts` imports
`packages/ui-backend-claude/src/spawn-wrapper.ts` and the installed
`@earendil-works/pi-coding-agent`, so it needs the full checkout and a frozen
Bun install. The procedure is from `docs/plans/policy-write-boundary.md`:

```sh
bun install --frozen-lockfile
set -o pipefail
python3 scripts/policy-boundary-spike/probe.py 2>&1 | tee /tmp/policy-boundary-proof.log
python3 scripts/policy-boundary-spike/probe.py --mutation 2>&1 | tee /tmp/policy-boundary-mutation.log
python3 scripts/policy-boundary-spike/probe.py 2>&1 | tee /tmp/policy-boundary-restored.log
```

The mutation run is expected to exit 1 with
`POLICY_BYTES_UNCHANGED failed: write under mutation`. Recorded environment
(2026-10-01): Linux x86_64 on a WSL2 kernel, Bun 1.3.14, Python 3.12.3,
bubblewrap 0.9.0, Landlock ABI 7, installed pi coding-agent 0.99.2 and Claude
Agent SDK 0.3.283.

## Evidence limits

These files show what was measured, on the runtimes they record, at the time
they record. They make no claim about the current product:

- The policy-boundary spike is a filesystem experiment. It runs no Claude model
  turn and is no network, credential or configuration sandbox. It does not
  establish current product containment.
- The site-model spike is feasibility evidence for a content model. It does not
  establish the correctness of the current public website.
- Running a producer script again creates a new measurement. It does not
  replace an original live receipt here.
- The runtime receipts describe the Claude Code, Agent SDK, pi and Bun versions
  they record, and no others.
