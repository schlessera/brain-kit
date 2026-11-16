---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

Keep a turn's data tree on the managed native volume. A strict, voice or autonomous turn on managed storage now gets its data tree from the native manager, in an app-owned directory beside the live brain, and fills it by reflinks from its checkpoint, so concurrent turns no longer each hold a full copy of the documents and index. A copy that cannot share extents fails the turn instead of copying in full. The native manager client and lease owner gain `prepareTurnTree` and `releaseTurnTree`. The manager charges each tree's allowance against the volume, keeps one emergency reserve of headroom, refuses to remove a tree a worker still mounts, and credits the space only after the filesystem has reclaimed it. A turn's committed changes may write at most 64 MiB into its tree.
