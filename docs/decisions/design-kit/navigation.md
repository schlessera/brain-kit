# Design kit — Navigation

Part of the [design-kit decision record](../design-kit.md). Entries retain their
original dates and order within this subject; the index maps the complete chronology
and relationships with [other subjects](../design-kit.md#subjects).

<a id="2026-09-19--d37-five-destinations-everywhere-and-the-desktop-is-drawn"></a>

## 2026-09-19 — D37: five destinations everywhere, and the desktop is drawn

The fifth drop answered the eleven questions the maintainer forwarded
(`design-feedback.md`, "The fifth drop"; the pane spec is in
`design/desktop.md`). The decisions that bind the app:

1. **The destinations are Chat · Actions · Files · Graph · Settings**, ⌘1–⌘5,
   on the rail and the phone bar alike. Activity is the `done` lens of
   Actions (`needs you · running · done`), not a place; the Activity page
   becomes the Actions page with the filter, inbox pinned above the run log.
   Graph is a destination. The phone bar folds Settings into More, which is
   the kit `BottomSheet` holding Settings and the acts. New chat is the Chat
   header's primary action and a palette row, never a slot. This supersedes
   the S7 rail mapping (Chat · Activity · Files · Graph · Settings) and the
   phone bar's New chat slot.

   > **2026-10-06 — Superseded in part by [D52 §1](sessions-and-drafts.md#1-destinations-acts-and-the-palette-amends-d37-1).**
   > The destinations are now Chat · Sessions · Actions · Files · Settings
   > on the rail (⌘1–⌘5) and Chat · Sessions · Actions · Files · More on the
   > phone. Graph is reached through More and the palette's Jump to, with no
   > key. New chat is the Chat overlay disc below 1280, the Sessions pane's
   > `New conversation` at ≥ 1280, and a palette row; still never a slot.
   > Activity as the `done` lens of Actions and More as a `BottomSheet`
   > still bind.
2. **A four-pane screen needs 1440.** 1280 gets rail + list + detail. The
   ladder's 480/900/1280 defaults stand; above 480 the rail may be collapsed
   by the user and it sticks.
3. **The palette groups by what ⏎ does** (Jump to · Ask · Run), spending is
   an effect (a gold cost chip), and an unservable command is disabled with
   its reason rather than omitted. The query is a real input.
4. **The composer is kit-owned.** The app's `ComposerView` retires; the app
   keeps only the attach sheet, the provider list and the handlers.
5. **No snooze on a blocking approval**; "Always allow" has no key.
6. **Focus after the last decision in a list goes to the `EmptyState` heading
   that replaces the section, with the `InlineToast` receipt above it**; the
   composer in a transcript. The page heading is a fallback only where no
   empty state can exist.
7. **Location:** the kit `MapView` owns the span rule, the accuracy ring,
   the note and the 420px cap; the app passes the payload through.
8. **One closing row per answer:** chips while live, `FeedbackRow` later.

Not followed: ⌘N for New chat (the browser owns it; no key is printed), and
undo on the inbox receipt until the activity API can un-acknowledge.

<a id="2026-09-19--d38-the-sixth-drops-rulings"></a>

## 2026-09-19 — D38: the sixth drop's rulings

The design answered the twelve questions the fifth drop left open
(`design-feedback.md`, "The sixth drop"). The decisions that bind the kit and
the app:

1. **A question is an exchange.** `AskUserCard` has three states — pending,
   answered, typed — and all three stay in the transcript at full contrast.
   A composer send while a question is pending IS the answer: the app binds
   it to the question and does not send it as a message. Nothing rolls up.
2. **A mask is a receipt.** Source thumb, the region in teal, a `Receipt`
   of the facts, stacked; a dismissed mask is stated as a fact in red mono,
   never silently "whole image".
3. **The Files rail never collapses**; blocks are absent without data.
   Stale is built from `mtime` and a threshold; Untrusted is drawn disabled
   with its reason until provenance exists. Both are features.
4. **No receipt without undo.** Dismissal is silent until un-acknowledge
   exists. Approval decisions keep their receipt: the effect is out of
   sight, which is the ruling's own test.
5. **New chat has no key**; unknown cost says `spends`, no chip when a
   command cannot spend.
6. **The graph caption names the active rule, and entity is a fourth mode.**
7. **`← →` fold on tree rows, bound and printed together.**
8. **The closing row flips on the next user message.**
9. **Map cards are bounded (≤420 wide, 110–260 tall) and the fetch
   envelope is 1.5× wide by 1.0× tall.**
10. **Truncation is allowed only on rows that OPEN the record**, carried as
    `title`; a row that IS the record wraps.
11. **The neutral fill and the alpha derivation rule are the design's.**
12. **Three more screens after the acceptance four:** Actions triage, File
    viewer, First run.

