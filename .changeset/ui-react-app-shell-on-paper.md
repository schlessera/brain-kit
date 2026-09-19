---
"@schlessera/brain-ui-react": minor
---

The app shell follows the light theme (D39).

`theme.css` declared every utility colour as a literal dark hex, so under
`data-theme="light"` the kit's cards turned to paper while the page, the rail
and every `bg-surface` / `text-foreground` element around them stayed dark.
Every `--color-*` is now the kit's own `--bk-*` token, declared `@theme
inline` so the utility carries the token and it resolves where it is used;
the prose blocks and the filament use the tokens by name too. The app types
no colour of its own, in either theme.

Ink and fill are named apart, as the kit names them: `primary`, `accent` and
`destructive` are the inks (text, borders, rings) and `primary-fill`,
`accent-fill`, `destructive-fill` are the fills (backgrounds, solid or with an
alpha), with `primary-foreground` the ink that sits on a fill. A consumer that
used `bg-primary` on its own elements should move to `bg-primary-fill`; the
ink name still exists and is now a dark amber on paper.

The four component files that used Tailwind's palette (`text-amber-100`,
`bg-amber-950/90`, the diff's red and emerald) use token utilities instead.
`tests/theme-neutral.test.ts` holds the package to this: no hex or rgb
literal in `theme.css`, no palette class in `src/`, and a hex in source only
in the files that draw on a canvas, each with a written reason.
