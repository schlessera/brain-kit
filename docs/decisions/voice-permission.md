# Decision — a voice conversation may refuse a tool, never grant one

What happens when the agent needs permission to run a tool and the person it is
talking to is not looking at a screen. Answers issue #55; binds the voice epic
(#54) and the containment unit of the async-collaboration epic (#51). Nothing
here is built yet — this is the design record the build is held to.

## Summary

Voice is a **modality on an ordinary turn**, not a second permission model. Two
rules, and the second is the one that matters:

1. **A voice turn runs under a declared, narrower allowlist** — the *voice
   posture* — chosen in advance and named in source, not assembled per call.
2. **The voice channel may deny; it may never grant.** A spoken refusal resolves
   a pending request immediately. A spoken approval is never accepted, for any
   tool, at any payload size. The approval card stays the only surface that can
   grant, and a request that has no reachable card is denied rather than parked.

Rule 1 makes approvals nearly absent from the workload voice is for; rule 2 is
what makes rule 1 load-bearing rather than cosmetic, because a tool outside the
posture becomes *ungrantable* rather than *merely prompted*.

The consequence for the epic: **the model never has to interrupt to collect a
decision.** That removes the model-initiated blocking turn from #54 entirely,
which is the largest thing this answer changes.

## The question

The permission bridge asks the user to approve a tool call before it runs
(`packages/ui-sdk/src/server/permission-gate.ts:94-105`). In chat the user is
looking at a card: the transcript copy in
`packages/ui-react/src/components/chat/tool-call-timeline.tsx:317-355`, the
Actions copy in `packages/ui-react/src/components/activity/approval-card.tsx`,
both with the focus-scoped `a` / `d` keys D36 settled
(`docs/decisions/design-kit.md:1795`). A spoken conversation has no card, so
either the model speaks the request and waits, or voice runs under a posture
that needs no interactive approval, or voice is read-only.

Voice today is tap-to-dictate: the speech contract mints a **dictation** session
(`packages/ui-sdk/src/server/speech.ts:20`) and
`packages/ui-react/src/voice/use-dictation.ts:26` drives it into the composer.
There is no voice output and no spoken turn, so nothing in this record describes
existing behaviour.

## What actually gets asked for

Not argued — replayed. 208 recorded agent sessions (16,480 tool calls, every
`tool_use` in the transcripts) were run through the **actual exported policy
functions**: `decideToolPermission` with `DEFAULT_ALLOWED_TOOLS`
(`packages/ui-backend-claude/src/tool-policy.ts:17`), the five bridge tools the
backend appends per turn (`packages/ui-backend-claude/src/sdk-options.ts:44-59`)
and `DEFAULT_CONFIRM_BASH_PATTERNS`
(`packages/ui-sdk/src/server/confirm-patterns.ts:21`). Tools that exist only in
the recording harness and have no counterpart in this product were excluded from
the denominator rather than counted as approvals a real session could not raise.

**How often a session asks:**

| | all 208 sessions | knowledge-base cohort (112) | repo-work cohort (12) |
| --- | --- | --- | --- |
| tool calls | 16,480 | 1,375 | 3,246 |
| approvals raised | 192 | 6 | 70 |
| share of tool calls | 1.17% | 0.44% | 2.16% |
| sessions with **zero** approvals | 82.7% | **98.2%** | 33.3% |
| mean / median per session | 0.92 / 0 | 0.05 / 0 | 5.83 / 5 |
| p90 / p99 / max | 2 / 15 / 32 | 0 / 1 / 5 | 13 / 24 / 24 |

**What kind of approval:** 192 of 192 were kind `command` — a Bash command
matching a confirm pattern. **Zero** were kind `tool`. That is not an accident of
the corpus, it is the policy: everything the model reaches for is on
`DEFAULT_ALLOWED_TOOLS` already, and the only tool deliberately left off it is
`mcp__brain__brain_archive` (`tool-policy.ts:34`). The "always allow" path —
the whole grantable-tool mechanism, and the one thing the client hides for
`command` requests — is **almost never exercised in practice**.

**What the payload looks like**, over those 192 commands:

| | median | p90 | max |
| --- | --- | --- | --- |
| characters | 638 | 2,376 | 12,928 |
| lines | 8 | 44 | 360 |
| written words | 67 | 320 | 1,339 |

114 of 192 (59%) were multi-line. Punctuation was 15.9% of all characters —
every one of which a listener has to hear spoken ("dash dash", "slash", "pipe")
to reconstruct the command they are being asked to approve.

**What it sounds like.** Three phrasings were built over the shortest, median,
p90 and longest of those payloads and synthesized with a local neural TTS voice
(piper, `en_US-lessac-medium`). Measured durations of the rendered audio:

| phrasing | shortest | median | p90 | longest |
| --- | --- | --- | --- | --- |
| **A** — the command read out verbatim | 16 s | **118 s** | 219 s | **1,585 s** (26 min) |
| **B** — the *effect* named, payload not read | 10 s | 10 s | 10 s | 12 s |
| **C** — the tool name only ("permission to use Bash?") | 2 s | 2 s | 2 s | 2 s |

### What the numbers decide

- **A is dead.** A median approval request takes two minutes of speech and the
  worst takes twenty-six. No amount of prompt tuning moves that: it is the
  payload, and the payload is what the user would have to verify.
- **C is worse than dead.** Two seconds, and it conveys nothing a person can
  base a security decision on. "Permission to use Bash?" answered by voice is
  consent to an unseen payload — the failure this record exists to prevent,
  dressed as a feature.
- **B is the only speakable form**, and it is flat in the payload size because
  it is derived from the *pattern that matched*, not from the command. That
  makes it cheap — and it also makes it non-verifying: the listener learns what
  class of thing will happen, never which thing.
- **The rarity is real.** In the workload voice is actually for — talking to
  your own knowledge base — 98.2% of sessions raise no approval at all, and the
  ones that do raise one. A permission model that refuses to grant by voice
  costs almost nothing there. In repo work it costs a great deal, which is the
  honest reason repo work is not what a voice conversation is for.

### What the corpus does not prove

The transcripts are coding sessions recorded by a CLI harness, not brain-ui
conversations, and that harness is configured to prefer `Bash` over the file
tools — 12,793 of the 16,480 calls are Bash. Two directions of bias, named
rather than corrected:

- It **over-states** the approval rate, because every measured approval is a
  Bash confirm-pattern hit and Bash is over-represented. The knowledge-base
  cohort is the closer proxy and it is the one with 98.2% silent sessions.
- It **under-states** the tool-approval count, because the brain MCP tools are
  absent from it entirely. In this product `brain_archive` is a real card that
  the corpus cannot show.

Neither direction touches the finding that decides the question, which is the
payload length, and that is a property of shell commands rather than of the
corpus.

## The voice posture

The tool set a voice turn runs under. Declared as a named list beside
`DEFAULT_ALLOWED_TOOLS`, with a reason per entry — "safe tools only" is not a
posture, it is a wish.

**Allowed:**

| Tool | Why it is in |
| --- | --- |
| `mcp__brain__brain_search` | Read-only query over the user's own documents. The primary reason to talk to a brain at all. |
| `mcp__brain__brain_context` | Read-only context assembly. Same class as search; it is how a question gets an answer with sources. |
| `mcp__brain__brain_read` | Read-only, one document. |
| `mcp__brain__brain_list` | Read-only enumeration. |
| `mcp__brain__brain_graph` | Read-only. |
| `mcp__brain__brain_add` | Creates a new document. The single most valuable eyes-free action there is — capture. A create destroys nothing: the worst case is a document the user did not want, which appears in Files and is removable. |
| `mcp__brain__brain_update` | Edits an existing document. "Add this to my note about X" is the second most valuable eyes-free action. It is the one entry here that can lose prior content; it is recoverable because the content repo is git, and it goes through the frontmatter/index path rather than raw bytes. |
| `Read`, `Glob`, `Grep` | Read-only over the brain repo, for the questions the brain tools do not cover. No mutation, no egress. |
| `WebSearch`, `WebFetch` | Read-only egress. Kept, with the exposure stated below. |
| the bridge tools, minus the mask editor | `ask_user`, `get_current_location`, `query_activity`, `show_block` are auto-allowed today and none of them is a permission decision (`sdk-options.ts:44-59`). `request_image_mask` needs the user to paint a region, so it needs eyes; it is out. |

**Excluded, each for its own reason:**

| Tool | Why it is out |
| --- | --- |
| `Bash` | 192 of 192 measured approvals came from it, and its payload is the unspeakable one (median 118 spoken seconds). Removing it removes the problem instead of narrating it. This is the whole of the cost of the voice posture, and it is deliberate. |
| `Write`, `Edit`, `NotebookEdit` | Raw byte writes to arbitrary paths. The brain document tools cover the legitimate eyes-free write and keep frontmatter and the search index correct; these do not. |
| `Agent` | A subagent's own `Bash` / `Edit` / `Write` calls surface under their own names and are gated individually (`tool-policy.ts:51-56`). In a voice turn they would each be denied, one at a time, inside work the user cannot see. A subagent crippled halfway through is worse than no subagent. |
| `Skill` | Skills orchestrate and the CLI executes (`AGENTS.md`). A skill without `Bash` fails partway through with side effects already written. |
| `LSP` | No eyes-free use. Out for want of a reason to be in, not for danger. |
| `mcp__brain__brain_archive` | The one visibility change in the brain tool set, deliberately kept off the auto-allow list, and the one action here whose damage is invisible later — an archived document simply stops appearing, with nothing pointing at why (`confirm-patterns.ts:22-27`). It keeps its card. |

**`WebSearch` / `WebFetch`, stated plainly.** They pull content an attacker may
control into a turn that can write documents. That exposure is identical to the
one an ordinary chat turn already accepts, and in a voice turn the blast radius
is smaller than in chat, because `brain_add` / `brain_update` are the only
writes reachable and both land visibly in Files and in git. They stay in. The
place that exposure is not acceptable is an **unattended** turn, where nobody is
listening — which is #51's posture, not this one, and is exactly where the two
postures are expected to differ.

## What the user hears, and how a decision is expressed

**The announcement is form B, and it never reads the payload.** It is derived
from the confirm pattern that matched, which is a closed set of six
(`confirm-patterns.ts:21-36`), so each pattern carries the effect it has in
words:

| pattern | spoken as |
| --- | --- |
| `brain archive` | "archive a document, which takes it out of search and briefings" |
| recursive `rm` | "delete a directory and everything inside it" |
| `git push --force` | "force-push, overwriting history on the remote" |
| `git reset --hard` | "discard every uncommitted change in the working tree" |
| `git clean -f` | "delete untracked files from the working tree" |
| `git checkout --` | "discard changes to specific files" |

Ten seconds, flat in the payload. The announcement says what class of thing is
about to happen, says that the command itself is on screen, and offers the one
answer voice can give:

> "Before I go on — I want to force-push, overwriting history on the remote. I
> can't read the command out; it's on screen. Say *brain, stop* if you'd rather
> I didn't."

**Only a refusal is a spoken decision.** The asymmetry is the whole design: a
false positive on refusal loses a tool call the user could have allowed, and is
repaired by saying "go ahead, try that again"; a false positive on approval is a
security failure that cannot be repaired at all. Speech recognition is the least
verifiable input this product has, so it is given only the answer whose failure
mode is recoverable.

Three properties the refusal phrase must hold, and they are the voice analogue
of what D36 already settled for single keys:

- **Two words, not one.** "No" and "stop" occur constantly in ordinary speech,
  including in the middle of a sentence addressed to the model. A bare
  affirmative or negative must never resolve a pending request.
- **Scoped to the pending window.** The phrase is recognised *only* while a
  request is actually pending, the way `a` and `d` act only while the card they
  belong to holds focus (D36). Outside that window it is ordinary transcript
  text.
- **Never a grant.** There is no spoken counterpart. The phrase set has one
  member.

**What the screen shows: the same card, unchanged.** Voice does not replace the
approval card and does not get a card of its own. Somebody is often looking, and
when they are, they grant the way they always have — `a` / `d` on the focused
card, "Always allow" where the kind permits it. The voice channel is an
announcement plus one refusal, layered over a surface that already works.

**Silence is the safe default, and it costs nothing new.** An unanswered request
stays pending exactly as it does today, and the turn ends on the host's turn
budget. That is already fail-closed: nothing runs. The user hears nothing
further, because a model that nags about a request the user ignored is worse
than one that lets the turn lapse. When the turn lapses, the model says so once
— "I stopped; the thing I needed to run is still waiting on the Actions page."

**Ambiguity is denial, explicitly.** A partial match, a low-confidence
transcript, an overlapping speaker, a refusal phrase heard while two requests
are pending — every one of them resolves as `deny`, and the user hears that it
was taken as a refusal. There is no "did you mean" round trip: a clarification
exchange over a security decision is a second chance for noise to produce a
grant.

**"Always allow" cannot be given by voice.** It is a persistent policy change
(`packages/ui-server/src/ws/dispatch.ts:177-178`) and it is the one decision on
the card with no keyboard shortcut, by D37's ruling 5 — a decision the design
already judged too consequential for a single keystroke is not one to hand to a
microphone. This costs nothing measurable: the server already refuses `always`
for kind `command` requests (`dispatch.ts:177`, `ws/bridge.ts:90-98`), and 192
of 192 measured approvals were kind `command`.

## How a spoken decision is audited

An approval given by voice must be as reviewable afterwards as one given by
tapping a card. Most of that already exists: every decision is written as an
append-only `approval_decision` event carrying the principal, the decision and
the request kind, and it patches the span
(`packages/ui-server/src/activity/recorder.ts:310-325`), fed from the bridge's
`recorded()` wrapper (`packages/ui-server/src/ws/bridge.ts:139-154`).

One thing is missing and is a follow-up: **the event does not record the
modality.** A denial decided by a phrase a microphone heard and one decided by a
finger on a button are indistinguishable in the record, and they carry very
different confidence. The `approval_decision` event gains the channel the
decision arrived on. Since voice can only deny, a voice-attributed *grant* in
the record is by construction a bug — which makes the field a detector, not just
provenance.

The wire needs nothing new: a spoken refusal is an ordinary `tool_denial`
(`packages/ui-server/src/ws/dispatch.ts:193-203`) with a message naming the
phrase that produced it.

## Containment: shared with #51, deliberately not identical

**Same mechanism. Different membership. On purpose.**

The mechanism is the one the repo already has: a declared tool allowlist bound
to a turn — `InferenceProfile.allowedTools`
(`packages/ui-backend-claude/src/profiles.ts:23`) and
`ClaudeBackendOptions.allowedTools` (`options.ts:46-47`), resolved into the
SDK's `allowedTools` per turn (`sdk-options.ts:44,97`). The voice posture is one
named entry in that mechanism. #51's restricted execution profile (its U15, on
that epic's critical path) must be another. **If U15 invents a second gate, that
is the two-containment-models failure #54 named, and this record is the place
that says so in advance.**

The memberships differ because the threats differ, and conflating them would
make both worse:

| | voice posture (#55) | restricted profile (#51) |
| --- | --- | --- |
| the threat | the *decision channel* is unverifiable; a grant could be manufactured from ambient noise | the *input* is untrusted; an attacker's content is being processed |
| who is present | a person, listening, unable to see | nobody |
| what must not happen | consent without comprehension | exfiltration or destruction driven by fetched content |
| `WebSearch` / `WebFetch` | in — a listening user is the mitigation, and the exposure equals chat's | probably out — that is precisely the untrusted input |
| escalation to a human | synchronous, on the card already on screen | asynchronous, via the Action the plan describes |

The single requirement this record places on #51: express the restricted profile
as a **declared allowlist bound to a turn**, so the two postures differ only in
which named set a turn names. The second requirement is the fail-closed
primitive below, which both need and neither has.

## What has to exist that does not

One mechanism is missing, and both postures need it. Today, a tool outside the
allowlist does not *fail* — it **asks** (`permission-hooks.ts:51-95`), and in a
turn with no reachable grant surface that ask parks until the turn budget
expires. `requestToolPermission` already fails closed when there is **no
bridge** at all (`permission-gate.ts:98-103`); what is missing is the same
behaviour when the bridge exists but has no way to grant. A turn must be able to
declare that it has no grant surface, and a `tool` request in such a turn
resolves `deny` immediately with a reason the model can act on and the user can
hear. Without it, "not in the posture" means "prompts anyway", and the posture
is decoration.

## What this constrains in #54

Stated as consequences, because that is what the epic asked for.

1. **The model-initiated blocking turn is gone.** The announcement is one-way:
   the model never hands over the floor and waits for a decision, because there
   is no decision it can collect. Turn-taking can be designed entirely for
   user-initiated turns — silence detection, barge-in and the rest apply to the
   user's speech, not to a special approval mode. This is the largest narrowing
   this spike produces, and it removes the reason the epic gave for why question
   3 had to be answered first.
2. **One mid-turn recognition requirement, and it is small.** A two-word refusal
   phrase, recognised only while a request is pending, over an ASR stream that
   is already open. That is a scoped keyword spotter, not a turn. It does not
   need endpointing, it does not need a wake word, and its accuracy bar is
   "must not systematically miss the phrase" rather than "must not mishear" —
   because mishearing it denies something, which is safe.
3. **Question 2 (the TTS provider) is not made harder.** The announcement is
   ten seconds of text drawn from a closed set of six phrases. It imposes no
   requirement an output seam would not already have, so the approval answer
   does not pre-decide the provider argument.
4. **Voice is read-mostly, not read-only.** The epic offered a read-only answer
   that would have shrunk it a lot. That is not the answer: capture
   (`brain_add`) is the most valuable eyes-free action and it is a write. #54
   shrinks in a different place — its approval half goes away, its conversation
   half does not.
5. **The definition of done still holds, and means something narrower.** "A
   spoken exchange of several turns, including at least one that needed
   permission, where the permission decision was made in a way the threat model
   still stands behind" is satisfied by a turn that announces, hears nothing,
   and lapses — or by one that hears the refusal phrase and denies. It is *not*
   satisfied by a spoken grant, because there is no such thing.
6. **`ask_user` is the model's channel for everything else.** A question is an
   exchange (D38, ruling 1) and it is not a permission decision. How
   `AskUserCard` behaves in a spoken conversation is a real question and it is
   #54's, not this record's.

## Alternatives rejected

**(a) The model speaks the request and waits for a spoken decision.** Rejected
on the measurement: the median request is 118 seconds of synthesized speech and
the longest is 26 minutes. The short forms that fit in a conversation (B at 10 s,
C at 2 s) do not carry the payload, so approving one is consent to something the
user has not perceived — a security decision made in the least verifiable
modality the product has, about content the modality did not transmit. The half
of (a) that survives is the announcement, and the refusal, both of which this
record keeps.

**(b) A narrower posture, and nothing else.** A posture alone does not answer the
question, because a tool outside the allowlist currently prompts rather than
fails. Without the fail-closed rule, the first tool the model reaches for
outside the posture reopens (a) in the middle of a conversation. (b) is half the
answer and is adopted as such.

**(c) Voice is read-only.** The cheapest answer and the one the epic was
prepared to accept. Rejected because it removes the thing voice is *for*: saying
"add a note that the roof quote came in at X" while driving is capture, capture
is a write, and a read-only voice mode is a search box you talk to. The
measurement supports the narrower claim instead — the knowledge-base workload
raises an approval in 1.8% of sessions, so allowing the two document writes
costs almost no approvals while restoring the whole use case.

**(d) A payload-length threshold — speak short payloads, refuse long ones.**
Rejected outright. Length is attacker-controlled and is not a security boundary;
a short payload is not a comprehensible one (`rm -rf ~/x` is nine characters);
and a rule that sometimes grants by voice is a rule the user cannot hold in
their head, which means they will guess, which means they will guess yes.

## Deliberately left open

**A spoken grant for `brain_archive`.** It is the one non-auto-allowed brain
tool, its entire input is a document identifier a listener can hear and check
("archive *meeting notes, September fifteenth*?"), and it is the one place a
spoken grant would be genuinely verifiable. It is still refused in v1, because
admitting it requires a per-tool "this payload is speakable" declaration, that
declaration is a seam, and ROADMAP binding decision 2 does not buy a seam for
one caller. The test it must pass to be revisited: a second tool that needs the
same declaration. Until then, archiving by voice means the model says it is
waiting and the card is answered on a screen.

**Whether the voice posture should also be the phone posture.** A phone in a
pocket and a phone in a hand are different, and nothing here measures the
difference. Out of scope for #55.
