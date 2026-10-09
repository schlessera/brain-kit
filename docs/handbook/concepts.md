# How your brain works

Think of your brain as a set of connected records. A note captures a thought;
a plan turns it into work; a decision keeps the reasons for a choice. An agent
can read and update those records, but the records belong to you.

## Files are the durable part

Your knowledge lives in Markdown files in a git repository. You can open them
in a text editor, review a change with git or use them with a different tool.
Brain-kit builds a search index from those files. The index helps you find
things quickly; it can be rebuilt from the files if it is lost or outdated.

For example, Odysseus might keep a note about preparing the raft alongside a
departure plan. Both are ordinary files, not messages locked inside a chat.

## Metadata gives a note a little structure

A document starts with a small YAML block called **frontmatter**. It tells
brain-kit what the document is and when it was last meaningfully updated.
Below it, the body is ordinary Markdown:

```markdown
---
type: note
title: Raft preparations
created: 2026-07-12
updated: 2026-07-12
tags: [route]
status: active
---

Check the water and provisions before leaving Ogygia.
```

Capture tools write this structure for you. When you edit files yourself,
keep the dates as bare `YYYY-MM-DD` values and update `updated` when the
meaning changes. The file viewer can show frontmatter separately from the
body, so metadata does not get in the way of reading.

## Links connect the context

A wiki-link such as `[[notes/raft-preparations]]` connects one record to another.
The departure plan can point to its preparation notes rather than repeat them.
Following that link lets you inspect the context behind the plan.

Prefer a qualified path when a name could refer to several documents. A short
link such as `[[calypso]]` works when the target is unambiguous. Brain-kit
reports unresolved links instead of silently choosing a document for you.

## Start with notes; add types when they help

A **document type** describes a kind of record, such as a note or current
context. The mapping from types to directories is your **taxonomy**. You do
not need to design a complete taxonomy before you start. Keep simple notes,
then introduce a type when a repeated kind of work needs different fields or
a more useful home.

This is how the parts fit together: files keep the knowledge, metadata makes
it understandable to tools, links preserve relationships, and the index makes
it findable. An agent works across those parts to help you act on the knowledge.

For exact frontmatter fields, link-resolution rules and maintenance behavior,
use the [file-format reference on GitHub](../concepts.md).
