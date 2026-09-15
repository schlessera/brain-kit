# Design-file fetch — COMPLETE

All 59 files are on disk. Nothing outstanding.

**Where:** the session scratchpad, `design/` subdirectory (path is in the
session's own environment block — deliberately not written here, because
`scripts/check-leakage.ts` scans the whole tree including untracked files and
the home-directory path contains a banned personal string).

Contents: `kit/` with 56 `*.dc.html` components + `README.md` + `support.js`,
plus root `support.js`, `Brain Kit.dc.html` (the catalog, 82 KB),
`Second Brain Mobile.dc.html` (the twenty source screens, 139 KB) and
`github.md`. 744 KB total.

## How it was done, and the trap to avoid repeating

`DesignSync` is **main-session only**. All five subagents dispatched to fetch
batches reported the tool absent from their roster — which is a *different*
failure from the authorization error the main session hit before `/design-login`,
and it is not fixable by retrying or re-authorizing. Do not delegate DesignSync
work to subagents.

Relaying 56 files by hand would have cost roughly double their size in context
(read in, write out). It was avoided: the harness persists any large tool result
to a file automatically, and every inline result is recorded in the session
transcript. `extract.ts` and `extract2.ts` in the scratchpad harvest every
`get_file` payload out of both sources and write them to disk. `extract2.ts` is
idempotent — re-run it after any further fetch batch:

```sh
bun "$SCRATCHPAD/extract2.ts" <session>.jsonl <tool-results-dir> "$SCRATCHPAD/design"
```

It reports `!! TRUNCATED <path>` for any file that hit the 256 KiB `get_file`
cap. Nothing was truncated in this run.

## Verified

Checked all 56 expected component filenames against disk — zero missing.

## If a fresh session needs these again

The scratchpad is session-specific and will not exist. Re-fetch with
`DesignSync get_file` from the main session, project
`998d0e7e-1644-48e0-aa35-26dd3022d565`, then run the extractor. The file list is
`DesignSync list_files` on that project.
