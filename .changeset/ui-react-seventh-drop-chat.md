---
"@schlessera/brain-ui-react": minor
---

The chat surfaces follow the design's seventh drop.

- Multi-select `ask_user` questions render on the kit `AskUserCard` with `multi`: checkbox options in a labelled group, "Other" toggling like any row and opening the free-text field while it is on, previews following focus as before. The app's own checkbox rows are gone. An answered multi-select lists every pick and counts them in the head; a typed "Other" answer joins the other picks instead of replacing them.
- A dismissed question is the kit's gold `dismissed` state rather than a pending head with a note, and it offers "Ask again". The server resolved the request when the turn ended, so asking again reopens the card locally; a submit from a reopened card goes out as an ordinary composer message that quotes the question and the chosen answer(s), and its Dismiss closes it again without sending anything.
- The `request_image_mask` receipt states an absent region instead of omitting the row: `region · region not recorded`, in gold. When the result reports mask bytes, the mask file is drawn over the hatched thumb from the files API, with the teal region fill showing through its transparent pixels; when it reports none, the thumb shows the source alone under a mono "mask not rendered" line.
- The Edit tool's diff renders through the kit `DiffBlock` in its tinted mode. The app's word-level highlight inside a changed line pair had no equivalent in the design — the sign column and the row grounds are its whole vocabulary — so it was dropped, and `lib/diff.ts` is a line diff plus `diffText`, the signed text the kit reads.
- The Actions page's approval card applies the same button rule as the kit card: Allow takes the remaining width, Deny is content-sized with a 96 x 44 floor. Its title already wraps.
