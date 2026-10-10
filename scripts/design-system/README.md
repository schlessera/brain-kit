# Design System producer

Builds the files of the **Brain Kit** Design System artifact from
`packages/ui-kit`, so an agent designing for this repository reads the kit's
real tokens and mounts its real components instead of approximating them.

```sh
bun scripts/design-system/build.ts [--out <dir>]
```

The output goes to `<dir>/project/` (default `$TMPDIR/brain-kit-design-system`).
It must stay outside this tree, because the leakage gate scans untracked files
too. The build runs Chromium through Playwright and loads fonts from Google
Fonts, so it needs the network. It exits non-zero if any story fails to render.

## What it builds

| Output | From |
| --- | --- |
| `tokens.json` | Every `--bk-*` colour in `packages/ui-kit/src/tokens.css`, keeping its name, with Dark, Paper and Print values. The type, spacing and radius scales mirror `theme.css` and the kit's most-used `font` shorthands (`tokens.ts`). |
| `components/bundle.js` | One classic script assigning `window.BrainKit`. It holds every runtime export of the kit, the Storybook stories, and `BrainKit.__mount(el, title, [stories])` (`bundle.ts`, `mount.ts`). |
| `components/bundle.css` | The kit's precompiled `styles.css`, plus two rules for preview bodies. |
| `components/lib/*.js` | React and ReactDOM at the workspace's installed version. `libraries.json` beside `project/` is the index's `libraries` entry. |
| `components/<Comp>/README.md`, `preview.html` | The component's doc comment, and up to six of its stories (`cards.ts`). |
| `components/Screen*`, `Rules*`, … | Showcase cards for the assembled screens and the rule stories. |
| `components/index.d.ts` | The kit's emitted declarations, concatenated for reading. |
| `README.md`, `components/Cover/preview.html` | Hand-written: `content/README.md` is the brand book and `content/Cover.html` is the cover. Edit them here. |

Stories are CSF factories. `#.storybook/preview` and `storybook/test` resolve to
the shims in `shims/`, which keep `meta`, `story` and `extend` semantics. Play
functions are carried but never run. Stories that import
`@schlessera/brain-ui-react` are left out, because they would pull in the whole
app and exceed the artifact's 6 MB bundle cap.

## Publishing

Publishing is done with Claude Code's Artifact tool, not by this script,
because it needs the maintainer's claude.ai session:

1. Read the artifact's `project/design-system.json`. Keep every key, set
   `libraries` from `libraries.json` and `lastChange` to now, and write it
   beside the built `project/`.
2. Publish `project/` to the artifact's URL in one call, with the index as
   `file_path` and every other file in `files`. `components/index.d.ts` needs
   `contentType: "text/plain"`, because `.ts` is not a served type.
3. On a re-sync, send only the files that changed, and keep usage notes or
   README prose that someone edited on the page.

The colour reader excludes the `@layers:start` / `@layers:end` fence: D54's
numeric document layers are read by the kit's separate layer pipeline.
Unsupported values outside that fence still fail the colour gate.
`tests/design-system-tokens.test.ts` covers the token reader.
