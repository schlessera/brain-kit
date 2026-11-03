---
"@schlessera/brain": minor
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-ui-server": patch
"@schlessera/brain-module-diagrams": patch
"@schlessera/brain-module-travel": patch
---

**Breaking: `safeResolve` and `resolveWritable` from `@schlessera/brain/module` now give the strictest containment answer in every row (#3422).** They return `null` for:

- an absolute path, even one inside the brain root;
- any `..` segment, even when the result stays inside;
- `:` or `\` in a segment;
- a dangling symlink, even one whose target is inside;
- a path that leaves the root through one symlink and comes back through another, since every existing component must now stay inside, not only the final path.

A root whose realpath fails was already refused, and still is. The answer is still the canonical path.

The CLI resolves its path arguments through the same helpers. A path given to `--out`, `--stamp`, `brain read`, `brain process`, `brain render`, `brain image` or `brain diagram export` is therefore refused when it is absolute, even inside the brain, as the integration contract's containment guarantee already says. Pass it relative to the brain root.

Migration for module authors: pass paths relative to the brain root. To re-check an absolute path you already hold, such as an earlier answer from `safeResolve`, pass it relative to the root's realpath (`relative(safeResolve(root, ".")!, path)`). Normalise a link target before resolving it (`join(dirname(path), target)`) instead of sending its `..`. Do not rely on a dangling link to name a file you are about to create.

The ui-sdk's `resolveInRepo` and the server's file `safeResolve` give the same answers. The SDK newly refuses `..`, `:` and `\`, dangling links and out-and-back links. The server newly refuses a missing brain root instead of falling back to the lexical path.

The deny-direction containment checks now treat `/` as holding every absolute path. Before, a `/` source passed the worker launcher's refusal of "the brain or its ancestors" for a transport bind, a managed worktree generation and a reference source view, and the server's sync transport mounted a local remote of `/`. A host credential state directory of `/` was also accepted. All of these are now refused.
