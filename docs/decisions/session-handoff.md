# Continuing in a new conversation

A session is pinned to the backend that owns its transcript: resumed sessions
route by their stored backend id, and the composer locks its picker once a
session is live. Moving a conversation to another backend therefore needs an
explicit design. The maintainer's
[2026-09-28 ruling on #61](https://github.com/schlessera/brain-kit/issues/61#issuecomment-5869740791)
chose a new linked session; the
[2026-10-05 ruling](https://github.com/schlessera/brain-kit/issues/61#issuecomment-5998121918)
approved the interaction design with three residual choices settled.

## Decision: a new linked session, seeded with a reviewed handoff

Handoff creates a distinct session on the chosen profile's backend. Its
first user message is a summary the user reviewed and edited, followed by the
brain files they kept as references. The source session is unchanged: its
history, backend, accounting and usability stay exactly as they were, and it
gains a forward marker. The destination's first message renders as a handoff
card that links back and says plainly that the chat knows only what the card
says.

The maintainer's 2026-10-11 ruling on #1621 also permits the source's own
backend and profile. This closes the recovery dead end on a single-backend
host when a transcript is too large. The reviewed summary starts a fresh
conversation on that model; it never resumes the oversized source session.
This removes a refusal and is an additive contract change, shipped in a minor.

Alternatives rejected:

- **Switch the backend in place.** Backend-native histories and accounting
  differ. An in-place switch needs a translation of one runtime's transcript
  into another's and mixed ownership of one session's turns and costs.
  Neither backend's pinned behaviour should be quietly changed to make them
  agree.
- **Import the full visible history into the destination.** It implies the
  destination received everything the user saw, which it would only in a
  lossy translated form, and it copies historical cost/turn totals. The
  destination receives only the approved handoff, so its provenance is
  honest.

## What never transfers

Pending approvals, remembered grants and active tool executions stay on the
source. The destination's turns follow its own profile's ordinary permission
policy; confirming the handoff grants no tool permission. A running source
reply is excluded from the snapshot and keeps running. These are consequences
of the new-session shape rather than extra rules: the destination is an
ordinary new conversation whose first message happens to be a handoff.

## Residual choices (2026-10-05)

- **R1: the model summary runs when the sheet opens.** The design had
  proposed an opt-in summary; the ruling made it automatic. The sheet states
  `Drafting a summary with {profile} · spends` as it starts. The run happens
  whether or not the handoff is then started. Stopping it, typing, a failure
  or a backend that cannot run it falls back to a deterministic draft from the
  last six settled messages, labelled `no model`. A refresh happens only on
  an explicit tap and never overwrites edits without `Replace your edits?`.
- **R2: six messages, 4000 characters.** Starting values for the fallback
  window and the handoff text limit.
- **R3: an optional `handoff` field on the new-session `chat_message`.** One
  creation path; the host authorizes the source and every reference before
  creating anything. A dedicated message would have isolated the checks but
  duplicated routing, admission and acknowledgement.

## Preparation is a run on the source

The summary runs on the source session's own backend and stored profile,
because that is the runtime whose cost model the source already lives in.
It uses the existing nonpersistent, toolless turn posture (the autonomous
turn options with no allowed tools, `enforceAllowedTools` and
`noGrantSurface`), so it creates no backend session and can raise no approval
anyone would have to answer. Activity records it as a run named
`handoff preparation` on the source session. Its cost joins the source's
total without counting a turn; an unknown cost stays unknown, as
[cost-tracking.md](cost-tracking.md) requires. A backend that cannot run a
nonpersistent turn (pi with an injected session factory, today) answers
`failed` and the deterministic draft applies. A running preparation occupies a
slot of the concurrent-session cap like a turn, for every admission path, and
keeps it until the backend has unwound, even after its connection has gone.
Authorization is checked again at the last await before the model starts.

## Idempotency under uncertain delivery

A phone loses its socket at every screen lock, so a send can be accepted and
its acknowledgement lost. Each review mints a `handoffId`, stored as a unique
key on the destination session. A repeated key returns the destination it
already created, or `pending` while that creation is in flight; the in-flight
entry is claimed before the host's first await, so a retry racing a slow
first attempt cannot start a second session. `handoff_status` asks without
creating, which is what the sheet's `Check again` sends. A creation that
failed leaves nothing, so `Try again` with the same key is safe. If the
destination exists but its link cannot be stored, the host keeps the key in
memory for the life of the process rather than forget the only record of it:
failing closed, a retry still finds the destination.

## Where things live

- Host: [`packages/ui-server/src/ws/handoff.ts`](../../packages/ui-server/src/ws/handoff.ts)
  (creation, status, preparation), the catalog columns in
  [`migrations/031_session_handoff.sql`](../../packages/ui-server/migrations/031_session_handoff.sql),
  and the links on `GET /api/sessions`.
- Client: the review sheet
  [`handoff-sheet.tsx`](../../packages/ui-react/src/components/chat/handoff-sheet.tsx),
  the card and forward marker
  [`handoff-links.tsx`](../../packages/ui-react/src/components/chat/handoff-links.tsx),
  and the snapshot and fallback rules in
  [`lib/handoff.ts`](../../packages/ui-react/src/lib/handoff.ts).
- Wire: [integration contract, session handoff](../integration-contract/wire.md#cross-backend-handoff-additive-61).

## Profiles that cannot run

The To list offers all runnable profiles, including the source's own, then the
configured ones that cannot run now, disabled with their reason printed
(`needs credentials`). The host reports those apart from the runnable roster
(#1044, ruled 2026-10-06), so routing and every client that reads the roster
keep its "runnable now" meaning. The reason is a closed enum and the client
owns its copy; no backend detail, such as a key name, reaches the sheet.
`host offline` stays client-derived. The source profile is labelled
`new conversation`. The `session_too_large` action opens the review with that
profile preselected when available. Ordinary entry keeps its existing
other-backend default; if none is available, the sheet can select an available
same-backend profile. An unavailable profile is never selected over a runnable
one. The existing model-picker, session-menu and palette entries remain
cross-backend shortcuts; recovery opens the sheet directly, including on a
single-backend host.

## Known limits

- There is no file picker in the client yet; `+ add a file` takes a
  brain-relative path, which the sheet checks before it can be sent.
