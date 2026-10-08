# Voice conversation: proposed interaction model

Design proposal for [#316](https://github.com/schlessera/brain-kit/issues/316),
under [#54](https://github.com/schlessera/brain-kit/issues/54). It supplies the
interaction requirements for the architecture ruling in
[#317](https://github.com/schlessera/brain-kit/issues/317) and the announcement
work in [#114](https://github.com/schlessera/brain-kit/issues/114).

The timings, controls and interruption rules below are proposed choices for
review. They are not a maintainer ruling, a shipped capability or a provider
selection. The approved permission rules come from
[voice-permission.md](../decisions/voice-permission.md). Architecture, providers
and the future common conversation interface were selected by the maintainer's
October 3 ruling, recorded in [live-conversation.md](../decisions/live-conversation.md).
The [two-engine qualification](../live-conversation-investigation.md) specifies
capabilities and evidence limits. Implementation issues consume the reviewed
interaction design and that architecture record separately; the ruling does
not approve the proposed timings or controls below.

## Job and existing boundaries

The user explicitly starts a conversation to search, hear an answer, capture a
note or append to one without repeatedly operating the composer. The ordinary
chat transcript remains the record. Voice attaches to one selected chat session;
background sessions have visual notifications, not competing voices.

The current input seam mints a dictation session (`SpeechProvider`,
`packages/ui-sdk/src/server/speech.ts:26-44`). The phase-1 driver guards against
late starts after cancellation
(`useDictation`, `packages/ui-react/src/voice/use-dictation.ts:26-40`). That path
continues to mean capture, review, send. Conversation is a separate explicit
choice beside Dictate; it does not change Dictate's default or settle #91's
desktop-sheet sizing.

The binding constraints are:

- Voice may deny a tool and may never grant one, including "always allow".
  New voice-originated turns select the declared voice posture with enforcement
  and `noGrantSurface`. Starting voice on an existing ordinary turn does not
  retroactively change that turn's posture.
- In that enforced posture, ungrantable actions are already denied. They have
  no pending approval to announce or refuse. A genuinely pending approval on
  an ordinary turn, or enforcement with a grant surface, still uses the
  existing visual approval card.
- A pending approval receives one payload-free announcement. Only the scoped
  two-word phrase "brain, stop" refuses it; ambiguity denies, silence does not
  prompt again, and budget expiry drains it as denial. There is no permission
  dialogue or spoken affirmative. Bare "no" and "stop" do not decide approvals.
- A single-question `ask_user` may consume a composer answer. Multiple
  questions and `ask_user_list` do not. The current guard is
  (`questionForTypedAnswer`,
  `packages/ui-react/src/components/chat/ask-user-typed.ts:33-35`). The
  [list contract](../integration-contract.md#ask_user_list-additive-in-0400)
  requires a reader and withholds the tool under `noGrantSurface`; voice does
  not widen it.
- There is no wake word, speaker identification, voice authentication or
  listener outside the explicitly active mode. Audio is captured while that
  mode is active, including during playback for barge-in and scoped refusal.

## Three independent states

A connected service is not proof of an open microphone. The UI reports three
facts independently: connection (`connecting`, `ready`, `lost`), capture
(`off`, `opening`, `on`) and interaction (below). "Listening · mic on" appears
only after capture actually opens. Playback can remain available with mic off.

```text
Off -- explicit start --> Connecting (mic off)
Connecting -- ready + capture opened --> Listening
Listening -- user speech --> Capturing
Capturing -- endpoint + finalized text --> Ready to send
Ready to send -- new speech --> Capturing
Ready to send -- commit --> Working -- audio --> Speaking
Speaking -- audio drained + host settled --> Listening
Working / Speaking -- user speech --> Interrupting --> Capturing
Any active state -- mute --> Mic off
Mic off -- explicit unmute --> Opening --> Listening
Any active state -- loss --> Disconnected (mic off)
Any active state -- leave --> Leaving --> Off
```

Pending ordinary questions and approvals are correlated overlays, not a new
conversation state that waits for a spoken permission grant. `Working` can be
awaiting an ordinary question; answering it follows the question rules below.

| Interaction | Screen | Audible signal and next action |
| --- | --- | --- |
| Connecting | "Connecting · mic off", Cancel | No ready signal before capture opens. |
| Listening | "Listening · mic on", last exchange | A brief rising ready earcon on entry; ordinary turn completion uses a shorter ready earcon. |
| Capturing | Live words labelled "Not sent"; Send now / Discard | No assistant speech over the user. |
| Ready to send | "Sending soon" and Cancel send | One short endpoint tick; continuing speech cancels the pending send. |
| Working | Committed user text; "Working · mic on" | No filler speech; microphone remains available for interruption. |
| Speaking | Assistant text with current spoken segment | Completion earcon only when output has drained and the host turn has settled. |
| Interrupting | "Stopping reply"; new words remain unsent | Cut playback immediately; acknowledge "Reply stopped" once if no new speech follows. |
| Mic off | Persistent "Mic off"; Unmute / Leave voice | "Microphone off" after release; no claim that refusal or barge-in can still hear the user. |
| Disconnected | "Connection lost · mic off"; Reconnect / Leave | One loss signal if output is available; no automatic restart. |
| Leaving | "Leaving voice · mic off" until resources close | A brief exit signal, then restore the composer. |

Signals also have visible text and a polite live-region equivalent. Earcons
distinguish ready, send boundary and exit without relying on colour or animation.
Sound signals can be disabled; screen-reader speech must not duplicate app
speech. Partial words are not repeatedly announced through a live region.

## Entry, ordinary controls and exit

Start from the chat composer using "Start voice conversation". Keep the current
draft and phase-1 review text untouched. Before opening capture, show the actual
speech service and its verified audio destination, with Start / Cancel. An
unknown destination is labelled unknown, never "on device". #317 must establish
this disclosure from the selected implementation's primary documentation and
runtime configuration; this proposal makes no vendor or retention claim.

Enter Listening only when the chat transport, speech transport and microphone
are usable. Failed credentials, unsupported speech or denied microphone access
leave capture off and offer Retry, Dictate where available, or Type. No silent
provider switch: a changed service or audio destination needs a new disclosure
and explicit start. Switching the selected chat requires leaving voice first.

All controls are named buttons available to touch, keyboard and assistive
technology. Ordinary eyes-free controls are a small, fixed grammar of complete
utterances while capture is on: "mute microphone", "leave voice", "send now"
and "discard sentence". They are local controls, never model instructions or
tool approvals. Consume a control only when its complete, unambiguous utterance
matches; a quoted phrase or a longer sentence stays text. Unknown recognition
certainty goes to review. "Send now" commits previously captured finalized
words and is not included in them; it sends nothing if that buffer is empty.

Mute releases capture, including any pending microphone opening, and discards
unsent audio while retaining finalized unsent text for review. It can leave an
already-running reply playing. Unmute requires a button or keyboard action:
there is no microphone listening for a spoken unmute. "Stop reply" is a separate
button that cancels the current reply without leaving voice. Ordinary speech
can also interrupt it. No global single-letter shortcuts are added.

Leave, Escape, route departure, session change and unmount stop playback, release
capture, invalidate callbacks and cancel the voice-owned turn. Finalized unsent
text returns to the composer marked "Not sent"; audio and unstable partials are
discarded. A pre-existing ordinary turn is not silently cancelled merely by
leaving its voice overlay; explicit Stop reply can cancel it. Grants already
made visually and tools already completed are not undone. Hide/background the
app: pause by closing capture and playback, retain the transcript, and require
an explicit Resume when visible. This first release does not depend on a
background microphone or lock-screen service.

Loss of either transport stops capture and playback, discards buffered audio
and retains finalized unsent text as a draft. The host may still be running:
label its outcome unknown until resync, never "cancelled" merely because the
socket closed. Reconnect is explicit and first reconciles host history, current
turn and pending requests with capture off. Then offer Resume to reopen the mic.
Do not replay input, resend a committed sentence, restart tools or replay an
announcement from an old connection. Reconciled resolved cards lose their live
controls before the user resumes. A speech-only failure can leave the ordinary
chat transport usable; report the two connections separately.

## Turn boundaries and correction

Proposed automatic endpoint: after detected user speech, require 700 ms of
silence and finalized non-empty words. Then hold the candidate for a further
500 ms before semantic commit. Continuing speech during either interval extends
the same utterance; Cancel send / Discard removes it. These numbers are tuning
starting points, not measurements or a per-provider promise. Never impose a
maximum utterance timer that sends a sentence while its user is still speaking.

The endpoint tick and "Sending soon" make automatic send perceptible. "Send
now" or its button can bypass the silence/hold once finalized words exist.
An empty capture ends silently with no host turn. A finalization that does not
arrive within 2 seconds after the candidate endpoint moves to "Review before
sending" with capture off; it does not promote a partial transcript to a send.
A provider without trustworthy endpoint/finalization support gets manual send
with this limitation announced on entry, or phase-1 dictation if it cannot
meet the other conversation requirements. It is not advertised as automatic.

Before commit, words are provisional and produce neither a chat message nor a
tool call. A cough, noise-only detection or empty final creates no turn. An
uncertain utterance, recognizer-reported overlap or unusable input quality
requires review: "I couldn't hear that clearly. Nothing was sent." Speech
services must expose enough evidence to make this policy honest; the design
does not claim reliable speaker or background-speech identification. A clearly
recognized background sentence can still be mistaken for an intended sentence.
The explicit mode, preview and cancellation window limit that error; mute or
manual Dictate is the route in noisy surroundings.

Committed words appear once as the user's transcript, including the text used
to answer a question. Partial revisions never become separate messages. Use
existing pronunciation overrides only as disclosed text correction, retaining
the distinction between recognized words and submitted text. The present
`AsrEvent` carries partial/final text and `endsTurn`, not confidence, overlap
evidence or an output transcript (`AsrEvent`,
`packages/ui-sdk/src/protocol.ts:1646`). #317 must resolve those gaps rather
than pretending that dictation supplies them.

Assistant text remains the generated answer; playback progress is a separate
fact. Mark an interrupted tail "Not spoken", keeping the actual tool receipts
and sources visible. If an integrated service cannot supply reliable generated
text or playback alignment, label that gap explicitly; never reconstruct words
and present them as a verbatim record of what the user heard.

Misheard names before send can be corrected in the preview. After send, Edit
as new message or a spoken correction creates an explicit follow-up; it never
rewrites history or claims to undo a completed note append. The reply and tool
receipts say what actually happened. A misunderstood write may need a later
visible correction even when voice safely interrupted its speech.

A model response ends only after the host terminal disposition and every
eligible output segment has played or been discarded. End of an audio chunk
is not end of a turn. An ordinary `ask_user` question may finish speaking while
the host still waits for its answer; the label becomes "Answering question ·
mic on", not "Turn complete". A permission announcement does not hand over the
floor for an approval answer.

## Speech ownership and interruption

One output owner at a time. User speech has priority, followed at the next
quiet boundary by denial/failure feedback, an unannounced approval request,
and ordinary assistant speech. The model cannot barge into user capture.
An arriving approval stops ordinary assistant playback, but waits for a user
already speaking to pause. If the request resolves before it can be announced,
drop its pending announcement and show the resolution instead.

Interrupt every boundary: connecting/opening, user capture, endpoint hold,
model generation, queued output, active playback, question reading, approval
announcement, and final audio drain. A user interruption cuts current playback
and invalidates queued segments immediately. Do not resume the interrupted
announcement or reply from a stale queue. Keep its visible record and mark
which speech was interrupted.

- During generation or an ordinary reply, request host cancellation for that
  turn. Buffer the new utterance locally, but do not dispatch a replacement
  until the old host turn settles. If cancellation acknowledgement is lost,
  show "Checking whether the reply stopped · mic off" and reconcile on
  reconnect. Do not start a second potentially mutating turn on an assumption.
- During a pending single-question exchange, stop its question playback but
  keep the host question open for the ordinary answer. Do not cancel the turn
  and thereby destroy the request the answer must bind to.
- During a pending approval, test the scoped refusal before ordinary endpointing.
  A refusal denies the correlated requests; it does not start a new model turn.
  Other speech can interrupt and become ordinary input, but cannot grant. A
  replacement turn cancels the former host turn and its remaining approvals;
  report those denials only after confirmation.
- Stop reply or Leave closes an endpoint hold without sending its partials.
  An output-only interruption never rolls back tools already dispatched.
  The screen and spoken receipt distinguish "reply stopped" from "action
  denied" and "action completed".

Playback must not feed its own announcement (which itself says "brain, stop")
back into the refusal detector. Keep user recognition available during playback;
blanking the microphone while speaking would lose the refusal. Echo isolation,
input/output alignment and late-event suppression are requirements for either
architecture, to prove with speaker playback as well as headphones. An echo
failure can cause a safe false denial, but repeated self-denials do not meet
the usability requirement. Do not describe this as speaker authentication.

## Ordinary questions and reading-dependent cards

Read the single ordinary question once, with short option labels when present;
its full card stays in the transcript. A finalized spoken answer passes through
the same single-question composer binding and appears in the card's existing
typed-answer presentation. It answers the exchange rather than sending another
chat message. The speech-input origin is not a new kit card state.

At commit recheck the request's identity and liveness. Never attach an answer
to a replacement request just because it occupies the same slot. If a single
question arrives during capture, display/announce that the pending text will
answer that question and return to the endpoint hold so the user can correct
or discard it. A question that was cancelled or ended before submission gets
"Question closed; answer not sent", with the text retained for an explicit
ordinary send. Do not infer a permission grant from an answer such as "yes".

For multiple `ask_user` questions, say once "There are several questions on
screen. Use the card to answer them." Read no long option tour and add no
spoken answer routing. A composer or spoken sentence remains an ordinary
message. To submit the existing card without losing it to replacement-turn
cancellation, mute/pause voice and use its controls; merely entering or muting
voice does not dismiss it.

Likewise, a list already pending when voice starts on an ordinary turn remains
visible and pending: "This list needs the screen. Speech won't answer its
items." Keep its scale, per-item selections, Submit and cancellation semantics.
A spoken message neither fills the list nor submits it. Choosing a new voice
turn instead of finishing the old exchange cancels the old turn visibly; it
does not silently discard a pending list on entry. New `noGrantSurface` voice
turns cannot offer the list. If the user needs it, Leave voice and explicitly
continue in ordinary chat; that change never applies to the earlier turn.

## Permission sequences, correlation and receipts

Pending state is keyed internally by selected session, host turn and tool-use
id. Deduplicate redelivery by that identity, not announcement text. A request
can be announced once in its lifetime; reconnect and interrupted playback do
not reset that receipt. Entering voice with existing pending requests queues
each live request once. Notifications from other sessions stay visual.

Route input in this order: a scoped refusal candidate, an unambiguous local
control, a live single-question answer, then an ordinary message. A consumed
refusal is not also a question answer or a new message. Classify the original
recognizer input before pronunciation overrides or other text transformation;
assistant output and reconstructed transcripts are never recognition input.

Use the approved pattern effect when present, with this proposed short script:
"I want to [effect]. The command is on screen. Voice can't approve it. Say
brain, stop to refuse." For a tool request or a pattern without a usable effect:
"[Tool name] needs a decision on screen. Voice can't approve it. Say brain,
stop to refuse." Neither script reads `input`, arbitrary descriptions or command
payloads. Use a bounded, plain tool label, not text obtained by inspecting the
payload. Missing or oversized effect copy needs a payload-free fallback and a
visible reason; target roughly ten seconds, not a payload-dependent recitation.
Require identifiable host-approved effect copy; a free-text request description
is not by itself evidence that it is a speakable pattern effect. #317 assesses
how that provenance reaches the client, and #114 uses the tool-name fallback
when it is absent. This proposal selects no new wire field or interface.
While mic is off, replace the phrase offer with "Mic is off. Use Deny on screen,
or unmute to refuse." This remains the request's one announcement; unmuting
does not cause a repeat. A refusal detector never claims to work without capture.

The refusal window opens when the client knows a request is actually pending,
including before/during announcement, and closes on authoritative resolution.
At a refusal candidate, snapshot every unresolved request in the selected
session's current turn. A single request gets one denial; multiple requests
all get denials because guessing one would leave the others actionable.
Partial/low-confidence recognition of the two-word phrase or overlapping speech
is also refusal of that snapshot, never a clarification or a grant. This does
not make a bare "no" or "stop" into an approval decision. Later-arriving requests
require their own live window and are not silently added to an earlier snapshot.

Send each denial using the existing `tool_denial`, `toolUseId`, echoed `turnId`,
`channel: "voice"` and a message naming the recognized phrase and ambiguity
where applicable (`ClientToolDenial`,
`packages/ui-sdk/src/protocol.ts:705-713`). Before transmitting or playing a
queued announcement, recheck liveness. Duplicate/late events do not decide a
replacement request. "brain, stop" outside a pending window is ordinary
transcript text, including as a possible single-question answer.

Do not announce success from an optimistic send. Show "Refusal sent" until
the host confirms resolution. Then say "I took that as a refusal. The action
was denied", or the plural/count for confirmed multiple denials. A visual
grant that wins the server race is not reversed or reported as a denial:
"The screen decision was already accepted." Show the actual subsequent tool
outcome. When disconnected, say "I couldn't confirm the refusal. Mic off.
Check the screen"; do not queue a denial to an unknown replacement turn.

An already-denied posture action gets one outcome receipt: "I didn't do that.
It needs a decision on screen. Leave voice and ask again when you can look."
No pending announcement, refusal window or fake approval card is created.
Deduplicate against the assistant's equivalent denial speech so it is said
once, using the host outcome as truth.

Silence produces no reminder. At expiry the server denies and removes pending
requests (`drainPendingForTurn`,
`packages/ui-server/src/ws/turns.ts:699-733`). Clear the correlated card's
actionable state on the host terminal outcome even if no `tool_result` arrives;
the current terminal-frame contract is (`ServerResultMessage`,
`packages/ui-sdk/src/protocol.ts:1046-1056`). Keep the existing card/receipt in
the transcript with "Expired · denied" and no live approval controls. Speak
once: "I stopped without doing it. Ask me again when you can look at a screen."
Cancellation similarly resolves only the requests of the cancelled turn.

This cleanup and denial acknowledgement are implementation requirements, not
claims that the present client already supplies them. #317 must determine
whether existing terminal/tool events provide enough evidence or require an
additive resolution event, and account for reconnect/resync. Actions remains
the decision audit: voice-channel denial, request and principal from the host.
The transcript adds a payload-free announcement receipt and its interruption,
plus a confirmed denial/expiry receipt. Stopping voice is not an audit substitute
for a permission decision.

## Screen composition

Extend Chat; keep the established rail, transcript, composer, question and
approval cards. Use kit typography, spacing, ink and status tokens in both dark
and paper themes. No new fullscreen orb, permission dialog or second transcript.
The persistent voice strip reports interaction, capture and service separately.
It sits above the composer; an expanded live-text area scrolls within the chat
without covering the active card. Provider disclosure is reachable from the
service label and remains visible on entry/failure.

320px, ordinary turn (each line below fits a 36-column sketch):

```text
+----------------------------------+
| Chat · Ithaca            [More]  |
|                                  |
| You                              |
| Find my note about the voyage.   |
|                                  |
| Brain                            |
| The departure note says...       |
| [source: Departure note]         |
|                                  |
| Listening · mic on               |
| Service: configured speech       |
| Not sent: add that we leave...   |
| [Send now] [Discard]             |
| [Mute mic] [Stop reply]          |
| [Leave voice]                    |
| [Type a message...]              |
| Chat  Actions  Files  Graph More |
+----------------------------------+
```

The same 320px transcript with a genuine pending approval:

```text
+----------------------------------+
| Chat · Ithaca                    |
| Existing approval card           |
| Archive a document               |
| Full input stays on screen;      |
| wraps inside the card.           |
| [Approve] [Deny]                 |
|                                  |
| Announced once · no payload read |
| "Voice can't approve it..."      |
|                                  |
| Working · mic on                 |
| Say "brain, stop" to refuse      |
| [Mute mic] [Leave voice]         |
| [Type a message...]              |
+----------------------------------+
```

This is the existing card, not a voice grant. Its allowed buttons still follow
kind/rememberability; the sketch shows a `kind: "command"` confirmation, so
it does not offer Always allow. A tool-kind card retains that visual control
where the host permits it. After expiry the same position reads "Expired · denied", retains the
receipt and has no Approve/Deny buttons. Under `noGrantSurface` this sketch is
replaced by an already-denied tool receipt, with no refusal instruction.

Desktop (rail + chat list + chat detail; no additional voice pane):

```text
+---------+--------------------+--------------------------------------------+
| Chat    | Chats              | Ithaca                              [More] |
| Actions | > Ithaca           | You: Find the departure note.              |
| Files   |   Voyage notes     | Brain: Here is the note... [source]        |
| Graph   |                    |                                            |
| Settings|                    | Existing AskUserCard                       |
|         |                    | "Which day should the note mention?"      |
|         |                    | [Today] [Tomorrow] [Other]                 |
|         |                    |                                            |
|         |                    | Answering question · mic on                |
|         |                    | Service: configured speech [Details]       |
|         |                    | Not sent: Tomorrow, before departure.      |
|         |                    | [Send now] [Discard]                       |
|         |                    | [Mute mic] [Stop reply] [Leave voice]       |
|         |                    | [Type an answer...]                        |
+---------+--------------------+--------------------------------------------+
```

At 320px stack controls into rows and wrap long words; no horizontal document
scroll. Each target has at least 44px effective width/height, with D34's
expansion constrained by neighbouring targets; controls that cannot expand
safely get real space. All icon buttons have names, active mic state is text,
and muted/expired content retains contrast. Reduced motion removes pulsing and
sliding without removing state signals. Entry moves focus to the voice strip's
heading/control; mute retains focus on its now-Unmute button. Leaving returns
focus to the composer. Resolution follows D36/D37: the composer in the
transcript, next card or empty heading in Actions. Speech never steals focus
from someone reading or granting on the existing card. The illustrated content
belongs to the kit's fictional Odysseus world.

## Architecture requirements for #317

This compares obligations, not measured products. At the proposal's creation,
neither column was selected. The maintainer's October 3 ruling subsequently
selected the integrated direction with both engines behind one interface;
see [the architecture record](../decisions/live-conversation.md). The table
remains requirements input, with actual capability limits recorded in the
[qualification](../live-conversation-investigation.md).
An integrated session must explain how its speech/model execution maps to the
existing backend turn and permission authority. A cascade must explain how
its stages preserve the same identity and cancellation. Neither can introduce
a second independent tool executor.

| Requirement | Integrated live speech-to-speech | Transcription → model → speech |
| --- | --- | --- |
| Semantic commit | Expose/control endpoint and candidate hold; speculative speech or tool execution cannot escape before committed user input. | Finalize recognition, apply the hold, then dispatch the host input once. |
| Streaming | Simultaneous input recognition and output audio with explicit output ownership; no provider-owned permission conversation. | Streaming input and incremental model text/output; do not wait for the whole reply if playable segments can be correlated. |
| Latency | Measure endpoint-to-first-audio plus provider/host coordination; native speed cannot replace commit or gating. | Measure recognition finalization, host/model latency and speech startup separately as well as end to end. |
| Cancellation | Stop generation/audio, purge remote/local queued segments, acknowledge cancellation and ignore old session events. | Cancel recognition candidate, model generation and speech production/playback independently; one old stage cannot restart another. |
| Barge-in | User input stays available during model and announcement audio; echo isolation must not suppress real refusal. | Input remains available while output plays, with echo isolation and shared arbitration across stages. |
| Turn authority | Map speech response ids to one host session/turn; route tool calls through its existing approval/posture enforcement. | Carry host session/turn/utterance identity through every stage and route tools only through the backend. |
| Transcript provenance | Distinguish recognized input from model output and provider revisions; record the submitted words and align generated/spoken segments. Native audio without trustworthy text cannot silently substitute an invented transcript. | Keep recognition revisions separate from submitted text; align model text and synthesized/spoken segments, including unplayed tails. |
| Partial and ambiguity evidence | Supply finalization, refusal-candidate and uncertainty/overlap evidence, or specify a conservative review fallback. An audio-only opaque session is insufficient. | Do not infer confidence from an event being final; provide uncertainty evidence and a refusal stream independent of normal turn endpointing. |
| Tool and question events | Reconcile tool results, host terminal outcomes and pending question/card identities with live speech; no parallel model deciding grants. | Host tool/question events arbitrate output; pause question audio without cancelling its pending answer request. |
| Approval announcements | Allow deterministic payload-free host-authored speech with priority, identity and once-only delivery; refuse throughout playback. | Feed the same host-authored text to output, arbitrate it with model chunks, deduplicate and keep recognition live. |
| Timeout and reconnect | Reconcile the host's pending/resolved requests and speech session separately; reconnect cannot replay tools, speech or user audio. | Reconcile each stage and the host separately; stale finalized recognition and queued audio are discarded. |
| Privacy and availability | Verify actual audio destinations, credentials, retention and fallback policy from primary sources/configuration. Report unavailable live features honestly. | Verify the input and output services separately, including intermediate text destinations and any browser fallback. |
| Extension argument | Explain whether/how current dictation seams can coexist, and justify any new seam with a plausible second implementation within a year. | The existence of two stages does not itself justify two seams; apply the same ROADMAP bar to any output seam or widening. |

Proposed evaluation targets: capture-ready feedback within 100 ms of actual
capture activation; endpoint hold 700 + 500 ms as above; commit-to-first-audio
median at most 1.5 s and p95 at most 3 s for a short keyless scripted reply;
local playback cut within 150 ms of detected barge-in; denial sent within
250 ms of a refusal recognition event. Provider/network measurements are a
separate manual evaluation, with device, environment and stages recorded.
Keyless fake timings prove scheduling, not live latency or recognition quality.
If a candidate misses a target, #317 states the cost and requests a ruling;
it does not erase the commit hold or permission boundary to win a benchmark.

Require keyless runtime demonstrations of each cancellation boundary, echo
rejection, phrase during playback, ambiguous/multiple refusals, late callbacks,
question binding, list non-binding and card expiry without a tool result. A
later manual device pass must assess audible signals, actual recognition,
speaker playback and interrupted transcripts. No live-provider evidence or
human listening pass is claimed by this design document.

## Worked exchange and recovery

Odysseus starts voice, sees the configured service disclosure and hears the ready
signal only after capture opens. "Find my departure note" previews, endpoints
and sends; the answer speaks with a source visible in Chat. He interrupts:
"Add that we leave tomorrow." Playback stops; after the old turn settles, the
finalized input starts a new declared voice turn. The note append is allowed
and its actual receipt is heard. "Archive that note" is denied by the enforced
posture: the archive did not happen, there is no waiting card, and the receipt
says to leave voice and ask again with a screen.

In a separate ordinary chat turn with a real pending archive approval,
activating voice preserves that card and announces it once. "Brain, stop"
during playback cuts the audio, denies the live request and gets a confirmed
voice-channel receipt. If he says nothing instead, no reminder plays; at the
host budget expiry the card becomes Expired · denied and the user hears that
the action was not done and must be asked for again. If speech disconnects
before the refusal is confirmed, the UI says that confirmation is unknown and
requires reconnect/resync; it never reports an unobserved denial.

## What the consuming issues need

#114 should link this proposal and keep architecture selection as a dependency
on #317. Replace its stale focus-scope pointer with the D36 heading; make its
scope explicitly cover live refusal during playback, user-priority interruption,
once-only request receipts, all-current-request denial on ambiguous multiple
pending approvals, and identity/liveness rechecks. Include both pending and
already-denied cases, without a new grant surface. Add acceptance for visual
grant races, confirmed denial feedback, disconnect uncertainty, late callbacks,
and terminal/timeout cleanup without a `tool_result`. Scope refusal transport
to the existing voice-channel denial shape; leave any new acknowledgement,
announcement audit or resync contract to the architecture assessment instead
of claiming that #113 is the only possible contract impact.

The recorded proposal supplies #114's design input; review comments can revise
it without implying implementation approval. Keep #114 blocked on #317 and do
not mark it agent-ready until that ruling supplies the necessary speech and
host-event capabilities. Preserve its keyless proof and real-device listening
requirements.

#317 consumes the comparison, measures/verifies candidate capabilities against
the boundaries above, obtains the maintainer's architecture/seam ruling and
files the resulting implementation units under #54. Closing #316 clears the
design-production dependency, not `needs: decision`. #317 must explicitly
resolve ambiguity evidence, echo-safe refusal during playback, host cancellation
acknowledgement, effect-copy provenance, reliable pending-resolution/terminal reconciliation, transcript
provenance and audio-destination disclosures. It identifies any contract changes
before implementation; this proposal changes no contract. The epic keeps its
existing outcome, and does not treat a merged proposal as shipped conversation.
