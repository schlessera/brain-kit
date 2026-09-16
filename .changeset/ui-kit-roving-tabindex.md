---
"@schlessera/brain-ui-kit": minor
---

ui-kit: one tab stop per group, not one per item.

`FilterRow`, `TabBar`, `SideRail` and `ChoiceOption` each rendered
`tabIndex={0}` on every item, so the arrow keys the design's role-and-keys table
specifies were redundant with Tab rather than being the way you move. A screen
carrying both nav components cost **ten tab presses before any content**; it
costs two.

The stop resolves last-focused → selected → **first eligible**, and the third
clause is the finding rather than a fallback: a group with nothing selected
whose items are all `tabIndex={-1}` is not harder to reach but unreachable, and
an `AskUserCard` whose question nobody has answered yet is exactly that case.

`ChoiceOption` needed a different answer, because it is one option inside its
caller's `radiogroup` and cannot see its siblings. It takes a new `tabStop` prop
(and `onFocus`) which `AskUserCard` computes; omitting it leaves the option a
tab stop, which is the only safe default for a component that cannot see its own
group.

Also fixes a real bug: `FilterRow`'s arrow handler fired `items[n]` with an
index into the DOM walk, which only visits items carrying a role — so a row
mixing interactive and decorative pills filtered by the wrong one.
