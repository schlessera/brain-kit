# Organize and review

Organization earns its place when it makes a future question easier to answer.
Start with the notes you have and give repeated kinds of work a useful home.

## Review the inbox in small batches

Read a few captured notes. For each one, decide whether to keep it as a note,
connect it to an existing record, merge duplicated information or archive it.
An agent's `/process-notes` workflow can help with that review when your client
discovers the installed skills.

You can keep everything typed as `note` until a useful pattern emerges. A
departure plan may deserve its own record; a fleeting thought about the raft
may be useful simply because the plan links to it.

## Keep summaries close to the details

An `_index.md` is a directory's guide to its contents. Current-context records
explain what matters now. When a detail changes the story, update the relevant
summary too. Otherwise a reader or agent may start from an outdated overview.

Use links to point to supporting records. Avoid duplicating a fact across many
files unless you also have a way to keep those copies in step.

## Make maintenance a review, not an automatic rewrite

```sh
brain validate
brain audit
```

Validation checks correctness, including document structure and unresolved
links. Audit points out health issues such as stale content, lagging summaries
and isolated records. Read the findings before changing anything. An older
historical decision can still be worth keeping; a current-focus note may need
attention much sooner.

## Archive records whose work is finished

Archiving keeps the file and its history while removing it from default search.
Use the actual path of the record you want to retire:

```sh
brain archive notes/departure-review.md
```

Archive deliberately. If an agent proposes it, review the affected file and
the reason; operations such as archiving can require approval in the rich UI.

For exact statuses, review thresholds and audit findings, see the
[document and maintenance reference on GitHub](../concepts.md#staleness-and-the-audit-model).
