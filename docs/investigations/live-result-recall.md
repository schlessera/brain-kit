# Live research-result context — 2026-10-29

Timeboxed investigation for [#3131](https://github.com/schlessera/brain-kit/issues/3131),
part of [#54](https://github.com/schlessera/brain-kit/issues/54).
Inspected production source: `e2da56a732246faf566dfd2d3e7709fd41bcf516`.
This report changes no production behavior, contract, permissions or capability.
All new evidence is keyless, uses fictional Odyssey facts and scripts inference.
There were zero actual-provider calls, microphone recordings or device samples.

The [continuous-conversation policy](../decisions/live-conversation.md#continuous-conversation-and-audible-recovery--2026-10-29)
landed during this investigation in `0a937999254710032ea77ade56550e141e3fff16`.
It requires preserving capture/context across ordinary interruption/recovery;
it changes three documentation files and no runtime input. The Stop/Resume
observations below characterize the inspected shipped source, not the selected
future behavior. #3053 owns that production implementation; this report makes
no capture-policy or runtime change.


> **2026-10-29 — Retained-result correction.** The source trace and absence
> receipts below describe the inspected commit, with verified immutable source
> links. #3141 adds [bounded historical host results](../integration-contract/wire.md#live-conversation-additive-957)
> to replacement/resumed sessions on both engines. The active browser witness
> now requires exact retained fact bytes; the original failing-first absence
> remains historical evidence. This correction supplies no actual-model recall
> or listening qualification.

The #3053 client implementation supersedes the historical Stop/Resume behavior.
Current regressions distinguish a local output cut (same epoch, capture retained)
from an actual provider closure (automatic same-scope recovery with the retained
host facts delivered by #3141). The original Stop/Resume and missing-fact
observations below remain evidence on their immutable recorded source.

## Causal result

A replacement speech epoch has no copy of the completed research answer. The
host gives the adapter receipt state and request text; both first-party adapters
serialize that information, without result facts. The browser can retain and
display an answer that the replacement voice session never received. This is
a demonstrated information loss, independently of semantic model recall.
[#3141](https://github.com/schlessera/brain-kit/issues/3141) owns the scoped
bounded result-retention and resynchronization correction; no production fix
is included in this spike.

It is a plausible explanation for the reported Gemini follow-up only if a
replacement occurred. No correlated trace exists for the reported session, so
its cause remains unknown. GPT-Live's live behavior for that report is untested.

The separate same-epoch path supplies the exact bounded backend text to the
exact native handle. Gemini's send establishes unknown acceptance. GPT's
correlated append acknowledgements establish transport acceptance. Neither
establishes model comprehension, generated speech, physical audibility or later
use of the fact.

## Source trace and evidence boundaries

1. The host concatenates all observed `text_delta` text, including any progress
   prose, within a 4,000-character limit (`private hostWork`,
   [packages/ui-server/src/ws/conversation.ts lines 776–808](https://github.com/schlessera/brain-kit/blob/e2da56a732246faf566dfd2d3e7709fd41bcf516/packages/ui-server/src/ws/conversation.ts#L776-L808)). Overflow retains 3,999
   characters plus an ellipsis (`function bounded`,
   [packages/ui-server/src/ws/conversation.ts lines 138–140](https://github.com/schlessera/brain-kit/blob/e2da56a732246faf566dfd2d3e7709fd41bcf516/packages/ui-server/src/ws/conversation.ts#L138-L140)). A conclusion after the
   bound can be visible in ordinary chat yet absent from voice facts. This is
   the existing documented bound, not evidence of an empty result or a newly
   introduced truncation bug. No semantic summarization occurs.
2. Completed/error work passes current epoch, connection authorization, turn
   identity and native binding checks before handover. Success uses `when-idle`;
   error uses bounded reason text and `quiet` (`private deliver`,
   [packages/ui-server/src/ws/conversation.ts lines 845–902](https://github.com/schlessera/brain-kit/blob/e2da56a732246faf566dfd2d3e7709fd41bcf516/packages/ui-server/src/ws/conversation.ts#L845-L902)). No host audio-idle check
   delays this handover; provider scheduling and client playback are separate.
3. Gemini sends `host_task`'s exact function id, completed/error output,
   `WHEN_IDLE`/`SILENT` and `willContinue:false` (`async returnWork`,
   [packages/ui-server/src/voice/gemini-conversation.ts lines 266–276](https://github.com/schlessera/brain-kit/blob/e2da56a732246faf566dfd2d3e7709fd41bcf516/packages/ui-server/src/voice/gemini-conversation.ts#L266-L276)). In contextual
   mode it reports unknown acceptance. GPT sends exact `delegation_id` chunks
   with matching append acknowledgement tracking (`async returnWork`,
   [packages/ui-server/src/voice/gpt-live-conversation.ts lines 252–283](https://github.com/schlessera/brain-kit/blob/e2da56a732246faf566dfd2d3e7709fd41bcf516/packages/ui-server/src/voice/gpt-live-conversation.ts#L252-L283)); UTF-8 chunks
   are at most 500 bytes (`function chunks`,
   [packages/ui-server/src/voice/gpt-live-conversation.ts lines 49–59](https://github.com/schlessera/brain-kit/blob/e2da56a732246faf566dfd2d3e7709fd41bcf516/packages/ui-server/src/voice/gpt-live-conversation.ts#L49-L59)). Quiet thinking
   precedes the final commentary chunk. No acknowledgement proves speech.
4. Replacement passes only receipt copies (`resync: { work:`,
   [packages/ui-server/src/ws/conversation.ts lines 253–253](https://github.com/schlessera/brain-kit/blob/e2da56a732246faf566dfd2d3e7709fd41bcf516/packages/ui-server/src/ws/conversation.ts#L253)). Durable recovery also
   reconstructs work with empty facts (`for (const receipt`,
   [packages/ui-server/src/ws/conversation.ts lines 169–169](https://github.com/schlessera/brain-kit/blob/e2da56a732246faf566dfd2d3e7709fd41bcf516/packages/ui-server/src/ws/conversation.ts#L169)). Neither retained output
   records nor ordinary backend history is passed as result context to these
   voice sessions.
5. Gemini sends historical state plus `(recognized || submitted).slice(0,500)`
   (`if (options.resync.work.length)`,
   [packages/ui-server/src/voice/gemini-conversation.ts lines 168–172](https://github.com/schlessera/brain-kit/blob/e2da56a732246faf566dfd2d3e7709fd41bcf516/packages/ui-server/src/voice/gemini-conversation.ts#L168-L172)). GPT constructs
   the same request-only history (`const history`,
   [packages/ui-server/src/voice/gpt-live-conversation.ts lines 122–127](https://github.com/schlessera/brain-kit/blob/e2da56a732246faf566dfd2d3e7709fd41bcf516/packages/ui-server/src/voice/gpt-live-conversation.ts#L122-L127)). Histories
   take at most 64 receipts and a 4,000-character text prefix. A completed
   receipt establishes completion of a request, not what its answer was.
6. Explicit Stop reply closes the current epoch and clears capture consent
   (`function stopReply`,
   [packages/ui-react/src/voice/conversation-client.ts lines 292–299](https://github.com/schlessera/brain-kit/blob/e2da56a732246faf566dfd2d3e7709fd41bcf516/packages/ui-react/src/voice/conversation-client.ts#L292-L299)). Its stopped
   receipt starts a replacement while capture remains off (`if (message.reason === "stopped")`,
   [packages/ui-react/src/voice/conversation-client.ts lines 394–396](https://github.com/schlessera/brain-kit/blob/e2da56a732246faf566dfd2d3e7709fd41bcf516/packages/ui-react/src/voice/conversation-client.ts#L394-L396)); Resume restores
   capture. The same stop function is also reached by the existing audible
   interruption path. This investigation exercises explicit Stop/Resume and
   makes no claim to qualify ordinary speech interruption; #3053 and #3109
   own its behavior and policy.

## Deterministic witnesses

The two `research-result evidence` browser cases in
`packages/ui-react/tests/browser/conversation-contextual.offline.tsx` run the
actual React client, PCM capture/playback, socket handlers, host, both production
voice adapters, real loopback WebSockets, production Claude runner with scripted
inference, and the real host read/application bridge. The fixed inference peer
has no model, and synthetic PCM is not human speech recognition.

The result fact, **“The departure signal is a bronze owl.”**, is absent from
initial voice configuration and the initiating backend prompt. Separate
identity/completion barriers hold the backend while two foreground exchanges
continue. Releasing the barrier returns exact note bytes plus the fixture's
completion sentence. The test correlates conversation/epoch, task/request/turn
and native handle and compares rendered backend text with returned bytes.

After scripted result narration and local playback drain, two later recognition
messages refer to the result without repeating it:
“What is it made of?” and “Which animal does the departure signal depict?”
The first scripted reply deliberately says “I do not know.” despite transport
acceptance; this is the negative control against treating acknowledgement as
comprehension. The second scripts the fact and PCM output. Generated text and
local playback are observed separately. The original Stop/Resume witness cut
playback with the spoken portion unknown and replaced the epoch. The current
#3053 regression first proves Stop reply retains capture and allows subsequent
playback in the same epoch, then uses a real provider-closure event to exercise
replacement without manual Resume. The historical witness retained UI output
but found no “bronze owl” in the replacement provider context. With #3141, the
current combined regression requires the exact bounded host-result bytes in
both replacement histories while retaining UI output. The task and result are
each dispatched once. This is a byte/lifecycle witness, not a passing semantic
recall trial.

`research result bounds keep only the prefix` in
`packages/ui-server/tests/ws-conversation.test.ts` independently releases a
deferred answer whose novel conclusion follows the bound. Ordinary backend
frames retain the whole answer; provider facts contain exactly 3,999 prefix
characters plus the ellipsis. Replacement resync has its completed request
receipt but no conclusion, and does not start another backend turn.

The surrounding adapter/host suites retain negative controls for cancellation,
withdrawal, duplicate and unrelated handles, old epochs, cross-conversation
results, refused tasks, authorization loss and failed/ambiguous delivery. GPT's
missing/mismatched acknowledgement cases do not retry effects. These controls
prove fencing and delivery classification, not absence of every recall defect.

## Proof receipts

The intended replacement-fact assertion was run before any production fix:
changing the witness to require `bronze owl` in replacement input failed both
engine cases on that exact assertion. Gemini's actual input was
`Historical host outcomes (context only; do not repeat work): Previous task completed: Find the departure signal note.`
GPT's was
`Historical host outcomes; do not replay: Previous task completed: Find the departure signal note.`
The other thirteen browser cases passed. The committed characterization asserts
this known omission; #3141 must reverse it when delivering retained facts.

A temporary mutation changed completed `deliver` facts to the fixed string
`Altered fictional result.` The focused host test failed its exact facts
comparison, receiving that string instead of the bounded research bytes. The
mutation was restored byte for byte; no production-source diff remains.

Reproduction commands use the repository offline guards and pinned browser:

```sh
bun run test packages/ui-server/tests/ws-conversation.test.ts packages/ui-server/tests/gemini-conversation.test.ts packages/ui-server/tests/gpt-live-conversation.test.ts
node scripts/visual.mjs --project=ui-react-layout --filter=conversation-contextual.offline
bun run typecheck
bun run check:pr --base origin/main
```

The restored browser file passed all fifteen cases, including both new
characterizations (66.53 seconds total). The complete focused host/adapter run
passed 225 tests. Strict typecheck and the full workspace build passed. These
are local source/runtime receipts, not current-head hosted candidate proof.
No provider-history input changed and no package files ship from this diff;
there is no contract update or changeset in the spike.

## Actual-provider boundary

For both Gemini `gemini-3.8-live`/Kore and GPT-Live `gpt-live-1`/marin, same-epoch
semantic recall, spoken pronoun/topic resolution, ordinary audible interruption,
reconnect recall and physical audibility are **untested in this investigation**.
Gemini's reported ordinary-use failure remains user-reported, without an
attributable epoch trace. GPT has no new live observation either way. Historical
concurrency qualification in #961 is not a recall result on this source.

The exact missing evidence remains with
[#961](https://github.com/schlessera/brain-kit/issues/961): run the distinctive
fact scenario independently on each engine under its existing bounded access
and accounting workflow, hold the real backend through two foreground exchanges,
return its result, then ask the two non-restating references. Repeat with
intentional audible interruption and a separately identified reconnect/replacement.
Correlate sanitized host/native/epoch identities and exact handed-over bytes with
provider receipt or unknown acceptance, generated text, local playback and the
maintainer's actual listening observation. Record pass/fail/unknown per cell;
exclude initial-context leakage and scripted answers as semantic evidence.
This report authorizes no paid experiment and does not close #3131.
