---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-react": minor
---

The turn journal records the brain's disposable search index by metadata only (#2873). `.brain-index/brain.db`, its `-wal`, `-shm` and `-journal` sidecars and an index publication copy keep their path, size and change stamp in history, so every refresh still shows as a change, but their bytes are no longer copied into retained objects. A governed turn's journal finish no longer copies a whole new index version after each automatic refresh.

Breaking before 1.0, ruled on #2873: index versions were byte-retained, readable and restorable, and now are not. Their `JournalVersion` carries the new `metadataOnly: true` and an opaque change `stamp`, and no `hash` or symlink `target`; preview answers `reason: "metadata_only"`, raw download is 404, versions retained by earlier releases are presented the same way, and history revert and Undo exclude the index as `metadata_only` (including versions retained by earlier releases) and leave it to the following index refresh, without marking the operation partial. Rebuild the index with `brain index --force`. A metadata-only version is not a missing version and does not make a turn partial. The history reader lists these entries under "Search index · metadata only" with no review action. Every other path, including other names inside `.brain-index/`, keeps its exact retained bytes. Existing history is not erased.
