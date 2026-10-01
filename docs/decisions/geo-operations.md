# Shared geo ownership and track evidence

## Ownership — 2026-10-01

The [#525 ownership ruling](https://github.com/schlessera/brain-kit/issues/525#issuecomment-5927878544)
selects a separate concrete `@schlessera/brain-geo` package. Core owns the geo CLI;
SDK server and content modules consume the same implementation. A geo dependency
back on a consumer would couple standalone operations to the UI/content world or
create a cycle. A provider registry would add the seam the ruling excludes.
Concrete endpoint configuration provides replacement without a framework.

The library joins the existing fixed release group. It builds/publishes before
its consumers, with source/dist exports and packed import coverage. The root
geometry entry point contains no server I/O or rasterizer dependency; server
operations remain a separate import boundary.

## Shared XML parsing and recovery — 2026-10-01

The [recovery B ruling](https://github.com/schlessera/brain-kit/issues/525#issuecomment-5930250252)
requires usable sections, exact omissions and partial evidence instead of dropping
an otherwise readable file. Connecting points across an omission invents a line,
distance and elapsed interval. Rejecting the whole file discards usable evidence.
Clamping coordinates or treating poles/zero as invalid confuses parser validity
with the limitations of a drawing projection.

One reader owns namespace/path validation, strict XML, encoding/entity/nesting,
byte and point limits (`readGpx`, `packages/geo/src/track.ts:56-145`). Its strict
entry point preserves travel's existing result/rejection behavior
(`parseGpx`, `packages/geo/src/track.ts:148-151`). The recovery entry point keeps
valid isolated points, reports each omission and returns a clear no-line outcome
(`parseTrackGpx`, `packages/geo/src/track.ts:154-156`). Invalid points still count
toward the resource limit. Structurally duplicated optional fields remain errors
even in omitted points; recovery does not make unsafe XML acceptable.

Failing-first fixtures observed the old parser's error where partial and no-line
results were required. A restored split mutation joined two usable sections and
failed the actual longitude-array assertion. Separate restored mutations proved
strict rejection, invalid-point counting, byte/doctype guards, foreign namespace
exclusion and duplicate-field refusal on their intended assertions. Existing
travel runtime fixtures verify the actual CLI continues to normalize, measure,
trim and write the same strict geometry.
