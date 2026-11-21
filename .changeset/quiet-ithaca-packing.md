---
"@schlessera/brain": minor
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-ui-server": patch
---
Discard failed Git packing outputs, preflight conservative headroom, and report existing garbage in maintenance and storage packing JSON. Storage packing accepts a dry run and adds garbage accounting and a conservative packing requirement without changing existing headroom fields. Named skips use optional metadata while preserving the existing CLI reason enum.

Hosted maintenance publishes Git only after a zero exit and a complete successful JSON Git result; uncertain reports discard Git while other validated outputs publish. Successful publication uses the existing publisher.

Nonzero-exit Git discard applies only to routine maintain and explicitly tagged Git maintenance. Other commands publish Git and worktree output together, preserving the metadata needed to continue or abort a conflicted merge.
