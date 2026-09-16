---
"@schlessera/brain-ui-kit": minor
---

ui-kit: the four assembled screens, and four component fixes they surfaced.

The catalog's §11 screens — morning digest, chat answer, weekly review, run
detail — rebuilt from the kit alone. The component set held: no screen needed a
new component, and nothing in a screen declares anything but layout.

What assembly surfaced were defects in components that each passed their own
stories, because a component's own stories put it in a container built for it
and a screen does not:

- **`ScreenBody` was crushing its children.** A flex column's children default
  to `flex-shrink: 1`, so an over-full screen squeezed every child instead of
  scrolling — and it failed as somebody else's bug: a `FilterRow` compressing to
  14px and clipping the descenders off its own labels, an `ActionCard`
  swallowing the last line of its body, a `margin-top: auto` spacer silently
  ceasing to space. `.bk-screen-body > * { flex-shrink: 0 }`.
- **A scrolling `ScreenBody` is now a tab stop.** `overflow: auto` makes it a
  scrollable region, and this kit gates every other tab stop on a handler — so a
  read-only screen had no focusable content and stranded everything below the
  fold.
- **A centred `Button` painted its content outside its own box** when it was
  narrower than its label plus its effect chip; `flex: none` was overriding the
  `minWidth: 0` already there.
- **`ActionCard`'s children get their own band.** `body` and `foot` both set a
  margin and `children` had none, so a caller's button row sat flush against the
  last line of the body.
