# Capture and find

A useful brain starts with a short loop: keep something while it is fresh,
find it when it matters, and connect it to the work it informs.

## Capture a thought before organizing it

From your brain repository, capture a note:

```sh
brain add "Check the water and provisions before launching the raft." --title "Departure check"
```

The capture writes a file into your notes inbox and indexes it. Keep the title
specific enough to recognize later. You can decide where the note belongs
when you review it; capture should not require designing a folder structure.

With a [connected agent](agents.md), you can ask for the same kind of capture
in conversation. A configured [rich interface](interface.md) provides chat
and optional voice capture over your brain.

## Search, then read the source

Use words you remember from the note:

```sh
brain search "provisions" --mode fts
```

Read the returned file before relying on a summary. A search result is a way
into your knowledge; the document contains its qualifications, dates and
related links. Ask an agent to explain the context or follow the links when
the question spans several records.

## Connect the note to a plan

Use the returned path in a wiki-link from a related note or plan. For example,
if capture returned `notes/departure-check.md`:

```sh
brain add "Review [[notes/departure-check]] before leaving Ogygia." --title "Departure review"
```

The link preserves the connection without copying the same checklist into
every document. [Organize and review](organizing.md) explains how to keep
these connections useful over time.

## Refresh after editing files yourself

Capture and MCP write tools update the index as they write. After editing
Markdown in an ordinary editor, run:

```sh
brain index
```

You can now repeat this loop with your own content. Add
[search by meaning](search.md) only when keyword search is missing the
connections you want to find.

For more maintenance and sync commands, see the
[workflow reference on GitHub](../daily-workflow.md).
