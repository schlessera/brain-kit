# Conditional questions in one card

Use `ask_user_form` when one answer determines the next question. The agent
supplies a flat `nodes` list; each conditional node references an earlier
single or multi choice. All five kinds (`single`, `multi`, `scale`, `rank`,
`text`) share one Submit, and scales and rankings use the same controls as
standalone list/rank questions. The existing ask tools remain available.

```json
{
  "prompt": "Plan the evening",
  "nodes": [
    { "id": "activity", "kind": "single", "header": "Evening", "prompt": "Which activity?", "options": [{ "label": "Tales" }, { "label": "Games" }] },
    { "id": "tales", "kind": "multi", "prompt": "Which tales?", "showIf": { "node": "activity", "anyOf": ["Tales"] }, "options": [{ "label": "Journeys" }, { "label": "Homecomings" }] },
    { "id": "games", "kind": "rank", "prompt": "Which game first?", "showIf": { "node": "activity", "anyOf": ["Games"] }, "items": [{ "id": "voyage", "label": "Voyage" }, { "id": "harbor", "label": "Harbor" }] }
  ]
}
```

Changing Tales to Games sets the selected tales aside. Undo or revisiting
Tales restores them until submission. The result contains only the visible
path, for example:

```json
{
  "answers": {
    "activity": { "value": "Games" },
    "games": { "order": ["harbor", "voyage"], "unchanged": false }
  },
  "visibleNodes": ["activity", "games"]
}
```

The host recomputes visibility and validates answers. An unanswered optional
node stays in `visibleNodes` and is absent from `answers`; a hidden node is
absent from both. Draft answers are local to the card and are not saved.
Input plus submitted result rebuilds its answered summary after reload.
See the [machine contract](integration-contract/mcp.md#ask_user_form-additive-in-0400)
for every field, limit and frame.

## Choosing limits

The defaults are depth 3, 12 nodes and 8 options per choice. Roots count as
level 1. Three levels keep the common branching path visible in full; deeper
paths use a full-path disclosure without reducing the controls' width. Eight
options match the scale's existing upper bound and leave the ninth digit for
Other. Twelve nodes allow a multi-section card without an unbounded default.
These are request caps, not a promise that every allowed form fits one screen.

The Chromium fixtures measured on 2026-10-01 at 320 CSS pixels wide: a
three-level six-option scale card is 1,716.4 pixels tall, and a twelve-node
text form is 1,754.6 pixels tall in both themes. They have no horizontal
overflow. The outer header and Submit remain visible while scrolling; the
React consumer's compiled stylesheet is checked in an isolated browser frame.
A depth-four fixture and a real host/socket test exercise raised limits.

Set `BRAIN_UI_ASK_USER_FORM_MAX_DEPTH`, `BRAIN_UI_ASK_USER_FORM_MAX_NODES` and
`BRAIN_UI_ASK_USER_FORM_MAX_OPTIONS`, or set `askUserFormLimits` on the
`ServerConfig` passed to `createApp`.
Invalid configured values refuse startup. Raising limits permits longer
forms; scale/rank keep their native 30/15-item caps and scale's eight-option
cap. No additional total-items setting exists.

## Always-loaded schema cost

Run `bun scripts/measure-form-schemas.ts` without credentials. It lists the
actual Claude MCP server's tools in memory and serializes their prefixed names,
descriptions and input schemas as Anthropic tool definitions. This measures
characters; token counts below are **estimates** using `ceil(characters / 4)`,
not provider `count_tokens` results or model measurements.

| Tool | Characters | Estimated tokens |
| --- | ---: | ---: |
| `show_block` | 16,710 | 4,178 |
| `get_current_location` | 1,091 | 273 |
| `ask_user` | 2,062 | 516 |
| `ask_user_list` | 2,362 | 591 |
| `ask_user_rank` | 1,479 | 370 |
| `ask_user_form` | 5,879 | 1,470 |
| `request_image_mask` | 1,111 | 278 |
| `query_activity` | 1,501 | 376 |
| All eight definitions together | 32,204 | 8,051 |
| All eight brief lines together | 2,468 | 617 |

The combined definition count includes array punctuation. All four ask tools
remain always loaded; the form adds cost and makes no schema-saving claim.
