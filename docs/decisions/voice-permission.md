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
(`requestToolPermission`, `packages/ui-sdk/src/server/permission-gate.ts:254-286`).
In chat the user is
looking at a card: the transcript copy in
(`Approval buttons`,
`packages/ui-react/src/components/chat/tool-call-timeline.tsx:325-367`), the
Actions copy in `packages/ui-react/src/components/activity/approval-card.tsx`,
both with the focus-scoped `a` / `d` keys D36 settled
(`D36: single-key shortcuts are focus-scoped`,
`docs/decisions/design-kit.md:1842`). A spoken conversation has no card, so
either the model speaks the request and waits, or voice runs under a posture
that needs no interactive approval, or voice is read-only.

Voice today is tap-to-dictate: the speech contract mints a **dictation** session
(`SpeechProvider`, `packages/ui-sdk/src/server/speech.ts:26`) and
`useDictation`, `packages/ui-react/src/voice/use-dictation.ts:26`
drives it into the composer.
There is no voice output and no spoken turn, so nothing in this record describes
existing behaviour.

## What actually gets asked for

Not argued — replayed. 208 recorded agent sessions (16,480 tool calls, every
`tool_use` in the transcripts) were run through the **actual exported policy
functions**: `decideToolPermission` with `DEFAULT_ALLOWED_TOOLS`
(`DEFAULT_ALLOWED_TOOLS`, `packages/ui-backend-claude/src/tool-policy.ts:26`), the
six bridge tools the backend appends per turn (the `allowed.push` block in
`createClaudeSdkTurn`, from `const allowed`,
`packages/ui-backend-claude/src/sdk-options.ts:79-95`)
and `DEFAULT_CONFIRM_BASH_PATTERNS`
(`DEFAULT_CONFIRM_BASH_PATTERNS`, `packages/ui-sdk/src/server/confirm-patterns.ts:49`).
Tools that exist only in the recording harness and have no counterpart in this
product were excluded from
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

The two cohorts are **subsets of the 208, not a partition of it** — they are the
knowledge-base repo and this repo, picked because they bracket the workload — so
their rows do not sum to the first column.

**What kind of approval:** 192 of 192 were kind `command` — a Bash command
matching a confirm pattern. **Zero** were kind `tool`. That is not an accident of
the corpus, it is the policy: everything the model reaches for is on
`DEFAULT_ALLOWED_TOOLS` already, and the only tool deliberately left off it is
`mcp__brain__brain_archive` (`Deliberately absent`, `tool-policy.ts:43-44`).
The "always allow" path —
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
  payload, and the payload is what the user would have to verify. Note what this
  does and does not establish. The measurement proves only that **the payload
  cannot be spoken**; that a spoken grant must therefore be refused is a
  judgment laid on top of it — that consent to a payload the listener has not
  perceived is not consent. The measurement removes the option of reading it to
  them; the judgment is what closes the remaining gap, and it is stated as a
  judgment rather than smuggled in as a number.
- **C is worse than dead.** Two seconds, and it conveys nothing a person can
  base a security decision on. "Permission to use Bash?" answered by voice is
  consent to an unseen payload — the failure this record exists to prevent,
  dressed as a feature.
- **B is the only speakable form**, and it is flat in the payload size because
  it is derived from the *pattern that matched*, not from the command. That
  makes it cheap — and it also makes it non-verifying: the listener learns what
  class of thing will happen, never which thing.
- **The rarity is real, and it is lumpy.** In the workload voice is actually
  for — talking to your own knowledge base — 110 of 112 sessions raised no
  approval at all. The other two raised all six between them: one raised a
  single approval and one raised five. So a permission model that cannot grant
  by voice costs nothing in 110 sessions, one thing in one, and five things in
  one. That is still the argument for the decision and it is the true shape of
  it; "the ones that do raise one" would have been the convenient version. In
  repo work the cost is much higher, which is the honest reason repo work is not
  what a voice conversation is for.

### What the corpus does not prove

The transcripts are coding sessions recorded by a CLI harness, not brain-ui
conversations, and that harness is configured to prefer `Bash` over the file
tools. The whole distribution, because the bias claim is worth being checkable
rather than asserted:

| tool | calls |
| --- | --- |
| `Bash` | 12,793 |
| `Edit` | 1,639 |
| `Read` | 974 |
| `Write` | 411 |
| `Agent` | 398 |
| `WebSearch` | 96 |
| `Skill` | 94 |
| `WebFetch` | 71 |
| `Grep` | 2 |
| `Glob` | 1 |
| `mcp__brain-ui__show_block` | 1 |
| **total** | **16,480** |

Two directions of bias, named rather than corrected:

- It **over-states** the approval rate, because every measured approval is a
  Bash confirm-pattern hit and Bash is over-represented. The knowledge-base
  cohort is the closer proxy and it is the one with 98.2% silent sessions.
- It **under-states** the tool-approval count, because the brain MCP tools are
  absent from it entirely. In this product `brain_archive` is a real card that
  the corpus cannot show.

Neither direction touches the finding that decides the question, which is the
payload length, and that is a property of shell commands rather than of the
corpus.

**And the citations go stale.** This record's evidence is `file:line`, which
prose is not, and it drifted in eleven days: between the branch's base and its
merge, sixteen of thirty-six pointers moved and three came to describe code that
says the opposite of what they were cited for — because the work this record
asked for shipped. That is the good case. Anyone rereading this months from now
should check the pointers before trusting a claim built on one, and anyone
changing the permission path should expect to correct this file in the same PR.

That obligation is not only about time passing. **A PR that moves the lines
under a citation invalidates it at merge, and owns it**, even when everything
the PR changed is correct and nothing it wrote is wrong — inserting a comment
above a cited block is enough. The failure is quiet in the worst way: a pointer
does not break, it silently comes to name the neighbouring code, and a reader
following a citation to `tool_denial` can land inside `tool_approval` without
anything looking amiss. Where a line range is doing no work beyond locating a
symbol, prefer naming the symbol and letting the range follow it, so a drifted
pointer is recoverable instead of merely wrong.

**None of this is reproducible from this repository, and that is deliberate.**
The 208 transcripts are the maintainer's own recorded agent sessions: personal
content, and `AGENTS.md`'s leakage gate has no exempt directories, so neither
the corpus nor a manifest naming it can be committed. The replay harness and the
speech-synthesis prototype were thrown away with it, which is also what issue #55
asked for. What can be re-derived from the tree is the *policy* the replay ran
against — `decideToolPermission`, `DEFAULT_ALLOWED_TOOLS` and
`DEFAULT_CONFIRM_BASH_PATTERNS` are all tested and inspectable in source. The
policy constants are implementation details under the
[backend-toolkit ruling](backend-authoring-toolkit.md); anyone with
their own transcripts can run the same measurement over their own workload and
get a comparable number. The numbers above are evidence with a stated
provenance, not a fixture.

## The voice posture

The tool set a voice turn runs under. Declared as a named list beside
`DEFAULT_ALLOWED_TOOLS`, with a reason per entry — "safe tools only" is not a
posture, it is a wish. It is `VOICE_ALLOWED_TOOLS` in
`packages/ui-backend-claude/src/tool-policy.ts` (#111), and
`tests/voice-posture.test.ts` asserts that list against the two tables below,
so a change to either one fails until the other agrees. A voice turn selects it
as its allowlist and declares both `enforceAllowedTools` and `noGrantSurface`.

**Allowed:**

| Tool | Why it is in |
| --- | --- |
| `mcp__brain__brain_search` | Read-only query over the user's own documents. The primary reason to talk to a brain at all. |
| `mcp__brain__brain_context` | Read-only context assembly. Same class as search; it is how a question gets an answer with sources. |
| `mcp__brain__brain_read` | Read-only, one document. |
| `mcp__brain__brain_list` | Read-only enumeration. |
| `mcp__brain__brain_graph` | Read-only. |
| `mcp__brain__brain_add` | Creates a new document. The single most valuable eyes-free action there is — capture. A create destroys nothing: the worst case is a document the user did not want, which appears in Files and is removable. |
| `mcp__brain__brain_update` | Edits an existing document. "Add this to my note about X" is the second most valuable eyes-free action, and the handler's shape is why it is safe enough to allow: it **never rewrites the body**, it only appends to it (`const appendTo`, `packages/core/src/lib/frontmatter-edit.ts:303-308`), so no prose can be lost. The exact bound on what it *can* destroy: the six frontmatter params are independent optionals on one call (`summary: z.string()`, `packages/core/src/mcp-server.ts:570-575`), applied independently (`params.summary !== undefined`, `:594-610`), so **a single call can overwrite all six** — and `tags` is a comma-separated string that replaces the whole tag list rather than merging into it (`tags: z.string()`, `:573`; `params.tags !== undefined`, `:597-599`), while `deadline` and `next_review` take `""` as *delete the field* (`params.deadline !== undefined`, `:601-610`). `updated` is bumped unconditionally (`updates.updated = updated`, `:624`). None of it is checkpointed, so git recovers a prior value only if the document was committed. The claim this row rests on is therefore "loses no prose, and at most the six declared frontmatter fields, recoverable only if committed" — not "recoverable". `status` is the field that matters and it is handled separately below. |
| `Read`, `Glob`, `Grep` | Read-only over the brain repo, for the questions the brain tools do not cover. No mutation, no egress. |
| `WebSearch`, `WebFetch` | Read-only egress. Kept, with the exposure stated below. |
| the bridge tools, minus the mask editor | `ask_user`, `get_current_location`, `query_activity`, `show_block` are auto-allowed today and none of them is a permission decision (the same `allowed.push` block, from `const allowed`, `sdk-options.ts:79-95`). `request_image_mask` needs the user to paint a region, so it needs eyes; it is out. |

**Excluded, each for its own reason:**

| Tool | Why it is out |
| --- | --- |
| `Bash` | 192 of 192 measured approvals came from it, and its payload is the unspeakable one (median 118 spoken seconds). Removing it removes the problem instead of narrating it. This is the whole of the cost of the voice posture, and it is deliberate. |
| `Write`, `Edit`, `NotebookEdit` | Raw byte writes to arbitrary paths. The brain document tools cover the legitimate eyes-free write and keep frontmatter and the search index correct; these do not. |
| `Agent` | A subagent's own `Bash` / `Edit` / `Write` calls surface under their own names and are gated individually (`A subagent's own`, `tool-policy.ts:152-153`). In a voice turn they would each be denied, one at a time, inside work the user cannot see. A subagent crippled halfway through is worse than no subagent. |
| `Skill` | Skills orchestrate and the CLI executes (`AGENTS.md`). A skill without `Bash` fails partway through with side effects already written. |
| `LSP` | No eyes-free use. Out for want of a reason to be in, not for danger. |
| `mcp__brain__brain_archive` | The one visibility change in the brain tool set, deliberately kept off the auto-allow list, and the one action here whose damage is invisible later — an archived document simply stops appearing, with nothing pointing at why (`Archiving is a VISIBILITY change`, `confirm-patterns.ts:50-58`). It keeps its card. Its exclusion here did not by itself close the boundary; see below. |

**The archive boundary leaked, and is now closed.** `brain_archive` is off the
auto-allow list because archiving is a visibility change. But `brain_update`
takes `status: "archived"` (`status: z.enum`, `packages/core/src/mcp-server.ts:571`;
`params.status !== undefined`, `:595`), writes it and reindexes, and search
excludes archived documents by default (`include_archived`, `mcp-server.ts:238`)
— so the visibility change `brain_archive`'s card exists to gate was reachable
through a tool that is auto-allowed in *every* surface,
chat included. `DEFAULT_CONFIRM_BASH_PATTERNS` closed the `brain archive` CLI
spelling (`\bbrain\s+archive\b`, `confirm-patterns.ts:56`) and not this one.

This was pre-existing product behaviour rather than something the voice posture
introduced. It was filed as #122 and closed by #144, which took exactly the
answer this section predicted: a `brain_update` that sets `status: "archived"`
raises its own per-use approval, from the shared `decideToolPermission`, on
both backends. So the prediction below holds as written — **in a voice turn
that approval is ungrantable and the call is therefore denied, which is the
correct outcome and needs no special case here.** An update that does not touch
`status`, or sets it to `"active"` or `"draft"`, is unaffected, so the
`brain_update` row above still stands: eyes-free appending still works.

One thing that did not change: the reason given for excluding `brain_archive`
is now a statement of enforcement as well as intent, but only for the tools
whose purpose is document management. `Write` and `Edit` can still put
`status: archived` into frontmatter directly and nothing fires. That is
deliberate — they are a different trust class, and this mechanism is a seatbelt
rather than containment (`WHAT THIS IS NOT`, `confirm-patterns.ts:39-44`)
— and it matters here
because **neither is auto-allowed in a voice turn anyway**, so the voice
posture is strictly tighter than chat on this point.

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
(`DEFAULT_CONFIRM_BASH_PATTERNS`, `confirm-patterns.ts:49-82`),
so each pattern carries the effect it has in words:

| pattern | spoken as |
| --- | --- |
| `brain archive` | "archive a document, which takes it out of search and briefings" |
| recursive `rm` | "delete a directory and everything inside it" |
| `git push --force` | "force-push, overwriting history on the remote" |
| `git reset --hard` | "discard every uncommitted change in the working tree" |
| `git clean -f` | "delete untracked files from the working tree" |
| `git checkout --` | "discard changes to specific files" |

The phrases live beside the patterns (`DEFAULT_CONFIRM_BASH_PATTERNS`, each
entry `{ pattern, effect }`, since #112), and a `command` approval's `reason` is
the matched pattern's effect, so the same words are already on the card.

**Two cases the six phrases do not cover, and the announcement must not assume
they are exhaustive.** A kind-`tool` request has no pattern at all — the
description is the SDK's own (`canUseTool` passes `description:
opts.description` straight through to `createToolPermissionRequest`,
`permission-hooks.ts:179-189`) and is not
written to be heard. And `ClaudeBackendOptions.confirmBashPatterns`
(`Regex sources`, `packages/ui-backend-claude/src/options.ts:49-59`)
lets a deployment supply its own patterns, which have no phrase when given as
bare regex sources (the `{ pattern, effect }` form carries one). Both fall
back to the same payload-free
shape, which names the tool and nothing else:

> "Before I go on — I need to use *archive a document*, and that's a decision I
> can't take by voice. It's on the screen. Say *brain, stop* if you'd rather I
> didn't."

The fallback is deliberately less informative than the six phrases and is not a
reason to skip writing a phrase: an announcement that says only "a tool" is
close enough to form C to be worthless, so a new default pattern without a
phrase is a defect, not a supported state.

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
than one that lets the turn lapse. When the budget expires the host drains every
pending approval for that turn as a denial and deletes it
(`coordinator.drainPendingForTurn`, `packages/ui-server/src/ws/run-session.ts:240` →
`drainPendingForTurn`, `packages/ui-server/src/ws/turns.ts:325-342`),
so **on the server nothing is left waiting**: the request is resolved, not
parked. The model therefore says
that it stopped and that the thing has to be asked for again, never that it is
still waiting: "I stopped without doing it. Ask me again when you can look at a
screen."

What the *client* does with the card at that moment is not established by
those two citations and is left to #54. The chat store clears a pending
approval on `tool_result`
(`packages/ui-react/src/hooks/websocket-handlers/chat.ts`), and on the timeout
path `abortController.abort()` fires before the drain
(`abortController.abort()`, `run-session.ts:235`; `drainPendingForTurn`, `:240`),
so whether a `tool_result` still streams for that tool use is a question a live
turn has to answer. It matters only for the
wording: if a dead card can survive on screen, the spoken line above is right
and the screen is wrong, and that is a client defect rather than a change to
this design.

**Ambiguity is denial, explicitly.** A partial match, a low-confidence
transcript, an overlapping speaker, a refusal phrase heard while two requests
are pending — every one of them resolves as `deny`, and the user hears that it
was taken as a refusal. There is no "did you mean" round trip: a clarification
exchange over a security decision is a second chance for noise to produce a
grant.

**"Always allow" cannot be given by voice.** It is a persistent policy change
(the block computing `remembers`, `packages/ui-server/src/ws/dispatch.ts:310-316`)
and it is the one decision on
the card with no keyboard shortcut, by D37's ruling 5, and the reason given
there is exactly the one that applies here: *"a letter that grants standing
permission by reflex is the one footgun in the vocabulary"*
(`5. Snooze`, `docs/decisions/design-feedback.md:1243-1250`).
A microphone is a reflex surface with worse recognition than a keyboard. This
costs nothing measurable:
the server already refuses `always` for kind `command` requests
(the block computing `remembers`, `dispatch.ts:310-316`, and the lookup computing
`remembered`, `ws/bridge.ts:142-162`), and 192 of 192 measured
approvals were kind `command`.

### When the announcement actually fires

Under the voice posture, now that #110 has closed the last gap, **no approval
card can arise at all**. Every tool in the posture is auto-allowed; every tool
outside it is ungrantable and therefore denied; and a kind-`command` request
comes from one of two places, both of which a turn with no grant surface denies
rather than parks: `Bash`, via the `commandAllowed` re-add described below, and
— since #144 — a `brain_update` that archives. The second is the sharper case
and it is why the refusal is the mechanism rather than the allowlist:
`brain_update` is *inside* the posture, so no narrowing reaches it, and the
confirmation it raises is answerable by nobody. "No card" is not "nothing can
stall", and the one exception named below closed with it:
`request_image_mask` used to sit inside the enforced allowlist whatever the
posture declared, so it was auto-allowed, raised no card, and blocked the turn
on a region nobody would paint; the append is now withheld from a turn that
declared no grant surface. That is the intended end state and it is worth
saying out loud, because it means the interaction above is not the common case
— it is the case that must not be got wrong.

It fires in three situations, and they are the reason the design exists rather
than an edge:

1. **A spoken decision that has already been taken.** Under the posture the
   announcement is of a denial, not of a pending request: the user asked for
   something the turn cannot do, and has to hear that it did not happen and
   why. The refusal phrase is not needed — the refusal already happened — but
   every other property holds, including that the user is told in words rather
   than left with silence.
2. **Voice on a turn that is not under the posture.** Rule 2 is a property of
   the *channel*, not of the posture: a user who starts speaking during an
   ordinary chat session, or a deployment that does not adopt the posture, gets
   a live pending card and a listener who cannot see it. That is where the
   announcement and the refusal phrase do their work, and it is why the rule is
   written as "within any turn".
3. **A turn that declares enforcement but not "no grant surface".** The
   enforcement hook answers `ask`, not `deny` — deliberately, because the
   `ask` is what beats the runtime's own shortcuts — so a tool outside the
   allowlist parks a card unless the turn also declared it has nobody to
   answer one (#110). A deployment that narrows the allowlist without making
   that second declaration gets a parked card, and the announcement plus the
   refusal phrase is how the user resolves it.

A design that only worked in case 1 would be a design for a state the product
is not in yet.

## How a spoken decision is audited

An approval given by voice must be as reviewable afterwards as one given by
tapping a card. Most of that already exists: every decision is written as an
append-only `approval_decision` event carrying the principal, the decision and
the request kind, and it patches the span
(`onApprovalDecision`, `packages/ui-server/src/activity/recorder.ts:391-406`),
fed from the bridge's
`recorded()` wrapper
(`const recorded`, `packages/ui-server/src/ws/bridge.ts:195-210`).

One thing is missing and is a follow-up: **the event does not record the
modality.** A denial decided by a phrase a microphone heard and one decided by a
finger on a button are indistinguishable in the record, and they carry very
different confidence. The `approval_decision` event gains the channel the
decision arrived on. Since voice can only deny, a voice-attributed *grant* in
the record is by construction a bug — which makes the field a detector, not just
provenance.

The wire needs nothing new: a spoken refusal is an ordinary `tool_denial`
(in `handleClientMessage`, the arm `case "tool_denial"`,
`packages/ui-server/src/ws/dispatch.ts:351-364`) with a message naming the
phrase that produced it.

## Containment: shared with #51, deliberately not identical

**Same mechanism. Different membership. On purpose.**

The mechanism is the one the repo already has: a declared tool allowlist bound
to a turn — `InferenceProfile.allowedTools`
(`allowedTools?: string[]`, `packages/ui-backend-claude/src/profiles.ts:26`) and
`ClaudeBackendOptions.allowedTools` (`Backend-wide tool allowlist`,
`options.ts:46-47`), resolved into the SDK's `allowedTools` per turn (the
`allowed` array, from `const allowed`, `sdk-options.ts:79`, and what it
becomes, `allowedTools: allowed`, `:131`). The voice posture is one
named entry in that mechanism.

**#51's U15 originally chose availability control for the same bypass reason.**
The current plan still specifies *"Tool **availability** control (`tools`) or a
measured enforced membership"*
(`- Tool **availability** control`, `docs/plans/async-collaboration.md:1171-1173`).
The plan is #51's design record. It was written before #141 and #154 measured
the runtime paths described below; those measurements strengthen the argument
for removing a tool's availability rather than leaving its execution reachable.

**Source audit, 2026-09-30 (#533):** the earlier plan's claim that pi containment
was trivial is superseded. Its resource loader and inline extension gate expose
more than the curated tool roster, so both first-party runtimes need executable
boundary proof
(`**Pi needs its own executable proof.**`, `docs/plans/async-collaboration.md:1184-1188`).
This correction does not choose a second enforcement mechanism or weaken the
voice/unattended membership requirement below.

**So this record does not require U15 to use an allowlist, and an earlier draft
of it did.** That requirement would have left two contradictory bindings
standing, which is the failure this section exists to prevent, produced by the
section. What the record requires is narrower and mechanism-agnostic:

> **One containment mechanism, two postures.** Whichever mechanism U15 settles
> on — availability control or an enforced allowlist — the voice posture must be
> expressible in it as a second named membership. A voice turn and an unattended
> turn must differ in *which set they name*, not in *how the set is enforced*.

On the merits, availability control is the better mechanism and the voice
posture should follow U15 there if U15 lands first. It removes three problems
this record otherwise has to legislate around: the runtime bypasses below stop
being reachable, the bridge-tool append stops being an exclusion nobody can
enforce, and the "announce a denial" case collapses into the model simply not
having the tool. The enforced allowlist is what exists today
(`StartTurnRequest.enforceAllowedTools`, shipped in #141), so it is what the
voice posture is specified against; that is a statement about sequencing, not a
preference. **What must not happen is the two being enforced differently**, and
naming U15's choice here is how that is prevented.

The memberships differ because the threats differ, and conflating them would
make both worse:

| | voice posture (#55) | restricted profile (#51) |
| --- | --- | --- |
| the threat | the *decision channel* is unverifiable; a grant could be manufactured from ambient noise | the *input* is untrusted; an attacker's content is being processed |
| who is present | a person, listening, unable to see | nobody |
| what must not happen | consent without comprehension | exfiltration or destruction driven by fetched content |
| `WebSearch` / `WebFetch` | in — a listening user is the mitigation, and the exposure equals chat's | probably out — that is precisely the untrusted input |
| escalation to a human | synchronous, on the card already on screen | asynchronous, via the Action the plan describes |

One requirement applies to **one** of the two mechanisms. If the posture is an
enforced allowlist, a tool it excludes has to *fail* rather than *ask* — the
fail-closed primitive below, which #110 built and which the voice posture is
the first to declare. Under
availability control the requirement is vacuous rather than satisfied: an
unregistered tool raises nothing to fail or ask about, which is the same reason
the `request_image_mask` problem below does not arise there. That asymmetry is
the strongest practical argument for U15's choice, and it is why this record
does not make the primitive a condition on #51.

## The fail-closed primitive, and how it was reached

One mechanism was missing and both postures needed it. A tool outside the
allowlist does not *fail* — it **asks** — and in a turn with no reachable grant
surface that ask parks until the turn budget expires.
`requestToolPermission` already failed closed when there was **no bridge** at
all; what was missing was the same behaviour when the bridge exists but has no
way to grant. A turn can now declare that it has no grant surface
(`StartTurnRequest.noGrantSurface`), and a request in such a turn resolves
`deny` immediately with a reason the model can act on and the user can hear.
Without it, "not in the posture" meant "prompts anyway", and the posture was
decoration.

The rest of this section is the inventory that got it there: which
re-admission paths were open, which are closed, and by what. It is kept
because a narrower posture is only as good as that list.

**Removing a tool from the allowlist has never been enough on its own, and the
list of reasons is longer than this record first knew.** An earlier draft named
three re-admission paths and said all three were open. Two have since been
closed and three more were found. What follows is the state on `main`, which
matters because a reader cannot otherwise tell a live hazard from a fixed one.

**Closed, by #141 (`42a4d86`), which closed #124.** A turn now declares
`StartTurnRequest.enforceAllowedTools`
(`enforceAllowedTools?: boolean`, `packages/ui-sdk/src/server/backend.ts:321`)
— the declaration this record asked for, by that name — and under it:

- The input-rewrite hooks no longer grant. `createAgentHook` and `createRtkHook`
  take `mayGrant` and, for a tool outside the enforced allowlist, rewrite
  without granting
  (`RewriteHookOptions`, `packages/ui-backend-claude/src/input-rewrite-hooks.ts:18-32`;
  `!mayGrant`, `:71-79`; wired at their `agentHook`/`rtkHook` constructions,
  `const agentHook`, `permission-hooks.ts:340-356`).
  The premise the old grant rested on was measured false in the process:
  `permissionDecision: "allow"` was never what
  made `updatedInput` take effect, so the grant was a side effect and it is the
  side effect that got dropped (`both used to grant the call`,
  `input-rewrite-hooks.ts:8-15`).
- A remembered grant no longer answers. The host still *reads* its store — on
  purpose, so a grant that exists and is deliberately not applied can be logged
  — but refuses to answer from it or add to it for a tool the enforced allowlist
  left out (the lookup computing `remembered`,
  `packages/ui-server/src/ws/bridge.ts:142-162`,
  and the block computing `remembers`,
  `packages/ui-server/src/ws/dispatch.ts:310-316`).
  The evaluation happens
  before the lookup, which is what this record asked for.

**Closed, by #110.** The enforcement hook still answers `ask`, not `deny`
(`enforcementHook`, `permission-hooks.ts:104-119`) — that is what beats the
runtime's own shortcuts
below, and replacing it would reopen all three. What changed is the decision the
`ask` forces. A turn declares `StartTurnRequest.noGrantSurface`, and both
backends then refuse the request in the shared
`requestToolPermission` (`packages/ui-sdk/src/server/permission-gate.ts`)
instead of handing it to the bridge, with a message that names the tool and is
written to be read aloud. It covers both request kinds because that one call is
where both pass through, and the refusal is reported on the activity side
channel so the record shows a denied span rather than a call that errored.
Declared without `enforceAllowedTools` the field would be reached only by the
requests that happen to arrive, so since #173 both backends refuse that turn
with a `BackendRequestError` (`assertTurnPosture`,
`packages/ui-sdk/src/server/backend.ts`; the reasoning is in
`docs/extending/agent-backends.md`).

**Found since, and the reason the `ask` carries the load.** Withholding this
codebase's own shortcuts was never sufficient: the runtime has permission
opinions of its own that also land before `canUseTool`
(the block above `enforcementHook`, `DO NOT WEAKEN THIS INTO A FALLTHROUGH`,
`permission-hooks.ts:71-102`, with the measurements in #154) — a safe-command
classifier (`echo hi` runs with an **empty** `allowedTools` and the callback is
never consulted), a built-in tool's own check (`ToolSearch` executed twice under
the same conditions), and a `PreToolUse` hook in the project settings this
backend loads under `settingSources: ["project"]`. An explicit `ask` is the one
answer that beats all three, and it exists only under the declaration.

That third vector is stated here as #154 measured it, and the in-tree comment
now says the same: the vector is a settings `PreToolUse` hook returning
`allow`, not an **allow rule**, which #154 measured as not bypassing at all.
One more thing it measured belongs here, because this record's whole design
rests on it: an in-process `deny` beats a settings `allow`, so the decision the
`ask` forces is decisive rather than advisory. The probe, for anyone re-running
it on a later runtime: a project-settings `PreToolUse` hook returning `allow`
against an in-process one returning `deny`, on Claude Code 2.1.280 /
`@anthropic-ai/claude-agent-sdk` 0.3.278. The tool does not run and the model
is told "Denied by the user." Without that result the refusal below would be a
suggestion the runtime could overrule, and the posture would be decoration for
a second reason. That probe is now the `inprocess-deny-beats-settings-allow`
case of `scripts/measure-claude-runtime.ts`, and the runtime it last passed on
is the one `MEASURED_RUNTIME` names (#209).

That last group is the strongest available argument for the fail-closed
primitive, and against the intuition the record started from. "Take it off the
allowlist and `canUseTool` will catch it" was false in five ways, not one —
and, as U15 saw first, none of them exists for a tool that was never registered.

**A tool the posture could not exclude at all, closed with #110.**
`request_image_mask` is appended to the turn's allowlist after the profile's
list, gated only on whether the bridge offers the handler
(`packages/ui-backend-claude/src/sdk-options.ts`), and that same array is what
enforcement is evaluated against. So the mask tool was *inside* the enforced
allowlist whatever the voice posture declared, and the model could open an
editor a listener cannot see — then block on a painted region that would never
arrive. Nothing was granted that the deployment did not configure, so it was
never a grant hole; it was a third instance of the shape named twice already in
this record, an exclusion that is a statement of intent rather than
enforcement. It is fixed as the record asked — the capability that needs eyes
is suppressed for a turn that declared it has none, rather than the whole
bridge-tool append being filtered — so the four tools that ask nothing of a
viewer are unaffected. Under availability control it would not have arisen,
because the tool is simply not registered.

This architecture produced the "exclusion that is a statement of intent" shape
three times before it was fixed at the mechanism, which is the argument for
fixing it there rather than one exclusion at a time.

**The fail-closed rule has to cover both request kinds, and the `command` one is
the one that matters.** Removing `Bash` from the allowlist does not route a
Bash call through `canUseTool` first: the PreToolUse `mutatingHook` fires
before permission
evaluation and evaluates the confirm patterns against `commandAllowed`, which
adds `Bash` back unconditionally (`commandAllowed`,
`permission-hooks.ts:131-133`, and the call in `mutatingHook` that reads it,
`decideToolPermission`, `:254-261`). So a
destructive shell command in a voice turn raises a `command` request — and
parks — before the tool grant is ever considered. A fail-closed rule written
only for kind `tool` would leave exactly the calls this whole record is about
sitting on an unanswerable card.

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
cost of allowing the two document writes is not a measured figure and must not
be dressed as one: `brain_add` and `brain_update` are on `DEFAULT_ALLOWED_TOOLS`
(`brain_add`, `tool-policy.ts:75-76`),
so they raise **zero** approvals by construction —
with the single exception added by #144, a `brain_update` that sets
`status: "archived"`, which is the archive boundary above and is denied in a
voice turn rather than granted — and
the corpus contains no brain MCP calls at all (see "What the corpus does not
prove"). Allowing them therefore costs no approvals for a structural reason, not
an empirical one. The measurement's contribution here is different and
narrower: it shows that the workload this posture serves is one where approvals
are rare in the first place, so a posture that cannot grant is not being asked
to carry much. Pricing the two writes off the 1.8% would be the same error this
record refuses for form A — letting a number reach a conclusion it cannot
support.

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
same declaration.

Until then, what happens depends on which turn it is, and the two must not be
confused. **Under an enforced voice posture, `brain_archive` is outside the
allowlist, so it is denied — immediately, with no card**, like every other
excluded tool; the user hears that it did not happen and that it needs a screen.
**On an ordinary turn where the user happens to be listening** — situation 2 of
"When the announcement actually fires" — the card is live, the announcement uses
the payload-free fallback, and the decision is made on the screen. An earlier
draft of this paragraph described the second case as though it were the first,
which would have asked an implementer for a card the posture forbids.

**Whether the voice posture should also be the phone posture.** A phone in a
pocket and a phone in a hand are different, and nothing here measures the
difference. Out of scope for #55.
