---
"@schlessera/brain-ui-server": minor
---

`safeResolve` canonicalizes the brain root, walks every existing component of the resolved path through `lstat` and `realpath`, fails closed on a dangling symlink, treats unresolvable components as not found, and rejects Windows path syntax up front; share staging resolves the inbox parent through it before `mkdir`, so a symlinked `.brain-ui/inbox` fails loudly instead of redirecting writes. Error responses no longer echo filesystem paths.
