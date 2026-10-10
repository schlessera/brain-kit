# Design kit — overlays

Part of the [design-kit decision record](../design-kit.md). Entries retain their
original dates and order within this subject; the index maps the complete chronology
and relationships with [other subjects](../design-kit.md#subjects).

<a id="2026-10-09--d54-one-overlay-primitive-1378"></a>

## 2026-10-09 — D54: one overlay primitive (#1378)

The design ruling on #1378 adopts native `showModal()` dialogs for modal
overlays and a non-modal destination panel that keeps navigation operable.
`Overlay` owns opening order, dismissal requests, focus entry/wrap/return,
inertness and entry-only motion. Closing is instant. Entry animations share
one `no-preference` guard; reduced-motion overrides share the existing
`reduce` block. Scrims use existing
`palette-shadow` (dim), half that shadow mixed with transparent (veil), and
`color-canvas` (opaque); none uses blur.

| Variant | Shape | Modal | Scrim | Used for |
|---|---|---|---|---|
| `sheet` | Docked to the bottom at every width. Full width below 480. From 480, `min(560px, 100vw − 32px)` wide and centred horizontally. | yes (top layer) | `dim` | Short pick-lists and live tools that belong at the thumb: More, Attach (phone), Graph options, Dictation (phone and tablet). |
| `dialog` | **Below 900 it has the sheet's shape.** From 900 it is a centred card, `radius-panel` (18px), at most `85dvh` tall, with the body scrolling. `placement="top"` puts the card 110px from the top and never docks it to the bottom (palette). | yes (top layer) | `dim` | A single decision or a single reading: handoff, the one-time credential (`alertdialog`), the command palette (`placement="top"`). |
| `fullscreen` | Covers the viewport at every width, `--bk-color-canvas` opaque. The children draw the toolbar. | yes (top layer) | `opaque` | Tools that need the whole screen: the zoom viewer, the mask editor, the subagent drill-in. |
| `panel` | Right-anchored. Full width below 768. From 768 (`md`), `size` sets the width: 320, 480 or 560. Full height, with a left `edge` hairline and the shadow. | `modal` prop. `true` (default) for act panels, which use the top layer and cover the bar and rail. `false` for destination panels: z-index `panel`, inert only over the content area, bar and rail stay live. | `veil` | The slide-over panels: Sessions, Settings and Files (destination, `modal={false}`); Search, Add, Sync and Whatsup (act, modal). |


The document layer scale is fenced separately from the colour-token pipeline;
`LAYERS` exports its numbers and `z` exports its CSS references. Kit and app
Tailwind themes map these names to `z-raised` through `z-modal`.

```css
/* @layers:start */
:root {
  --bk-z-raised: 10;   /* sticky headers/footers, floating in-canvas controls */
  --bk-z-popover: 20;  /* anchored non-modal popovers and menus */
  --bk-z-nav: 30;      /* phone tab bar; the rail if it is ever positioned */
  --bk-z-panel: 40;    /* non-modal destination panels + their content scrim; ≥900 panes */
  --bk-z-banner: 50;   /* the connection banner */
  --bk-z-modal: 60;    /* fixed modal layers not yet in the top layer (kit SheetDialog, ModelPicker phone) */
}
/* @layers:end */
```

| Case | Winner | Mechanism |
|---|---|---|
| More (sheet) opened over the Files or Sessions drawer (destination panel) | More | Top layer > `z-panel`. The nav no longer needs to raise itself. |
| One-time credential appears while the Settings drawer or pane is open | Credential | Top layer > `z-panel`. Settings stays open underneath, and Done returns focus into it. |
| Credential appears while another modal is open (e.g. a sheet) | Credential | Opened last, so it is on top of the top layer. The sheet is inert underneath. |
| ⌘K while a modal is open | Nothing opens | The palette's ⌘K handler toggles only when no other modal is open (`openModal()` in `lib/destination-start.ts`, which already matches `[aria-modal="true"], dialog:modal`). Otherwise a palette could stack over a `closedBy="none"` credential. |
| Handoff from the ModelPicker's locked action (phone) | Handoff | The picker closes first in the composer. If it ever stays open, the top layer still wins over its `z-modal`. |
| Zoom viewer opened from inside the subagent drill-in | Zoom viewer | Opened last in the top layer. Escape closes only the viewer. |
| Palette over the Settings or Files pane (≥900) | Palette | Top layer > `z-panel`. |
| Connection banner vs a destination panel | Banner | `z-banner` 50 > `z-panel` 40. |
| Connection banner vs any modal | Modal | The top layer is above the banner, and the banner is inert and dimmed under the scrim. Its live region is not announced while a modal is open. That is accepted: a modal is the current task, and the banner shows again when the modal closes. |
| Phone tab bar vs destination panel | No overlap | The panel stops above the bar (`bottom: calc(60px + env(safe-area-inset-bottom))`). |
| Phone tab bar vs act panel (Search, Sync…) | Act panel | Modal panel in the top layer covers the bar, as today ("an act's panel keeps covering them"). |
| Anchored popover vs a panel | Panel | `z-panel` 40 > `z-popover` 20. A popover inside a panel lives in the panel's own stacking context. |
| Toasts | n/a | There are no fixed toasts. `InlineToast` is in flow. |


The breakpoint is 900px for dialog-to-sheet geometry; `placement="top"`
stays at 110px at every width. Sheets stay docked at every width, with a
48px minimum scrim strip and a default 70dvh cap. Panels size at 768px;
destination panels stop above the 60px phone bar or beside the 60/208px rail.

The native modal uses no z-index. ZoomViewer keeps a body portal to avoid
markdown inline nesting and prose image styles. Escape bubbles through inner
controls, then only the topmost overlay requests dismissal. `cancel` is
prevented when cancelable; an unexpected native close reopens and restores
initial focus before requesting dismissal (unless `closedBy="none"`).
A panel keeps its header X under every `closedBy` value; `none` suppresses
Escape, native close requests and scrim taps only. Sheets and dialogs remove
their drawn close control under `none`. The adapter may capture the surface
with `surfaceRef` for destination resets.
Focus returns according to the closing render, in a microtask after the React
commit has restored focus and after
inertness is released and before `onAfterClose`. Destination inert marks
are ref-counted, follow inserted siblings, exempt active modals and their
ancestors, and preserve page-owned inert. Hidden modal subtrees close immediately and report
a developer error in development builds.

`BottomSheet` optionally draws a 44px close control; existing stories omit it.
`CommandPalette` is a named group, using its own root ref for row traversal,
inside the owning dialog. Its pixels do not change. Only the 24 new overlay
baselines are approved; no existing baseline changes.

<a id="d54-addendum--bounded-swipe-dismissal-for-sheets-1420-maintainer-2026-10-10"></a>

### D54 addendum — bounded swipe dismissal for sheets (#1420, maintainer, 2026-10-10)

The grabber D54 drew as decoration becomes a bounded drag handle. Rulings:

1. **Bounded swipe dismissal** applies to the eligible topmost sheet-shaped
   overlay: a `sheet` at any width, or a `dialog` rendered as a sheet below
   900px. Only `closedBy="any"` dismisses. That leaves the credential
   (`closedBy="none"`), a busy handoff and draining dictation protected, as
   D54 already makes them.
2. **The header starts it, the body never does.** The drag zone is the top
   56px of grabber and title, excluding interactive controls. A body gesture
   never dismisses, even at `scrollTop` zero, so body scrolling stays
   untouched.
3. **An ineligible topmost sheet rubber-bands** up to 12px and snaps back. It
   calls no `onClose`, Stop or Cancel. Lower and inert overlays never respond.
4. **Touch and pen only.** A mouse drag never moves a sheet.

Mechanics:

- **Initiation.** Tracking starts after 8px of downward, vertically dominant
  movement. Horizontal-first movement disqualifies the pointer. Capture is
  taken only after initiation.
- **Tracking.** Downward movement tracks 1:1. Upward movement resists at 0.2×
  displacement, capped at 12px. Scrim opacity is
  `1 - 0.6 * clamp(dy / surfaceHeight, 0, 1)`.
- **Commit.** On release, a displacement of at least
  `min(25% of surface height, 120px)` commits the dismissal. So does a
  downward velocity of at least 0.5px/ms over the final 80ms, with at least
  24px of displacement.
- **The reason.** A commit calls `onClose` once with a new
  `OverlayCloseReason`, `"swipe"`. That adds to the four reasons D54 shipped:
  `escape`, `scrim`, `close-button` and `close-request`. `open` stays
  caller-owned. Closing remains instant; if the caller keeps the overlay
  open, the sheet snaps back.
- **Cancellation.** Snap-back is 200ms ease-out. The gesture ends without
  dismissing on pointercancel, a second pointer, lost capture, loss of
  topmost, or a `closedBy` change away from `any`. Escape ends tracking
  first, then follows the normal close policy.
- **Reduced motion and focus.** Direct manipulation stays under reduced
  motion; the snap-back becomes immediate and the scrim fade is dropped. A
  drag never moves focus. D54's closing-render `returnFocus` and
  `onAfterClose` ordering applies unchanged.
- **Unchanged.** The 44px controls, the keyboard and accessibility close paths,
  body scrolling, and the resting baselines at 320, 800 and 1280px. There is
  no exit animation and no new resting visual.

**Dictation.** A swipe while recording means **Stop, with the words kept for
review**, never Cancel. The dictation sheet maps `"swipe"` the way it already
maps `"scrim"` (`onClose={reason => reason === "scrim" ? onStop() : onCancel()}`,
`packages/ui-react/src/components/voice/dictation-sheet.tsx:173`). While
draining, `closedBy` is `none` and rule 3 applies.

**Contract.** `"swipe"` widens the `OverlayCloseReason` union of a public kit
export. #1433 implements the gesture, assesses the compatibility of that
addition, and ships it with a changeset. This record approves no other API
change. The original proposal and prompt stay as history in the #1420
comments; none of their alternatives is current guidance.

