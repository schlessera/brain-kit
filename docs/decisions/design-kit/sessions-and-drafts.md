# Design kit — Sessions and drafts

Part of the [design-kit decision record](../design-kit.md). Entries retain their
original dates and order within this subject; the index maps the complete chronology
and relationships with [other subjects](../design-kit.md#subjects).

<a id="2026-10-06--d52-sessions-is-a-destination-work-left-running-is-tracked-until-seen-and-every-session-keeps-its-own-draft-943"></a>

## 2026-10-06 — D52: Sessions is a destination, work left running is tracked until seen, and every session keeps its own draft (#943)

**Sources.** The maintainer's [navigation design](https://github.com/schlessera/brain-kit/issues/929#issuecomment-5973564827)
and the later [parallel-session design](https://github.com/schlessera/brain-kit/issues/929#issuecomment-5973572791),
which takes precedence where the two disagree on placement. Then the
maintainer's rulings on [#929](https://github.com/schlessera/brain-kit/issues/929)
and [#943](https://github.com/schlessera/brain-kit/issues/943): authoritative
host recovery (**Recovery A**, 2026-10-04), a separate draft per session
(2026-10-04), host-backed draft storage across devices (**storage C**,
2026-10-04), the [shared row above the composer](https://github.com/schlessera/brain-kit/issues/929#issuecomment-5992839917)
and its [≥1280 answer](https://github.com/schlessera/brain-kit/issues/929#issuecomment-5992922056)
(2026-10-05), and the [maintainer's approval](https://github.com/schlessera/brain-kit/issues/943#issuecomment-5998985495)
of the [six-part #943 design](https://github.com/schlessera/brain-kit/issues/943#issuecomment-5980283574)
(2026-10-04) with its four residual answers, R1–R4 (2026-10-05). Where
those later rulings do not replace it, the supplied navigation and
parallel-session designs still bind; §8 lists what carries over. The measured input is
[`docs/plans/navigation-recovery.md`](../../plans/navigation-recovery.md)
(#942). The row's adopted geometry is the
[shared-row design](https://github.com/schlessera/brain-kit/issues/929#issuecomment-5998113323),
which amends the #943 strip.

**What this amends.** D37 §1's destinations and New chat placement; D22's
≥1280 list pane and the space between transcript and composer; and the
drawing of #93's New chat disc. It replaces the supplied tracker rules
(`{sessionId, leftAt, seenTurnId}` in a global `brain-trackers` key, and
`lastActiveAt > leftAt → done`) and the supplied draft-discard
confirmation, which never shipped. Permission gates, cost honesty
(D38 §5), data-only rendering, root isolation and the module seams are
unchanged. This record implements nothing: the native children of #929
build it, and #964 and #979 add the host contracts in §6.

<a id="1-destinations-acts-and-the-palette-amends-d37-1"></a>

### 1. Destinations, acts and the palette (amends D37 §1)

- **Destinations.** Rail: Chat, Sessions, Actions, Files, Settings, on
  ⌘1–⌘5. Phone bar: Chat, Sessions, Actions, Files, More. Graph is no longer
  a destination: it is reached through phone More and the palette's Jump to,
  with no key. Graph's contents are unchanged.
- **The key remap is explicit.** Today the keys are ⌘1 Chat, ⌘2 Actions,
  ⌘3 Files, ⌘4 Graph, ⌘5 Settings ([`const jumpTo`](https://github.com/schlessera/brain-kit/blob/18d5ddee154b5dbebb3dbd6c487bc8ea1fc036db/packages/ui-react/src/components/layout/desktop-palette.tsx#L84-L89)).
  After: ⌘1 Chat, ⌘2 **Sessions**, ⌘3 **Actions**, ⌘4 **Files**, ⌘5 Settings.
  Graph loses ⌘4 and gets no key.

  > **2026-10-06 — Implementation context (the key remap above).** "Today"
  > is the code before #946, at the pinned link. #946 made the remap: the
  > destinations and their keys are now `const destinations` in
  > `packages/ui-react/src/components/layout/desktop-routes.ts`, shared by
  > the rail and the palette. The ruling still binds.
- **Rail acts** sit under the destinations: Search, Add a note and Daily
  briefing (printing `spends`) when expanded; Search and Add when collapsed,
  where the briefing is reached through All commands. The act section holds
  at most four rows.
- **All commands** is a clickable button that replaces the rail's passive
  ⌘K cap, named `All commands` with `aria-keyshortcuts="Meta+K"`. It is the
  non-keyboard route to every command without a row of its own (Graph, Sync,
  Stats), so there is no keyboard-only exception.
- **Phone.** Occupied Chat gets a Search disc beside New chat. The welcome
  chips are the briefing (with `spends`), Search and Add; Add replaces the
  welcome statistics chip. More holds Settings, Graph, Add, the briefing,
  Sync and Stats, each printing its effect and its actual unavailable reason.
- **Palette.** Every unique command and its grouping by what ⏎ does stays
  (D37 §3). Sessions appears once, under Jump to: the former act row and the
  new destination row merge. Graph moves to Jump to.
- **New chat** stays off every bar and rail slot. Below 1280 it is the Chat
  overlay disc (#93's drawing, now through `DiscButton`, §7) and a palette
  row. At ≥1280 it is the Sessions pane's `New conversation`, the pane's one
  primary action, and a palette row; there is no New chat disc and no rail
  row. It still has no key (D38 §5).

**Usage classes are preference, not measurement.** The maintainer's
classes: New chat and Sessions are session-level (S); Search is S,
provisionally; Add and the briefing are daily (D); Files, Graph, Sync and
Stats are occasional (O). Actions and Settings have no class. No usage
statistics were generated, and none should be cited as if they had been.

**The row cap is placement, not classification.** When a fifth act
qualifies for the rail, the least frequent act's *row* moves to the palette
and More. Its class stays what it was, and the placement table marks it
`D · rail full`. Today there are three acts, so nothing moves.

<a id="2-the-activation-contract"></a>

### 2. The activation contract

The supplied width and view exceptions are adopted as the contract, in place
of the original epic's promise of every daily act in one activation from
anywhere. On the phone, Add and the briefing take two activations from
occupied Chat; on the collapsed rail the briefing takes two; phone Search is
one activation from Chat and may be two from elsewhere, via Chat. **No
control is added to restore the superseded promise.**

Counts are pointer or touch activations; typing a slash query does not
count. `0` means already there. Opening Search or Add opens a form and
writes nothing; opening Sync or the briefing starts that job (Sync writes,
the briefing spends).

**Phone, 320 and 390.**

| Target | Empty Chat | Occupied Chat | Sessions | Actions | Graph | Files / Settings open |
| --- | --- | --- | --- | --- | --- | --- |
| Chat | 0 | 0 | 1 | 1 | 1 | 1 (panel closes) |
| Sessions | 1 | 1 | 0 | 1 | 1 | 1 |
| Actions | 1 | 1 | 1 | 0 | 1 | 1 |
| Files | 1 | 1 | 1 | 1 | 1 | 0 / 1 |
| Settings | 2 · More | 2 | 2 | 2 | 2 | 2 / 0 |
| Graph | 2 · More | 2 | 2 | 2 | 0 | 2 |
| New chat | 0 · already new | 1 · disc | 1 · New conversation | 2 · Sessions → New conversation | 2 | 2 |
| Search | 1 · chip | 1 · disc | 2 · Chat → disc or chip | 2 | 2 | 2 · Chat → disc |
| Add a note | 1 · chip | 2 · More | 2 | 2 | 2 | 2 |
| Daily briefing | 1 · chip, `spends` | 2 · More | 2 | 2 | 2 | 2 |
| Sync · Stats | 2 · More | 2 | 2 | 2 | 2 | 2 |
| Open a session | 2 · Sessions → row | 2 | 1 | 2 | 2 | 2 |
| Open a tracker | 1 · pill | 1 · pill | 1 · Working row | 2 · Chat → pill | 2 | 2 |

**Collapsed rail, 480–899.**

| Target | Empty Chat | Occupied Chat | Other view | Panel open |
| --- | --- | --- | --- | --- |
| Any destination | 1 (0 if current) | 1 | 1 | 1 |
| Graph | 2 · All commands → Graph | 2 | 2 | 2 |
| New chat | 0 | 1 · disc | 2 · Chat → disc (1 from Sessions) | 2 |
| Search · Add | 1 · rail | 1 | 1 | 1 |
| Daily briefing | 1 · chip | 2 · All commands → row | 2 | 2 |
| Sync · Stats | 2 · All commands | 2 | 2 | 2 |

**Expanded rail, 900–1279.** As 480–899, except the briefing is one
activation from anywhere: a rail row printing `spends` at rest.

**1280 and 1440.** Chat carries the rail, the Sessions pane and the
transcript. There is no disc and no tracker pill row.

| Target | Chat (empty or occupied) | Actions / Files / Settings | Panel open |
| --- | --- | --- | --- |
| Rail Sessions | 1 · focus moves into the pane at the selected row; Chat stays the amber destination | 1 · Chat opens with the pane focused | 1 |
| New chat | 1 · pane `New conversation`; in empty Chat it is `aria-disabled` with the reason `already a new chat` | 2 · Sessions → New conversation, or All commands → New chat | 2 |
| Open a session or tracker | 1 · pane row | 2 | 1 |
| Search · Add · briefing | 1 | 1 | 1 |
| Graph · Sync · Stats | 2 · All commands | 2 | 2 |

**Rules.**

- **N1 · A panel is not a place.** Activating any destination or act
  replaces an open panel, with no separate close step.
- **N2 · Closing returns focus.** Esc, back, or `Close files` /
  `Close settings` (#965's names) returns focus to the control that opened
  the panel. Chat's scroll position and selection are unchanged.
- **N3 · Pressing the current destination** scrolls it to its start and
  moves focus: in Sessions to the first Working row, otherwise to the
  selected row. It never clears a selection, a draft or a tracker.

  > **2026-10-06 — Amended for Chat ([N3 addendum](#d52-addendum--what-n3-means-for-each-destination-maintainer-2026-10-06)).**
  > Chat's start is its latest turn, and on a phone focus stays on the Chat
  > tab unless a card is waiting. The addendum also says what "start" and
  > "the selected row" are for every destination and width.
- **N4 · The adopted exceptions stand** (above).
- **N5 · No New chat rail row at ≥1280:** an act takes no destination slot,
  and the pane has its one primary action.

**Reasons are printed at rest, never only on hover.** A disabled rail
briefing prints `spends` with a second line, `needs the host` or
`a turn is running`. More keeps `sync` printed when disabled. Welcome chips
gain `disabled` and `why` (§7).

**Accessible names.**

| Control | Name |
| --- | --- |
| Rail acts | `Search the brain` · `Add a note` · `Daily briefing, spends` (disabled: `…, unavailable: {why}`) |
| Palette button | `All commands`, with `aria-keyshortcuts="Meta+K"` |
| Discs | `Search the brain` · `New chat` · `Scroll to latest` |
| Tracker pill | `{label}, {state}{, second line}. Open session.` |
| Tracker summary pill | `{n} more working sessions: {counts}. Open list.` |
| Keyboard-open tracker summary | `{n} working sessions: {counts}. Open list.` |
| Pending pill | `Pending follow-up {n} of {total}: {label}. Not yet received by the agent.`, with the full text as its description |
| Pending summary | `{n} pending follow-ups. Open list.` |

<a id="3-the-shared-row-above-the-composer-amends-d22"></a>

### 3. The shared row above the composer (amends D22)

Below 1280 the row between the transcript and the composer carries two pill
systems: **working sessions in the left half** (this record's trackers, §4)
and **pending follow-ups for the open session in the right half** (#1002:
messages sent while the session is busy that the agent has not yet
received). At ≥1280 trackers live in the Sessions pane, above its date
groups, and the row carries **only the right half**; the left half is
empty. Pending follow-ups are not D50's model-offered suggestion chips,
which stay under the answer.

**Geometry.**

- The row is a **sibling** between the message area and the composer, never
  an overlay. It is a two-column grid with an 8px gutter over the composer's
  own width and measure (720px at most); each half is
  `(composer − 8px) / 2`.
- **Each half is a hard box.** Content never crosses the gutter. An empty
  half paints nothing but keeps its column, so a lone pending pill stays
  right and a lone tracker stays left. The halves are bottom-aligned, and
  the row is as tall as the taller half.
- **The row is absent**, with no spacer, when both halves are empty.
- **Height.** One or two pills per half, 44px each and 6px apart: at most
  94px. With three or more, the left half shows the most urgent tracker and
  a summary pill; the right half shows the oldest pending follow-up and a
  summary pill.
- **Pills are 44px, paint and target the same box**, so no paint/target
  exception is needed. Both systems use the same kit pill. A half narrower
  than 240px (at 320 and 390) draws two lines in 44px: the label at 12/600
  in ink, then the state word in mono 10/600 in the state's ink
  (8 + 15 + 13 + 8 = 44px). At 240px or wider it draws one line, with the
  state word right-aligned. The state word never truncates; only the label
  does.
- **A pending pill** prints `pending` in neutral ink, with a `◷` icon, on
  the `neutral` chip ramp: it is waiting, not a problem, so it is neither
  amber nor red, and the word carries the meaning. Tracker pills keep §4's
  words and tones.
- **Labels** are a few words from #1004's small model, falling back to the
  session title or the start of the prompt.
- **The scroll disc** stays inside the message area at `bottom: 16px`, so it
  is at least 16px above the row at every width and never shares its
  centre.

**Keyboard open** (composer focused, soft keyboard up): each populated half
collapses to **one 44px summary**, side by side: `● 3 working`, adding
`· 1 needs you` when the width allows, and `◷ 2 pending` (a single one still
reads `1 pending`). A 32px summary was proposed and is rejected; the summary
is a full 44px row. The budget at 320 × 568 with the keyboard up (visual
viewport about 308px) is: filament 2px, transcript at least 150px, row 44px,
composer 56–112px. **R4:** once the composer passes three lines, the row
hides first, so the transcript keeps at least 150px. Trackers stay reachable
through Sessions, and pending follow-ups through their summary once the
composer shrinks. The tab bar stays under the keyboard, as today.

**Summaries and sheets.** The left summary reads
`+2 more · 1 needs you · 1 done` on one line, or `+2 more` over
`1 needs you` on two, and opens the `Working` BottomSheet. The right summary
reads `+3 pending` and opens a `Pending follow-ups` BottomSheet listing every
queued message in full, in send order, numbered `1 of 4`, read-only.

**A pending follow-up's full text** is a popover above the pill, at most
280px wide and never wider than its half on a phone, with the full prompt
text selectable, `ink` on `raised`. With a pointer it opens on hover or
focus and disappears on leave or blur; on touch a tap opens it, and another
tap, a tap outside or Esc closes it. The text is also always the pill's
`aria-describedby`. It is the row's one hover, and it reveals content, never
state, effect or cost, so D22's hover rule holds. Nothing in it sends,
cancels or navigates.

When the agent takes a follow-up, its pill leaves and the full user message
appears in the transcript at that point in the conversation, in the same
frame and with no animation; a reload shows it once, never twice. If the
half had a summary, the next-oldest pending pill takes the freed place and
the summary's count drops, or the summary goes. A dropped follow-up
(cancelled, revoked or refused) leaves with its reason.

**Focus.**

- Two groups, two tab stops: `role="group"` named `Working sessions` and
  `Pending follow-ups`. Inside each, ←→ / ↑↓ / Home / End rove, and arrows
  never cross the gutter. Tab order is transcript → working sessions →
  pending follow-ups → composer.
- Activating a tracker opens its session (focus per §4). ⏎ or space on a
  pending pill toggles its popover; Esc closes it.
- A summary pill opens its sheet with focus on the first row, and closing
  the sheet returns focus to the summary. A keyboard-open summary blurs the
  composer (the keyboard drops) and opens the sheet; closing it returns
  focus to the composer with the caret restored.
- Each group announces through its own polite live region, so the two never
  interrupt each other. Pending: `Follow-up queued`,
  `Follow-up sent to the agent`, `Follow-up dropped: {reason}`. Trackers
  announce once, politely, when one changes to `needs you`, `failed` or
  `done` (`Tax folder cleanup needs you.`); changes into running or queued
  are not announced.

**Motion.** Nothing in the row or the pane animates, in either mode, and
popovers appear without a transition. D22's one ambient animation stays the
filament.

<a id="4-trackers-under-recovery-a"></a>

### 4. Trackers under Recovery A

A tracker is created when a session leaves the foreground with a live run,
a queue entry, a pending interaction or an unconfirmed send, and when work
starts in a session that is not being watched. Leaving an idle session with
nothing pending creates none. It stays until
the session's latest turn is **seen**, as defined below. Selecting a session
acknowledges nothing.

**The stored record holds identifiers only**, under the root's own prefix:
`${storagePrefix}:trackers:v1`, through the root's `storageKey`
(`const prefix = options.storagePrefix`, `packages/ui-react/src/root.ts:180-186`).
There is no global key.

```ts
type TrackerRecord = {
  sessionId: string;
  requestId: string | null; // latest accepted request known when left
  turnId: string | null;    // null while queued
  revision: number | null;  // host accepted-work revision, if known
  leftAt: number;           // client clock; ordering only
  seen: {
    turnId: string;
    revision: number;
    basis: "proof" | "acknowledged"; // R1
  } | null;
};
```

No transcript, title, pending payload or credential is stored; titles come
from the session list at render time. A principal change or a revocation
event deletes the whole set. Draft content never enters this record (§5).

**States, in display order.**

| # | State | Proof | Ink | Pill word | Second line |
| --- | --- | --- | --- | --- | --- |
| 1 | needs you | `pending[]` has an entry for this session | red | `needs you` | `approval` / `question` |
| 2 | failed | terminal, failure outcome | red | `failed` · `interrupted` · `timed out` | `ended 09:41` |
| 3 | unconfirmed | local send with no acceptance proof | amber | `unconfirmed` | `didn't hear back` |
| 4 | running | `latest.state` is `running` | amber | `running · 2m`, from `startedAt` | — |
| 5 | queued | `latest.state` is `queued` | amber, or red with a queue note | `queued` / `queued · busy` | the host's queue note, verbatim |
| 6 | unknown | the host answered, but proof or linkage is missing, or a rollback was detected | ink-mute, dashed ring | `unknown` | `host can't confirm the latest turn` |
| 7 | can't check | the read failed, is unsupported, or the session is missing | ink-mute | `can't check` | `host unreachable` / `host too old` / `session not found` |
| 8 | done | terminal success; a pruned detail with a valid rollup counts | teal | `done · 4m`, from `endedAt` | `finished 09:41` |
| 9 | cancelled | terminal cancelled or denied | ink-mute | `cancelled` / `denied` | `ended 09:02` |

- Order by `#`, then by newest `revision`. `unknown` and `can't check` sort
  above `done` because they may be hiding work.
- Revocation removes `needs you` without naming what was pending, and is
  never shown as a terminal outcome.
- Times come only from the host's `startedAt` / `endedAt`; when those are
  null, no time is printed.
- **`lastActiveAt` and `lastTouched` are never read.** A newer
  `lastActiveAt` can mean that a new turn started
  (`export interface ChatSession`, `packages/ui-sdk/src/protocol.ts:1455-1485`),
  and `lastTouched` is LRU bookkeeping for buffer eviction.

**Merging snapshots and live frames.**

1. Keep the highest `revision` per session; ignore anything lower.
2. A snapshot whose revision is below one already seen from the host is a
   rollback: the tracker becomes `unknown`, never the older state.
3. At equal revision, a given `requestId` only moves forward: queued →
   running → terminal. A terminal state never reverts.
4. A newer accepted request replaces `latest`. A known old success never
   masks newer queued, running or unknown work.
5. Each snapshot replaces `pending[]` whole. It may belong to an earlier
   turn while `latest` is queued.
6. Live frames that arrive during a fetch are buffered and applied after it,
   under rules 1–4.

**Seen.** One observer, keyed on `{sessionId, turnId, revision}`, clears a
tracker only when all of these hold for one committed frame: the session is
active; Chat is in the foreground with no panel or other view over it;
`document.visibilityState` is `visible`; history has a message whose
host-proven `turnId` equals `latest.turnId`; and that message's last line is
in the viewport at the bottom, by the same `< 20px` test the transcript uses
(`const handleScroll`, `packages/ui-react/src/components/chat/chat-page.tsx:267-271`),
with the scroll disc not drawn. An older key never clears a newer tracker.
Selecting the session, being scrolled up, a hidden tab, a background buffer
and the bottom of a replay without the linked turn do not count.

**R1 · An unlinked latest turn.** When history carries no host-proven
`turnId`, nothing can prove the turn was seen. The boundary row then offers
`Mark as seen`. Activating it clears the tracker and stores
`basis: "acknowledged"`: the user's acknowledgement, never proof. Only the
observer above writes `basis: "proof"`.

**Focus on opening a tracked session:** a pending interaction → its card's
first control; a failure → the error card's primary action; otherwise, on a
desktop → the composer with the caret at the end; otherwise, on a phone →
nowhere, so the soft keyboard does not open.

**Retention.** Evicting a transcript buffer (at most eight are held) never
removes a tracker; opening the session reads it again. States 1–7 are
uncapped, because live work bounds them. `done` and `cancelled` are capped
at 24, and the overflow leaves the pill row but keeps an `unseen` word on
its Sessions row. Nothing disappears silently.

**Approval recovery.** When a valid pending approval's `turnId` has no
assistant message (the replay ends on the user's message), the transcript
draws a **turn shell**: the `BRAIN` label at the turn's `startedAt` and the
card, with no invented text. **R3:** a `restored` chip marks a restored
*approval* card only. Its controls stay live only while the envelope's
`pending[]` lists the request; otherwise it is read-only, with one of
`answered on another device`, `ended with the turn` or
`no longer yours to answer`. Rehydration never sends a reply. The four ask
kinds keep #910's rules and state footer, with no second indicator.

> **2026-10-06 — Implemented by #948 (client state; the strip and pane are
> #950).** The model is `packages/ui-react/src/lib/trackers.ts`, the root's
> store is `stores/tracker-state.ts`, the socket and chat wiring is
> `lib/tracker-client.ts` and the observer is `hooks/use-tracker-seen.ts`.
> Four readings of the text above:
>
> - *Leaving the foreground* is selecting another session, New chat, the
>   page's `pagehide`, or the document turning hidden. Switching to Actions
>   or Graph does not leave the session in view, since the seen rule already
>   requires Chat in the foreground.
> - *Work in a session that is not being watched* is a live frame for a
>   session other than the one in view that starts or continues work: a
>   queued status, a turn's `session_info` or progress, an approval or a
>   question. A late `result`, a replay, or a resume's `session_info` that
>   names no turn and no request does not start a tracker.
> - Before any read or frame has answered for a restored tracker it reads
>   `can't check · host unreachable` (or `host too old` without the
>   capability), and its view says it is not yet settled, so #950 can hold
>   announcements until it is.
> - `Mark as seen` with no latest turn identity to store deletes the record,
>   since there is nothing to acknowledge against.

> **2026-10-06 — R3's read-only card and the shell's time, implemented by
> #1072.** The rules are `packages/ui-react/src/lib/restored-approvals.ts`,
> applied by the #948 tracker client, whose recovery read now also covers a
> session that holds a restored card. Only a read that began after the card
> was restored can close it by absence. Readings of the text above:
>
> - `answered on another device`: a `tool_result` arrived while the card was
>   still waiting on this page, or the envelope no longer lists it while the
>   turn that raised it is still `latest`'s running turn. During its turn the
>   host drops a pending approval only on a decision; the turn's end drains
>   the rest.
> - `ended with the turn`: a terminal frame for that turn, an envelope whose
>   latest turn is that turn and is terminal or `unknown`, or is a different
>   turn, or `session not found`.
> - `no longer yours to answer`: a 401/403 read for any session, or a
>   revocation. Every restored card in every buffer takes it and drops its
>   request and turn identities.
> - Absent from `pending[]` with a newer request only queued, or with an
>   unknown latest that names no turn, or in an envelope rejected as a
>   rollback or a contradiction: no fact says why. The controls go and no
>   word is printed until a frame or the next read says which. A closed
>   card's request is settled in the tracker evidence too, and a late
>   duplicate of its request does not reopen it.
> - The shell's header time is `latest.startedAt` when `latest.turnId` is the
>   shell's turn. Otherwise, and without the capability, no time is printed.

> **2026-10-06 — Implemented by #950 (the strip, the pane and the
> announcements).** The pills are `components/chat/composer-row.tsx`; the
> Working group is `SessionList`'s, drawn by the drawer below 1280 and by
> `components/chat/sessions-pane.tsx` from 1280; the root's session list,
> which names every tracker, is `stores/session-list-state.ts`; and which
> changes are announced is `lib/tracker-announcer.ts`. Five readings of the
> text above and of §3:
>
> - Working lists the trackers the pills show. A `done` or `cancelled` past
>   the cap of 24 leaves both, and stays on its date row with `unseen`.
> - `Mark as seen` is offered at the end of the transcript of the session in
>   view when its tracker has settled, nothing is in flight, the state is
>   `done`, `failed`, `cancelled`, `unknown` or `can't check`, and no
>   message carries the latest turn's id. Those are the cases no observation
>   can clear.
> - The words for the other two announced states follow `needs you`'s:
>   `{label} failed.` (`was interrupted.`, `timed out.`) and
>   `{label} is done.` A tracker's first settled view is what was already
>   the case, not a change: one restored on load, taken in from another tab,
>   or made by leaving the session in view announces nothing then. Work that
>   starts in a session nobody is watching announces its first settled view.
>   Changes that arrive together are each announced.
> - Opening a tracker moves focus once the session's replayed history is
>   complete (a chunk has come and none has followed it for 150ms) and, for
>   `needs you`, its card is drawn: 5 seconds at most, then with what is
>   drawn. Going elsewhere first, or opening anything over Chat (a panel,
>   the palette, a subagent view, the mask editor, the handoff sheet),
>   cancels it.
> - From 1280 a Sessions drawer opened by any route, or open when the window
>   widens past 1280, closes and moves focus into the pane, at the selected
>   row.

<a id="5-per-session-drafts-stored-on-the-host-storage-c"></a>

### 5. Per-session drafts, stored on the host (storage C)

**Identity.** Every composer belongs to
`{draftId, sessionId | null, revision}`, where `draftId` is a client UUID.
There is no shared null-session bucket. Client draft state is root-owned
and separated by host, root and session identity. A saved draft's text and
attachment bytes survive reload, tab close and a normal host restart, and
restore on any of the same operator's authorized devices at that host. Navigation restores by `draftId`:
selecting a session, switching destinations, opening panels and remounting
the composer. Actions and Graph unmount the composer today, which is the
loss #942 measured; view unmount and buffer eviction never touch the draft
store. Composer keystrokes stay isolated from transcript rendering, and
reading a session or its history never submits its draft. A D50 chip still
fills the composer below the reader's text, which is now that session's
draft.

**New chat**, from every entry point (the overlay disc, Sessions
`New conversation`, the palette row and the ≥1280 pane button), saves the
current draft and opens a fresh identity with an empty composer. There is
no discard confirmation, because nothing is lost. A fresh identity is not
stored until it has content, so repeated empty New chats leave nothing
behind. Host session acceptance binds only the matching original draft.

**Draft entries in Sessions.**

| Row | Title | Trailing | Subtitle | Accessible name |
| --- | --- | --- | --- | --- |
| Unbound, with text | first line of the text | `draft` | save state | `Draft: {title}, {state}. Open draft.` |
| Unbound, images only | `Draft with 2 images` | `draft` | save state | same |
| Bound | session title | `draft · 2h` | unchanged | `{title}, has a draft. Open session.` |

Opening an unbound draft opens an empty Chat with that draft restored.
Nothing is sent and no host session is created.

**Save state**, printed under the composer while a draft exists.

| State | Copy | Rule |
| --- | --- | --- |
| saving | `draft · saving…` | a PUT is in flight; shown after 600ms |
| saved | `draft · saved` | only after the host acknowledges this exact revision, attachments included |
| unsaved | `draft · not saved yet` | dirty and offline, or a transient refusal; retried with backoff |
| conflict | `draft changed on another device · Compare` | see below |
| unavailable | `draft · this host doesn't keep drafts · kept on this device` | capability absent |
| too large | `draft · too large to save (8 MB max) · kept on this device` | 413 |
| full | `draft · 100 drafts saved · delete one to save this` | 507 |

Content is always kept locally and is never dropped to fit a limit. Nothing
claims host durability for an unacknowledged save.

**Conflict.** `Compare drafts` shows this device's and the other device's
version with their edit times, and offers `Keep this device's`,
`Keep other's` and `Keep both`. Keep both turns the other version into an
unbound Draft entry. There is no automatic or model merge, and a host
refresh never overwrites dirty visible content: it raises the conflict
instead.

**Delete, attachments and consumption.** Emptying the composer (all text and
every attachment) deletes the draft at its current revision and leaves a
host tombstone. There is no confirmation, because only the user's own action
removed the content. Removing one attachment chip removes only that
attachment, in the next revision. An accepted send consumes exactly the
submitted revision; edits made after submitting become the next revision
and stay.

**Sends are separate from the editable draft.** A send is an immutable
snapshot. Late `session_info`, results or receipts for A settle only A's
request and its submitted attachments: they never select A after
navigation, adopt B's draft, clear newer edits or consume another draft's
images. A send without acceptance proof stays in place as a review block
with three controls. `Check again` reads the recovery envelope: accepted
becomes a normal turn, not accepted keeps the block, and can't check
changes nothing. `Send again` sends with a new Idempotency-Key. `Edit` puts
the text and images back into the draft. Nothing is resent automatically,
and leaving the session gives it an `unconfirmed` tracker.

**Authority.** Saving, restoring, listing, deleting, binding and consuming a
draft are authenticated data operations. None grants permission to send,
reply or start a model turn, and none answers a question; #910's
question-answer rules are independent.

> **2026-10-06 — Implemented by #951.** The root's draft store is
> `packages/ui-react/src/stores/draft-state.ts`, the host sync and the send
> settlement are `lib/draft-client.ts` over `lib/draft-api.ts`, the words
> are `lib/drafts.ts`, the line under the composer and `Compare drafts` are
> `components/chat/draft-save-line.tsx`, and the review block is
> `components/chat/unconfirmed-sends.tsx`. Readings of the text above:
>
> - *Kept on this device* means kept by this page's root, in memory. A
>   draft survives a reload only through the host; device storage across a
>   reload is #1014's, keyed by this store's draft identity. So a service
>   worker update waits while any draft holds words the host has not
>   acknowledged, or any send is unsettled.
> - The field empties when a message is sent: the send is the snapshot, and
>   the host keeps the revision it names until it accepts the message. The
>   message names a revision only when the host acknowledged exactly what
>   is sent. A refused message's text and images go back into its draft,
>   ahead of anything typed since; Edit does the same for a held one.
> - A `410` for a draft this page's own accepted send consumed keeps the
>   newer content in that session, under a new id; any other `410` makes it
>   a new unbound draft, as above. A second host draft for a session that
>   already keeps one here is a conflict on it (`Keep other's` takes the
>   other draft, `Keep both` makes it a Draft entry), never a switch.
> - While a save is out for under 600ms, or a dirty draft has not been sent
>   yet, the line prints nothing; a Draft entry then reads `not saved yet`.
>   `too large` prints the bound the host named (`8 MB`, `64 KB`, `4
>   images`), and `full` its count or bytes.
> - A new conversation whose first message is still unanswered when the
>   reader leaves it keeps its transcript aside; its `session_info` makes it
>   that session's buffer without selecting it, and its draft that
>   session's draft.
> - The review block's reason reads `The connection dropped before the host
>   confirmed it got this.`, or, for a refusal that named no request, `The
>   host refused a message without saying which, so it may not have got
>   this.` The envelope names only the latest request, so `Check again`
>   finds a held send accepted only when it is that request; a different
>   latest proves neither, and it prints `Can't check · the host's latest is
>   another message`. Other reasons follow §6's rows; a first message has no
>   session to read, so its reason is `no session yet`. Send again sends the same snapshot under a new request
>   id, naming the revision only while the host still holds it.
> - Track files are uploads staged for a message, not draft content: they
>   stay with their session (or new chat) on this page, in the field until
>   the host accepts the message that carries them, and are not saved to
>   the host.
> - A new chat's unconfirmed first message has no session to be found in,
>   so its review block is held in the new-chat view whichever new chat is
>   open; Send again and Edit first open that message's own new chat, as New
>   chat does. Until it is resolved, that new chat sends nothing else, since
>   a second first message would start a second conversation beside it.
> - In empty Chat the pane's `New conversation` stays `aria-disabled` (§2);
>   a nonempty new-chat draft reaches a fresh one through the palette row.

> **2026-10-08 — Track-only drafts, implemented by #1112.** The design
> approved on #1112: a new chat whose staged-track queue holds a track is a
> Draft entry even with no text or images, `Draft with 1 track file`
> (`Draft with 2 images, 1 track file` beside images), with the state line
> `draft · tracks in this tab only`, or `draft · {save word} · tracks in
> this tab only` in a mixed draft. `1 track failed` comes before `uploading
> 1 track`, which comes before the lifetime words; tracks are never called
> saved. Opening it shows that new chat's queue again and sends nothing;
> removing its last track, with no text or images left, takes it out of
> Drafts and focuses the field. While the new chat holds a staged track,
> the pane's `New conversation` is not `aria-disabled`. The words are
> `trackStateWord` and `draftEntries` in `lib/drafts.ts`; the queues are
> watched as one by `subscribeAllTracks` in `lib/draft-tracks.ts`, which
> the service-worker update also waits on: any root-owned queue holding a
> track, in any view, is unsaved work.

> **2026-10-07 — Leaving the page with staged tracks, implemented by
> #1150.** While any root-owned queue holds a track, in any view and any
> upload state, the root's track registry registers a `beforeunload`
> handler, so a manual reload, closing the tab or navigating away asks the
> browser's own leave confirmation. The browser draws its own words; there
> is no custom text and no in-app sheet. The handler moves with the same
> change notice that drives `subscribeAllTracks`, is removed when the last
> track is sent or removed (or the root is disposed), and is updated before
> any watcher hears the change, so the update takeover's reload after the
> last track goes never asks. It belongs to the root rather than a mounted
> component, so it holds while the login gate replaces the app; a scripted
> reload that would lose tracks, such as the one after signing in, asks as
> well. Browsers may skip the prompt on a page the user never interacted
> with; Chromium under test automation asks regardless. The guard is
> `guardLeaving` in `lib/draft-tracks.ts`.

> **2026-10-07 — Drafts kept on this device across a reload, implemented by
> #1014.** Every draft in the root's store, with its images, and the work
> context around it (the voice review text, the uploaded tracks of the view
> by reference, the selection, the focused element and the first transcript
> message in view with its offset) are written to IndexedDB a moment after
> each change, in the signed-in account's partition. The partition is named
> by the host's `accountKey` on `/api/vpn-check`, which every sign-in as the
> same owner shares (the
> [contract](../../integration-contract/http.md#account-partition-key-additive-1014)
> has the table per auth mode); the client opens it only while it holds that
> key, and never writes one account's work into another's. After an
> authenticated boot as the same account the drafts come back first, before
> the host's list is read, so a host version meets them as it would meet
> the page that wrote them; then the selection and focus, then the
> transcript's place. *Kept on this device* now holds across a reload. A
> write the browser refuses (quota, private mode, no storage) puts `Couldn't
> save your draft on this device.` in the composer's hint and takes the words
> `kept on this device` off the save line until a write succeeds; editing
> goes on in memory. The store asks once for persistent storage and promises
> nothing from the answer. Staged tracks keep #1112's lifetime: their
> references are in the snapshot, and a reload does not bring the queue back.
> This is not encryption and not protection against someone with access to
> the device. The modules are `lib/local-partitions.ts` (the partition
> primitive) and `lib/local-work.ts` (the snapshot, and `snapshotNow`, which
> resolves only once its transaction has committed).

**Device-local conflicts — maintainer ruling, 2026-10-07 (#1208).**
Two tabs of the same account/root share device storage. Their expected
per-record revision is checked inside the native IndexedDB write transaction.
A divergent stale write keeps the already-committed draft under its original
draft/session identity and atomically stores the incoming text and image bytes
as a new unbound Draft entry. The stale writer keeps its visible text,
selection and navigation, and subsequent edits follow its branch. A local
view association can show that branch while the original session remains
selected; it never binds the branch to that session. Each tab keeps its own
reload context, while draft records remain shared and account-partitioned.

Only after transaction commit does the stale writer show
`Another tab changed this draft · Both versions kept`, with `Open other version`.
Both versions remain reachable through the draft/session surfaces after a
reload, including a fresh third tab. A failed write leaves editable content
in memory and uses the existing storage-failure copy; it makes no retention
claim. Stale emptying, deletion and send consumption cannot erase another
tab's committed version. Empty revision tombstones fence stale resurrection;
immutable send snapshots remain separate from editable draft identities.
Pending sends retain their branch target even when the reader opens the
original, and Edit follows that target. A live tab claims its context identity
with a browser lock so a duplicated tab with copied session storage receives
a distinct identity while an ordinary reload resumes its own context.
Recording acceptance commits its retained branch and receipt before deleting
its audio. Host conflicts still use the explicit Compare policy above.

Rejected: last writer wins loses committed work; refusing the stale write
alone leaves its incoming version undurable; keeping the incoming version
under the original identity silently changes the original session's owner;
automatic/model merging is unauthorized. Repeated branches for one divergence
are avoided by retargeting the stale writer after the first committed fork.

<a id="6-host-contracts-the-implementations-add"></a>

### 6. Host contracts the implementations add

These are the technical outputs Recovery A and storage C asked #943 to fix.
They are **not shipped**. Each lands with its SDK schema, the HTTP
reference, a same-commit `docs/integration-contract.md` update, a
`CONTRACT:` commit and minor changesets: recovery in #964, drafts in #979.

**Recovery (#964).** Clients use it only when `server_hello.capabilities`
advertises `sessionRecovery: true`. Without it, restored trackers read
`can't check · host too old` until live frames prove otherwise.
`GET /api/sessions/:id/recovery` returns:

```ts
{
  sessionId: string;
  backendId: string | null;
  revision: number; // persisted, host-owned accepted-work ordering
  latest: {
    requestId: string | null;
    turnId: string | null; // null until a queued request is dispatched
    state: "queued" | "running" | "terminal" | "unknown";
    outcome: ActivitySpanOutcome | null; // the existing Activity vocabulary
    startedAt: number | null;
    endedAt: number | null;
  };
  pending: Array<{
    kind: "approval" | "ask_user" | "ask_user_list" | "ask_user_rank" | "ask_user_form";
    requestId: string;
    turnId: string;
  }>;
}
```

History messages gain an optional `turnId`, present only when the host can
prove it and never inferred from timestamps or content. `revision` orders
acceptance, not backend mtime, message count or identifier comparison.
`pending` lists live, authorized original identities; it is neither a
transcript nor a grant, and its payloads rehydrate through the existing
scoped interaction frames. Authorization is rechecked after every
asynchronous step.

The host correlates request, turn, session and backend identities from its
actual acceptance, coordinator, catalog and Activity records; uncorrelated
imported history gets no fabricated identity. `startedAt` / `endedAt` are
real host run times. Losing process-local execution or pending maps does
not resurrect them, and a retained acceptance receipt proves acceptance, not
continued execution or the completion of an external effect. A recovery
read never selects a session, starts work, replies or grants anything.

| Response | Client state |
| --- | --- |
| 200 envelope | §4's rules |
| 401 / 403 (the existing auth envelope, with no identities) | `can't check`; `needs you` is dropped |
| 404 `SESSION_NOT_FOUND` | `can't check · session not found` |
| 404 route (capability set, route missing) | `can't check · host too old` |
| 5xx or network failure | `can't check · host unreachable`; retried on reconnect |

An internal failure is never a 200 `unknown`: `unknown` means the read
succeeded and proof is absent.

**Drafts (#979).** The capability carries the **R2** limits:

```ts
server_hello.capabilities.sessionDrafts = {
  maxTextBytes: 65536,      // 64 KB of text
  maxDraftBytes: 8388608,   // 8 MB per draft, attachments included
  maxDrafts: 100,
  maxTotalBytes: 268435456, // 256 MB per host
};
```

```text
GET    /api/drafts                       → { drafts: DraftSummary[] }
         DraftSummary: draftId, sessionId|null, revision, updatedAt, preview, attachmentCount
GET    /api/drafts/:draftId              → Draft: text, attachments[{attachmentId, mime, bytes, name}]
PUT    /api/drafts/:draftId              If-Match: <revision|0>, Idempotency-Key
       { sessionId: string|null, text, attachmentIds[] } → { revision, updatedAt }
POST   /api/drafts/:draftId/attachments  Idempotency-Key, bytes → { attachmentId }
DELETE /api/drafts/:draftId              If-Match: <revision> → 204, writes a tombstone
POST   /api/drafts/:draftId/bind         { sessionId, requestId } → { revision }
```

`chat_message` gains an optional `draftRef: { draftId, revision }`. When the
host accepts the message, it deletes the draft only if that revision is
still current. Errors use the existing envelope: 409 `DRAFT_CONFLICT` with
`{ current }`; 410 `DRAFT_DELETED` with `{ tombstoneRevision }`, after which
the local content becomes a new unbound draft; and 413 `DRAFT_TOO_LARGE` and
507 `DRAFT_CAPACITY`, each with `{ limit }`. Tombstones stop stale autosaves
and late receipts from resurrecting a removed revision. The existing image
bounds still apply to each attachment, alongside these aggregate limits.
The namespace is the existing single-owner host model, not partitioned by
temporary device-login principal: every call resolves and attributes the
current principal and honours revocation, with no new role and no
cross-root access. Drafts and their attachment bytes live in the
operational store, inside the generic backup set, and never in `brain.db`,
canonical Markdown or the tracker record.

> **2026-10-06 — Implemented by #979, with one placement change.** The
> limits object above travels as `server_hello.sessionDraftLimits`, beside
> `capabilities.sessionDrafts: true`, not inside `capabilities`: every
> shipped client validates `capabilities` as a string-to-boolean record and
> would drop the whole hello over an object value, which an additive change
> may not cause. The routes also answer 404 `DRAFT_NOT_FOUND`, 400
> `DRAFT_INVALID`, 428 `DRAFT_PRECONDITION_REQUIRED`, 409 `DRAFT_KEY_REUSED`
> (one key, a different request) and 409 `DRAFT_NOT_ACCEPTED` (a bind without
> an accepted first message), and 413/507 bodies name their `bound`. The
> [integration contract](../../integration-contract/wire.md#session-drafts-additive-979)
> is the reference.

<a id="7-what-the-kit-gains"></a>

### 7. What the kit gains

Read from the source, not inferred from the drawings:

- `SideRail` has no act or palette props, and its ⌘K cap is a passive
  element. Rail acts and a clickable All commands are **new** kit props
  (#944).
- `ListRow`'s `card` row is about 43px tall and there is no `density` prop;
  the 44px pill is a **new** `density="pill"` (#949).
- A `SuggestionChips` chip is about 31px, with no `disabled`, `why` or
  `cost`. Those props are **new**, and chips get a 44px minimum under a
  coarse pointer (#945).
- The scroll-to-bottom disc is a bare 32px button with only a `title`
  (`{showScrollButton && (`, `packages/ui-react/src/components/chat/chat-page.tsx:733-741`).
  It has no 44px box and no accessible name, so it joins `DiscButton`.
- **`DiscButton`** is a 32px paint in a 44px box, with `tone: ink | mute`
  and an optional label that expands leftward. It draws exactly three
  discs: the phone Search disc, New chat below 1280
  (`{hasMessages && !wide && (`, `packages/ui-react/src/components/chat/chat-page.tsx:650-657`)
  and scroll-to-latest. It is not used for rail rows, pills or chips. Both
  overlay boxes share one vertical range, so #628's resting spacer (`pt-10`
  below an 888px container, not the 880px in the drawings) still clears
  them, and #779's geometry work is untouched.
- **The shared row** is one kit container owned by #949: the grid, the half
  boxes, the width-based pill layout and the keyboard-open summaries. #950
  wires the left half; #1002 fills the right half and adds the
  `Pending follow-ups` sheet and the popover. One kit story covers the
  combined row at 320, 390 and 900 with both halves populated, one half
  empty, and the keyboard up.

<a id="8-what-carries-over-from-the-supplied-designs"></a>

### 8. What carries over from the supplied designs

The supplied [navigation design](https://github.com/schlessera/brain-kit/issues/929#issuecomment-5973564827)
and [parallel-session design](https://github.com/schlessera/brain-kit/issues/929#issuecomment-5973572791)
hold the full drawings and still bind where §§1–7 do not replace them.
Their binding rules:

**Placement of future acts.** Each act has a frequency class (S, D, O) and
an effect (none, writes, spends).

- **V1** S acts get a persistent visible control at every width, one
  activation from Chat.
- **V2** D acts get a persistent visible control wherever it can show the
  act's name and effect at rest. Where it cannot, they move one step down
  for that width: All commands on the rail, More on a phone.
- **V3** O acts get no persistent control: a palette row on desktop and
  tablet, a More row on a phone. Palette-only is allowed only because the
  palette has a visible button.
- **V4** Acts never take a destination slot or join the destination
  tablist (D37 §1: a tab is a place).
- **V5** is replaced by §1's placement-only cap.
- **V6** A control that cannot show the effect at rest is not drawn for that
  act, and the effect never moves to a hover (D22).
- **V7** Within a section, order by class, then effect-free first, then
  alphabetically.

The §2 exceptions stand over V1 and V2 as adopted. A place keeps its slot by
being a place: Files keeps slot 4 although it is O, and a future place used
more often than Files would take the slot and move Files to More.

**The rail.**

- Act rows use the destination row's geometry: at least 36px tall (44px
  under a coarse pointer), a 17px icon and a 12.5px label, in `inkMute`,
  never amber, because an act is never "here". Activating an act does not
  move the amber destination, except that it lands in Chat as the
  palette's `inChat` does.
- A disabled rail briefing keeps its chip; its reason is a second line in
  9.5px mono.
- Collapsed, effect-free acts are icons with accessible names and **no
  tooltip**, like the collapsed destinations.
- In a short viewport the rail's middle, from the destinations through the
  acts, scrolls; the wordmark and All commands stay pinned.
- Palette rows do not print where their visible control lives.

**Phone discs.** The Search disc sits left of New chat with its icon in
`inkMute`; New chat keeps ink at rest as the primary. Both sit in one
right-anchored row, so a label expanding leftward pushes Search and they
never overlap. The Search disc is drawn only below `tablet:` and only while
the chat has messages; the empty state has its chips instead. The New chat
disc is drawn in occupied Chat at every width below 1280 (§1).

**Keyboard and focus.**

- The desktop rail is three tab stops: the destinations (a tablist, ↑↓ /
  Home / End, manual activation); the acts (`role="toolbar"`,
  `aria-orientation="vertical"`, `aria-label="Acts"`, roving with ↑↓ /
  Home / End, ⏎ and space activate, and arrows never cross into the
  destinations); and All commands. Then list → detail → composer (D22).
- On the phone, the overlay's Search then New chat come first in DOM order,
  then the transcript, the composer and the bar. More moves focus to its
  first row on open and back to its slot on close.
- No new keys. All commands prints `⌘K` everywhere, the one rail key not
  gated on a fine pointer (D36 addendum); the destination chords keep
  their pointer-gated printing.
- Search and Add move focus to the panel they open. The briefing and Sync
  leave focus on the composer, and the result arrives in the transcript.

**The Sessions pane (≥1280).** In Chat the list pane is Sessions, 280px
wide. Working pins the trackers in §4's order, each a two-line `ListRow`
with the title and then the state word. The existing date groups follow,
unchanged; the single `Session running…` row goes, because Working replaces
it, and a tracked session does not appear again in its date group. The pane
is two tab stops: `New conversation`, then one roving list (↑↓ / Home /
End) across Working and the date groups. The order is rail → pane →
transcript → composer.

**Actions** is not made the cross-session working queue here; that touches
#684's internals and is a separate design. Its badge still counts pending
approvals across all buffers.

**Drawing, 320, occupied Chat with trackers and pending follow-ups.**

```text
┌──────────────────────────────────────┐
│ BRAIN ───────────────────── 09:41    │
│ The receipts for March are in …      │
│                ┌──┐                  │
│                │↓ │                  │  scroll disc, ≥16px above the row
│                └──┘                  │
│ ┌────────────────┐ ┌────────────────┐│
│ │! Tax folder cl…│ │◷ Also the Apri…││  44
│ │  needs you     │ │  pending       ││
│ └────────────────┘ └────────────────┘│
│ ┌────────────────┐ ┌────────────────┐│
│ │+2 more         │ │+2 pending    ▸ ││  44  (row = 94)
│ │  1 done        │ │                ││
│ └────────────────┘ └────────────────┘│
│ [+] Ask anything…            [◖] [↑] │
├──────┬──────┬──────┬──────┬──────────┤
│◆Chat │◷Sessn│✓Actns│▦Files│ ⋯More    │
└──────┴──────┴──────┴──────┴──────────┘
```

**Drawing, 320 × 568, keyboard up.**

```text
│ …the receipts for March are in      │
│                ┌──┐                 │
│                │↓ │                 │
│                └──┘                 │
│ ┌───────────────┐ ┌───────────────┐ │
│ │● 3 working  ▸ │ │◷ 2 pending  ▸ │ │  44, two separate buttons
│ └───────────────┘ └───────────────┘ │
│ [+] Can you also check the Ap| [◖][↑]│
│ ┌ keyboard ─────────────────────────┐│
```

**Drawing, 900, expanded rail, Files open.**

```text
┌──────────────────────┬───────────────────────────────────────────────┐
│ ▌◆ Chat          ⌘1  │ ┌ Files ───────────────────────[Close files] ┐│
│  ◷ Sessions      ⌘2  │ │ life/ …                                    ││
│  ✓ Actions   (2) ⌘3  │ └────────────────────────────────────────────┘│
│  ▦ Files         ⌘4  │  rail Actions → 1 activation, Files closes    │
│  ⚙ Settings      ⌘5  │  Esc → focus back to rail Files               │
│ ──────────────────── │                                               │
│  ⌕ Search            │                                               │
│  + Add a note        │                                               │
│  ☀ Daily briefing spends                                             │
│ ──────────────────── │  ◐ Trip packing list   running · 2m           │
│ [⌘K] All commands    │  [+] Ask anything…                [◖] [↑]     │
└──────────────────────┴───────────────────────────────────────────────┘
```

**Drawing, 1440, Chat with the Sessions pane.**

```text
┌──────────────────────┬────────────────────────────┬──────────────────────────────────────┐
│ ▌◆ Chat          ⌘1  │ [✎ New conversation]       │  YOU ──────────────────── 09:41      │
│  ◷ Sessions      ⌘2  │ WORKING                    │   Which receipts are still missing?  │
│  ✓ Actions   (2) ⌘3  │ ! Tax folder cleanup       │  BRAIN ────────────────── 09:41      │
│  ▦ Files         ⌘4  │   needs you                │  The receipts for March are in …     │
│  ⚙ Settings      ⌘5  │ ◐ Trip packing list        │                                      │
│ ──────────────────── │   running · 2m             │      (left half empty) ┌──────────┐  │
│  ⌕ Search            │ TODAY                      │                        │◷ Check A…│  │
│  + Add a note        │ ▌Receipts for March     ●  │                        │  pending │  │
│  ☀ Daily briefing spends Weekly review    2h ago   │                        └──────────┘  │
│ ──────────────────── │ YESTERDAY                  │  [+] Ask anything…        [◖] [↑]    │
│ [⌘K] All commands    │  …                         │                                      │
└──────────────────────┴────────────────────────────┴──────────────────────────────────────┘
       208                       280                       remainder (720 measure)
```

The remaining widths and states (empty Chat after New chat, Actions at 480,
the Working sheet, Drafts, conflict and the unconfirmed send) are drawn in
the six #943 design comments linked above.

<a id="rejected"></a>

### Rejected

- **Restoring one activation from anywhere** for every daily act by adding
  controls. The maintainer adopted the supplied exceptions instead (§2).
- **A 32px keyboard-open summary**, or a 32px paint in a 44px target. A full
  44px row needs neither measured separation nor an exception.
- **`lastActiveAt > leftAt → done`.** A newer timestamp also accompanies a
  new running turn, as #942 measured.
- **Recovery from the existing contract only.** It cannot tell done from a
  new turn, or recover a pending approval after reload. Declined for
  Recovery A.
- **No control for an unlinked turn** (R1's alternative), which would leave
  the tracker in place until a linked turn arrives.
- **A draft-discard confirmation, and a streaming-only New chat
  confirmation.** Per-session drafts lose nothing, so there is nothing to
  confirm.
- **Device-local draft storage, and drafts kept only while the application
  runs.** Declined for storage C.
- **A `restored` chip on the four ask kinds** (R3): #910's footer already
  states their state.

<a id="verification-the-implementations-owe"></a>

### Verification the implementations owe

Keyless Chromium on the public Odysseus fixtures, in both themes, with real
clicks and taps and no forced clicks:

1. Every cell of §2's matrix at 320, 390, 480, 900, 1280 and 1440, recording
   the resulting view, panel and `document.activeElement`. With Files open
   at 390, Actions is one tap, and Esc from Files focuses the Files tab.
   Pressing Sessions again keeps the selection, the draft and the tracker
   count.
2. The shared row at 320, 390, 480, 900 and 1279, with 0–5 trackers and 0–5
   pending follow-ups, keyboard up and down: the halves never intersect,
   the gutter is at least 8px, each half stays in its column, the scroll
   disc is at least 16px above the row, the row is at most 94px (44px with
   the keyboard up), every pill is a 44px target and the state word fits.
   At 320 × 568 with four composer lines, the row is hidden and the
   transcript is at least 150px. At 1280 and 1440 the row shows pending
   follow-ups only. `getAnimations()` is empty for the row and the pane.
3. One recovery fixture per state and per error row, each showing its exact
   word. A rollback snapshot shows `unknown`; a newer queued request over an
   old success shows `queued`. A stale `{T1, r3}` observer does not clear a
   tracker at `{T2, r4}`, and neither does a hidden document or a scrolled-up
   transcript.
4. A cold reload with a pending approval and history ending on the user's
   message draws the turn shell with `restored`. After revocation the card
   is read-only and no reply frame is sent.
5. Text and an image in A → New chat → type → select A: A's text and image
   return, the new draft is listed under Drafts, and a repeated empty New
   chat adds nothing. Visiting Actions and returning restores the draft.
   `draft · saved` appears only after a 200 for that revision. A 409 shows
   both versions, and Keep both creates an unbound entry. With the socket
   closed after a send, the review block appears, and no second
   `chat_message` is sent without `Send again`.
6. Three pending follow-ups render the oldest plus `+2 pending`, and the
   sheet lists all three in send order, in full. The full text is reachable
   by hover, by tap, by focus plus ⏎ and through `aria-describedby`, and
   none of these sends, cancels or navigates. Handing a follow-up over
   removes its pill and adds exactly one user message in the same render,
   with no duplicate after a reload. Tab reaches working sessions, then
   pending follow-ups, then the composer, and arrows never cross the
   gutter.
7. Every new control has an accessible name and a 44×44 target under a
   coarse pointer, in both themes, with coarse, fine and mixed pointers,
   short viewports and reduced motion covered.

A restored mutation of each guard must fail on the assertion named for it.

<a id="d52-addendum--what-n3-means-for-each-destination-maintainer-2026-10-06"></a>

### D52 addendum — what N3 means for each destination (maintainer, 2026-10-06)

**Sources.** The [design brief](https://github.com/schlessera/brain-kit/issues/1078#issuecomment-6015609270)
on #1078, with two maintainer rulings made during that design pass:
**Chat's start is its latest turn**, and **on a phone, focus stays on the
Chat tab** unless an approval, a question or an error card is waiting, so the
soft keyboard does not open (as §4's tracker rule sends phone focus nowhere).

**N3 as amended.** Pressing the current destination scrolls it to its start
and moves focus: in Sessions to the first Working row, otherwise to the
selected row, or to the destination's heading when nothing is selected. In
Chat, the start is the latest turn: the press does what `Scroll to latest`
does. Focus goes to a waiting card's first control, then a failed turn's
primary action, then the composer; on a phone, focus stays on the Chat tab.
Every scroll is instant. At ≥1280 Sessions is a pane, not the current
destination, and keeps the 1280 row. It never clears a selection, a draft, a
tracker, an open detail or an open file.

**One algorithm.** *Reset*: every scroll container the destination owns goes
to its start, the top except Chat's transcript, and nothing closes. *Resolve*:
the first target in the table below that is drawn. *Reveal*:
`focus({ preventScroll: true })`, then `scrollIntoView({ block: "nearest" })`,
so a target already at the start moves nothing. A press by chord asks for a
visible ring (`focusVisible`), because Chromium does not count a modifier
chord as keyboard input for `:focus-visible`; a tap shows none.

| Destination | Width | Reset | Focus, first match |
| --- | --- | --- | --- |
| Chat, occupied | phone | transcript → latest turn, same window | waiting approval or question → its first control · the latest turn's failure → its primary action · else stays on the Chat tab |
| | 480 up | same | same, then the composer, caret at the end |
| Chat, empty | phone | welcome → top | a waiting card · else stays on the tab |
| | 480 up | welcome → top | the composer, caret at the end · the welcome heading if it cannot take focus |
| Sessions | every width until #950 | drawer body and list → top | the reattachable running session (the Working row until #950's group exists) · the session in view (`aria-current`) · the first row · the "Sessions" heading |
| Actions, list | below 900 | list → top | the "Actions" heading |
| Actions, detail open | below 900 | detail → top; it stays open | the detail's heading · the "Actions" heading |
| Actions | 900 up | list, detail and evidence rail → top | the selected row (run rows carry `aria-current`) · the "Actions" heading |
| Files | below 900 | viewer and tree box → top; a sandboxed HTML preview, whose scroll the panel cannot reach, loads its source again | the open file's tree row, when the tree is shown · the reading pane's title · the "Files" heading |
| | 900 up | reading pane (an HTML preview as below 900), tree and evidence rail → top | the open file's tree row · the "Files" heading |
| Settings | every width | drawer body, or the pane's section scroller → top | the selected section tab |

A chord still reaches a destination behind an open modal, such as the
one-time credential dialog, but the press never moves focus out of the
modal. Headings are script-only stops (`tabIndex=-1`) that Tab never reaches; they
draw the kit's 2px ink ring at −2 on `:focus-visible`. The press changes no
view, panel, Settings section, session, run selection, file, tree visibility
or draft, so the Settings leave guard has nothing to ask. A Chat press can
bring the latest turn into view and let §4's seen observer clear that
session's tracker: proof the turn was seen, not a clear performed by the
press. D36 is unchanged: no key is added, and focusing a list row or a card
makes its own keys live as a Tab to it would.

**Where it lives.** The store records a press of the destination already
shown, with no DOM (`pressDestination`,
`packages/ui-react/src/stores/ui-state.ts:248-259`). The mounted destination
answers it (`useDestinationPress`,
`packages/ui-react/src/hooks/use-destination-press.ts:18-33`) with the shared
reveal (`focusFirst`, `packages/ui-react/src/lib/destination-start.ts:46-58`).
The cells are `packages/ui-react/tests/browser/destination-press.pointer.tsx`,
run in the kit's `rail-fine`, `rail-coarse` and `rail-mixed` projects.

> **2026-10-06 — #950's Working group exists.** Below 1280 the Sessions row
> of the table now starts at the first Working row, then the session in
> view, the first row and the heading; the single reattachable row is gone.
> From 1280 the press keeps the 1280 row: Chat stays the destination and
> focus moves into the pane at the selected row.
