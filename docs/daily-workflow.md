# Daily workflow

Start here after the [quickstart](quickstart.md). These commands work in your
brain repository with the installed `brain` CLI. If it is not on your `PATH`,
use `bun run brain` instead. Capture and keyword search need no model account.

## Capture and find a note

```sh
brain add "Odysseus needs timber and sailcloth for the raft." --title "Raft supplies"
brain search "sailcloth" --mode fts
```

On a fresh brain the capture creates `notes/raft-supplies.md` and indexes it.
An occupied filename receives a suffix; use the path returned by your capture
when reading or linking the note:

```sh
brain read notes/raft-supplies.md
brain add "Check [[notes/raft-supplies]] before leaving Ogygia." --title "Raft inspection"
```

The second note makes the connection explicit. Wiki-links resolve to files;
[concepts](concepts.md#wiki-link-resolution) explains ambiguous names and
directory links. You can keep everything as `note` until a useful taxonomy
emerges. `/brain-init` or hand-edited [configuration](configuration.md) can
add types later. `/process-notes` helps an agent review and file the inbox.

## Review changes and index edits

`brain add` and MCP writes update the index themselves. After editing markdown
in an editor, refresh it explicitly:

```sh
brain index
brain validate
brain audit
brain stats
```

Validation checks file/config correctness. Audit reports maintenance findings;
its informational findings are distinct from errors and warnings. Stats shows
current health, the thresholds in force and inventory. Read the findings before
changing content. After reviewing a mechanical edit that deliberately did not
change `updated`, `brain accept-mtime` accepts the new file timestamp as the
baseline for silent-edit detection.

To retire the inspection note without deleting its history:

```sh
brain archive notes/raft-inspection.md
```

Archived content is excluded from default search; `brain search "Ogygia"
--include-archived` includes it. Use the actual capture path if a suffix was added.

## Maintain and sync

`brain maintain --no-git` runs the content/index maintenance steps without git
packing. It can regenerate declared registries, refresh the index and prune
disposable scratch files; inspect its report for failed steps. The
[CLI reference](cli.md#index--quality) describes the sequence and flags.

A private remote gives you an off-machine copy. Configure and verify it before
syncing; the [backup guide](hosting/README.md#backups) explains what needs to be
kept. Run sync from the `main` branch of a brain whose `origin` is configured:

```sh
brain sync --human
```

Sync commits recognized content, pulls, merges and pushes. It leaves unknown
files and unresolved conflicts for judgment. It can invoke your configured
agent runner when that judgment is needed; without the required runner/account,
complete the handoff rather than treating an unfinished sync as success. The
[sync reference](cli.md#skills-modules-config) explains machine output and exit
codes, and [configuration](configuration.md#sync) explains pull and merge policy.

## Choose the next capability

- [Modules](modules.md) add a domain workflow when your notes need one.
- [MCP](mcp.md) gives an agent structured access to the same files and search.
- [Semantic search](quickstart.md#turn-on-semantic-search-optional) adds vectors
  when you choose to provide credentials; keyword search remains available.
- [Search evaluation](evaluating-search.md) measures whether retrieval changes
  improve answers on your own query set.
- [Hosting](hosting/README.md) keeps backup and optional phone access separate
  from the local workflow.
