---
"@schlessera/brain-ui-kit": minor
---

The design's seventh drop, on the four components it ruled on.

- `DiffBlock` gains `tinted`. Monochrome stays the default; tinted is for the one case where the diff is itself the decision. Removed rows sit on a red ground and added rows on teal, at the tint rule on the fill hue (`--bk-diff-tint-red` / `--bk-diff-tint-teal`, light halves derived), and the sign column is a mark: the tone's ink at weight 600, never an alpha. Rows are a fixed 8px sign column beside a wrapping text column, so a long line wraps with a hanging indent and a continuation can never be misread as an unsigned line. Nothing truncates and nothing scrolls sideways.
- `ChoiceOption` gains `multiple`: the role goes radio to checkbox and the mark goes round to square, because the shape is the affordance. The arrow-key walk is scoped to a `role="group"` as well as a `radiogroup`, and the D20 gate holds (no handler, no role, no tab stop).
- `AskUserCard` gains `multi` (checkbox options inside a `group` labelled by the question; an answered head reads "Answered · N chosen"), `answers` (every choice as its own row, meta on the first, default "you chose N · …"), and a fourth state, `dismissed`: gold border and head ("Unanswered — the turn ended"), no options, a lapsed row on a gold ground stating the fact (`lapsedNote` overrides it) with an "Ask again" button bound to `onAskAgain` — no handler, no button. New tokens `ask-border-gold`, `ask-lapsed-tint`, `ask-lapsed-border`. Nothing fades in any state.
- `ApprovalCard` no longer splits its buttons evenly. The design ruled that an even split claims the two answers are equally likely, which the card has no business claiming: Allow takes the remaining width, Deny is content-sized with a 96 x 44 floor, the head aligns to the top, and the target wraps instead of ellipsising — the card is the record. The port's earlier defence of the 50/50 split is recorded in the component's comment as overruled. The `Default` visual baseline moves with it.

Stories cover each of these (a tinted diff that wraps, a checkbox group and its keyboard walk, the multi and dismissed cards with and without the handler, the button floor and the wrapping target), and catalog §13 in `Question and mask` now stacks the four states, single and multi, beside the tinted diff.
