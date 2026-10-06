# Decision: interactive answers are delivered with receipts

Why an answer to `ask_user`, `ask_user_list`, `ask_user_rank` or
`ask_user_form` is saved on the device, sent with a submission id and shown
as answered only on the host's receipt. Also why one request is one card,
and why a foreground socket is probed. Issue #910, under epic #734. This is
the design record, not a status file.

## The problem

On a phone the app is backgrounded all the time, and its socket dies or goes
half-open while a question is pending. Two symptoms came back repeatedly:

- **The same card twice.** The host re-sends every pending question on each
  socket open, often right after a history snapshot that had already rebuilt
  the same question from its tool call. The client appended every request
  frame it received.
- **Submit does nothing, repeatedly.** The Claude ask tools minted a random
  request id. A card rebuilt from history used the tool call's id instead, so
  its answer named a request the host never registered. The host dropped it
  without a frame or a log line. The client had already marked the card
  answered before `send()`, and ignored a `false` return.

There were three causes underneath: two identities for one request, a card
store with no notion of "the same request", and an answer path with no
acknowledgement at all.

## The rulings

The maintainer settled five policies and the interaction design on #910
between 2026-10-04 and 2026-10-05. This record implements them and does not
reopen them:

- **Recovery B.** Automatically retry an explicitly submitted answer after a
  reconnect, for its original binding only. An unsubmitted draft is never
  sent.
- **Compatibility B.** Receipt-capable peers are required for the four ask
  answers. This is a pre-1.0 break, scoped to those four answers.
- **Lifetime B.** A submitted answer is persisted on the device and survives
  a reload or a browser discard.
- **Liveness B.** In the foreground, probe after 15 seconds without host
  traffic and replace the socket after 5 more seconds without a reply.
  Return, resume and going online check at once.
- **Queue A.** At most 16 answers and 16 MiB per device and principal, and at
  most 24 hours from the original Submit. A 5-second receipt watchdog, and
  the existing 1-to-30-second reconnect backoff.
- **The answer-delivery design** (§1–§8) covers the card identity, the state
  machine, the exact copy and actions, the focus rules and the announcements.
  Its residual rulings are R1, an explicit `Send as message` on Closed and
  Expired cards, and R2, an `unconfirmed` session tracker. R2 applies only
  once that tracker exists (#943), which it does not yet.

## One identity per request

Claude Code sends `_meta["claudecode/toolUseId"]` on every MCP `tools/call`,
and the Agent SDK's in-process server hands a request's `_meta` to the tool
handler as `extra._meta`. The SDK types that argument as `unknown`, so the
field is read defensively, with a minted id as the fallback (`askRequestId`,
`packages/ui-backend-claude/src/tool-use-id.ts:20-25`). This was measured
before anything was built on it: a keyless run of the bundled CLI 2.1.283
against a scripted model on loopback delivered exactly the scripted
`tool_use` id. `packages/ui-backend-claude/tests/ask-tool-request-id.test.ts`
re-measures it for all four tools against whatever CLI the lockfile installs.
It fails on its id assertion when the tools mint ids again. The pi backend
already used the tool-call id.

Tool schemas did not change. The issue ruled out changing them to
manufacture an identity, and it was not needed.

## One card per request

The store updates a request it already holds and never appends it again
(`addExchange`, `packages/ui-react/src/stores/chat-state.ts:244-275`). A
settled card stays settled, so a late or replayed frame cannot revive a
dismissed or answered question. A pending card keeps its payload and the
exchange object it is keyed by, so a draft in progress survives a re-send.
When a request claims a different turn than the card already holds, that is
a contradiction rather than an update, and it is ignored. The host's receipt
decides which binding is real. History replacement keeps any turn the live
card had learned, and the card is drawn under the tool call whose id it
carries, no longer by position.

The host also re-sends a session's pending questions after `session_resume`
(`resendPendingAsks(host, ws, msg.sessionId)`,
`packages/ui-server/src/ws/dispatch.ts:615`). Before this, a resume replaced
the transcript and left only a history card behind, which was the second
symptom.

## Receipts, and why the break is not negotiated

Each answer carries a client-minted `submissionId`, reused for every retry of
that answer. The host settles the request at most once, records the outcome,
and answers the sender with `ask_answer_receipt` (`handleAskAnswer`,
`packages/ui-server/src/ws/ask-answers.ts:105-181`). A repeat of the same
submission gets the same receipt and settles nothing.

Revision 3's echo is negotiated per connection: a client that declares
nothing keeps the old tolerance. Compatibility B rules that out for these
four answers. If the host kept accepting answers without a `submissionId`, an
old client would go on showing acceptance it never confirmed, which is the
false acceptance this issue exists to remove. So a host advertising
`askReceipts` refuses such an answer with `ASK_ANSWER_UPDATE_REQUIRED` and
leaves the question pending. The schema still parses the frame, so an old
client gets that error, not a parse error. `PROTOCOL_REV` is 5, but the
capability flag is what peers check, because a revision number alone was
ruled not to establish receipt support.

Outcomes are remembered in memory for 24 hours, at most 1,024 of them
(`ASK_OUTCOME_TTL_MS`, `packages/ui-server/src/ws/turns.ts:369`). That is the
client's maximum replay age, so any answer a client may still replay finds
its outcome. Persisting outcomes would not help after a restart: the
requests themselves are gone then, and an answer for them must stop, not
settle. `not_recognized` stops it.

`ask_answer_status` exists so that a replay asks before it sends again,
which Queue A requires. A receipt is bound to its caller's principal, as a
retry receipt is: another principal learns nothing.

## The queue on the device

Every Submit goes through one queue. It saves the answer, sends it, and
waits for the receipt (`createAnswerDelivery`,
`packages/ui-react/src/lib/answer-delivery/manager.ts:90`). The card shows
"saved on this device" only after the storage write has committed. A write
that fails leaves the card editable and sends nothing, because sending an
answer that would not survive a reload breaks the promise the queued state
makes. After a reconnect or a takeover, every held answer asks for its
status first and is sent again only while the host reports it `pending`
(`function replay(entry`, `manager.ts:314-318`).

Admission against Queue A is decided, and its storage write committed, under
one lock that every tab shares. The count and byte totals are read from what
the device actually holds. Counting this tab's own entries allowed two
concurrent Submits, or two tabs, to both take the last place. The 24-hour
bound is also checked wherever an answer could leave, not only by its timer:
a page frozen past the deadline runs its reconnect before the overdue timer
fires. Signing out voids an admission still in flight, so an answer written during
logout is taken back rather than left for the next principal. A host
without receipts still gets the answer stored, so `Reload app` does not lose
it, and after the update it replays with a status check first. A composer
answer that is refused admission goes back into the composer. Before this
fix it lived nowhere but the cleared draft. `Cancel sending` reports Cancelled only after
the record's deletion has committed. A restore that read storage before a
logout discards what it read. A storage read that fails at startup is
retried on the next connection, not treated as permanent. All of these were
found by the three adversarial review passes.

While an answer is unconfirmed, the card shows it read-only under the head
"Your answer". The kit's ask cards take `recordHead` and `recordIcon` for
this. Before that change, their record state said "Answered" above a footer
saying the opposite. While the answer is being saved, and when it was
refused admission, the card stays the editable question, so the draft is
not lost when its contents are remounted. After a question was closed by
another answer, the card still shows the answer this user submitted, which
is the one Copy answer copies.

**Storage is IndexedDB.** At 16 MiB, `localStorage` would hit its quota
first, and it blocks the page while it writes. A restored record is
untrusted input: it must rebuild a frame that passes the host's own client
schema, or it is dropped and never sent (`parseQueuedAnswer`,
`packages/ui-react/src/lib/answer-delivery/storage.ts:32`). A root built
without persistence, for stories, tests and SSR, keeps answers in memory. A
real page without IndexedDB has no store at all, and its cards say Not
saved.

**The principal** is identified by `server_hello.principalKey`, a one-way
digest of the principal id (`answerQueueKey`,
`packages/ui-server/src/ws/connection.ts:27-29`). The page cannot read its
principal from an httpOnly cookie, and it needs nothing more than "same or
different". A different key on reconnect signs every held answer out,
unsent. So does logging out, or revoking this device's own principal.

**Tabs.** Both tabs read the same records, so both would replay them. Each
submission has one owner, the tab holding its Web Lock. The others wait for
that lock and show the owner's broadcast state, read-only
(`createBrowserTabCoordinator`,
`packages/ui-react/src/lib/answer-delivery/tabs.ts:35`). A tab claims its own
submission before announcing it. Announcing first let a listening tab queue
for the lock ahead of the submitting tab, and a unit test caught that.

## Liveness

Browser WebSocket ping/pong is not exposed to scripts, so the host answers an
application-level `ping` (`private sendProbe`,
`packages/ui-sdk/src/client/ws-client.ts:458`). A replaced socket is retired,
and every one of its callbacks checks that before it touches the client, so
a late close from a dead socket cannot reset its replacement.

The browser tests found a second dead state that the ruling did not name. A
connection attempt sent into a dead path neither opens nor fails. No probe
runs on a socket that never opened, and `reconnectNow()` does nothing while
one is connecting, so the client waited forever. A connection that has
delivered nothing after 10 seconds, whether still connecting or open, is now
abandoned and retried through the normal backoff (`private abandon`,
`ws-client.ts:492`). This adds no new timeout to a question. The host's turn
deadline stays the only limit on an ask.

## Rejected

- **Explicit Retry only (Recovery A).** It was rejected by ruling. It also
  still needed receipts, because a lost receipt looks exactly like a lost
  answer.
- **Negotiated, legacy-tolerant receipts (Compatibility A).** Rejected by
  ruling, for the false-acceptance reason above.
- **A memory-only queue (Lifetime A).** Rejected by ruling. A PWA is
  discarded in the background often enough that a reload is the common case,
  not the edge case.
- **Using the turn mapping in `BrainUiClient` for retries.** That mapping is
  consumed by the first send and cleared on every close. Queued answers carry
  their turn explicitly instead.

## Evidence

- `packages/ui-backend-claude/tests/ask-tool-request-id.test.ts`: the real
  CLI's `tool_use` id reaches the bridge, for all four tools.
- `packages/ui-server/tests/ws-ask-receipts.test.ts`: receipts, at-most-once
  settlement, update-required, binding refusals, status, principal binding,
  re-delivery after resume, the hello and pong, for every kind.
- `packages/ui-server/tests/integration/real-socket-answers.test.ts`: the
  shipped client against a real `createApp()`, through a loopback relay that
  can blackhole an open socket.
- `packages/ui-react/tests/answer-delivery.test.ts`: the queue's state
  machine, both Queue A budgets measured exactly in multibyte UTF-8, the
  24-hour boundary, reload, two tabs, cancel and edit, principal change and
  storage failure.
- `packages/ui-react/tests/chat-store-ask-dedup.test.ts` and
  `tests/render/answer-delivery.test.tsx`: one card per request, and every
  §3 state's exact copy on all four cards.
- `packages/ui-react/tests/answer-delivery-runtime.test.ts`: real Chrome on
  the public ChatPage against the real host. It covers offline submit,
  reload and acceptance once for each kind, a lost receipt, update-required,
  storage failure, a principal change, two tabs, a corrupt record, and
  Liveness B on a blackholed socket. The local measurements were a lost
  receipt recovered in 5.1 seconds and a blackholed idle socket replaced
  18.5 seconds after the cut. While healthy, one probe went out per
  15 seconds of idle time.

None of this reproduces a phone's suspended timers or its background policy.
The phone PWA check reserved on #910 is still owed.
