---
"@schlessera/brain": minor
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-ui-server": patch
"@schlessera/brain-module-diagrams": patch
"@schlessera/brain-module-travel": patch
"@schlessera/brain-module-images": patch
---

**Breaking: `safeResolve` and `resolveWritable` from `@schlessera/brain/module` now give the strictest containment answer in every row (#3422).** They return `null` for:

- an absolute path, even one inside the brain root;
- any `..` segment, even when the result stays inside;
- `:` or `\` in a segment;
- a dangling symlink, even one whose target is inside;
- a path that leaves the root through one symlink and comes back through another, since every existing component must now stay inside, not only the final path.

A root whose realpath fails was already refused, and still is. The answer is still the canonical path.

The CLI still accepts an absolute path argument inside the brain. Before resolving one, it converts it to a brain-relative path with the new `brainRelativeArgument(root, arg)`, which `@schlessera/brain/module` also exports for module commands. This covers `--out`, document paths and the other CLI path flags. An absolute path outside the brain is still refused, and so is one that reaches the outside through a symlink inside the brain or has a `..` segment.

Migration for module authors: pass paths relative to the brain root. A module command that takes a path argument from the user passes it through `brainRelativeArgument(ctx.root, arg)` first, as the first-party commands do. To re-check an absolute path you already hold, such as an earlier answer from `safeResolve`, pass it relative to the root's realpath (`relative(safeResolve(root, ".")!, path)`). Normalise a link target before resolving it (`join(dirname(path), target)`) instead of sending its `..`. Do not rely on a dangling link to name a file you are about to create.

The ui-sdk's `resolveInRepo` and the server's file `safeResolve` give the same answers. The SDK newly refuses `..`, `:` and `\`, dangling links and out-and-back links. The server newly refuses a missing brain root instead of falling back to the lexical path.

The deny-direction containment checks now treat `/` as holding every absolute path. Before, a `/` source passed the worker launcher's refusal of "the brain or its ancestors" for a transport bind, a managed worktree generation and a reference source view, and the server's sync transport mounted a local remote of `/`. A host credential state directory of `/` was also accepted. All of these are now refused.
