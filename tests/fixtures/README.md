# Recorded test inputs

`show-block-137-tool-calls.json` is the original tool-call transcript used by
#137 and the design-kit measurements. It records the former core fixture
world and paths. Preserve it byte-for-byte: the tests inspect what that run
actually called, rather than execute its file paths against today’s corpus.

The [2026-09-30 corpus ruling](../../docs/decisions/example-corpus.md)
supersedes that example world for active fixtures, harnesses and captures.
New runs use Odysseus and carry their own provenance. This historical receipt
is not a template for a public demo.
