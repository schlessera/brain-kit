---
"@schlessera/brain-ui-react": minor
---

The graph canvas and mermaid diagrams follow the theme, from the kit's canvas
palette (seventh drop, rulings 1, 3 and 4).

A real regression first. `useGraphTheme` read the kit's tokens with
`getComputedStyle` and handed the strings to sigma; since the kit's light
theme every token is a `light-dark(<paper>, <dark>)` expression, which a
custom property returns verbatim and a canvas `fillStyle` silently rejects.
Checked in a browser, the dark theme's node labels were drawing in the canvas
default black on the dark ground, with a black outline — unreadable — and the
paper theme's labels were black by the same accident. `lib/light-dark.ts` now
splits the expression on the scheme in force; `useColorScheme` follows the
store's preference and, under `system`, the OS, so the hook re-resolves on a
switch and the canvas re-applies the label ink, the label drawers and every
node and edge colour in place. Labels always take the ink, never a node's
colour.

The palettes are the kit's `--bk-canvas-*` tokens, read for the theme:
`communityColor`, `distanceColor` and `assignFolderColors` take the resolved
palette from `useGraphTheme().palette` rather than module constants, the
maintenance lenses come from the same place, and the legends and the node
card read the same values as the canvas. On paper the nodes wear the
design's paper set at 3:1 against the canvas; slot order is unchanged.
`mermaidThemeVariables` builds both themes from the kit's diagram surfaces,
the slot series and the accent inks, so a diagram in the transcript is drawn
for the scheme the page is in (re-rendered on a switch, cached per scheme)
and a shared export takes the paper surfaces. A bar that carries near-black
text — an active, done or critical task — is a fill, never an ink.
Three source files that used to carry hex literals carry none now, and the
theme gate's allowlist is down to the two files whose colours are not the
theme's.

Prose tints follow the kit's rule: a ground takes the fill hue (the table
row's hover, the blockquote's ground, a file link's hover ground) and a line
takes the ink hue (a link's underline at rest and hovered, the file link's
dotted underline). And a bare mark takes the mark value at every size: the
timeline's status dot, the dictation sheet's live dot, its pulse ring and its
level bars move from `bg-*-fill` to `bg-*-mark`, because an accent fill sits
under 3:1 on paper at any diameter. Buttons and badges that put
`text-primary-foreground` content on a fill are unchanged.
