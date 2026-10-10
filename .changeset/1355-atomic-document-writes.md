---
"@schlessera/brain": patch
---

Document writes no longer truncate a document when they fail. `brain_update`, capture (append and create), archive, `brain import --stamp`, `brain sync`'s merges and `updated` bumps, `brain tags --apply` and hygiene reconcile now all write through one writer: the new bytes go to a temporary sibling and are renamed over the document only when complete, so a full disk or a crash leaves the old document whole and no partial temporary file behind. A replaced document keeps its exact mode, and an archived project moved to `projects/archive/` keeps its source's mode without the umask narrowing it. These writes no longer follow a symlink at the document's own name: `brain import --stamp` and `brain tags --apply` report such a file as failed, and a sync merge reports it unresolved.
