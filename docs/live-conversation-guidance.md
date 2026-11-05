# What primes a live conversation

Both first-party live engines help operate a file-first knowledge base. They
can converse while the ordinary agent retrieves knowledge, captures or updates
notes, researches externally, or does substantial reasoning. Greetings,
clarification and follow-ups answerable from a reliable current result need no
new task. A transcript retained in chat history is not a saved brain note.

## Shared guidance and its sources

The same package-owned interaction brief appears in the default typed-chat
append and both live prompts. Provider-specific delegation syntax stays in the
live adapters. This is deliberately a projection of normal chat's guidance,
not its entire system prompt.

| Normal-chat source | Live treatment and trust | What stays with the host |
| --- | --- | --- |
| Core agent contract: Markdown source of truth, disposable index, untrusted imports | Adapted into the shared interaction brief; package instructions | Frontmatter, paths, index maintenance, editing and tool procedures |
| Core `add` skill: thoughts, facts, decisions, updates; existing home before duplicate creation | Adapted into capture recognition and host delegation; package instructions | Type selection, exact write tools, base hashes, capture/update execution |
| `brain-init`: identity/current-focus hot parts and Personal Rules overlay | Selected root guidance is scoped user instruction; canonical/conventional leads are knowledge data | Interview, config execution, taxonomy, other document sections |
| Default `BRAIN_UI_SYSTEM_PROMPT_APPEND` / `buildSystemPromptAppend` | Reuses the common interaction brief unchanged | Markdown, diagrams, sharing, renderer details, bridge schemas and turn/subagent lifecycle |
| “Don't narrate tool use” in the typed UI append | Adapted for speech: explicitly acknowledge accepted background work because the listener may not see the timeline | Tool-by-tool narration and detailed execution |
| Configured Claude/Pi `systemPromptAppend` override | Both factories select the same explicit interaction/capture sections into optional `AgentBackend.conversationGuidance`; no whole-prompt copy | Unselected override text and execution/rendering sections |
| Brain `AGENTS.md` and `CLAUDE.md` | Both root overlays are read as data, then only selected plain sections become scoped user guidance | Imported files, generated contract/module bodies, skill bodies, hooks and nested repository instructions |
| Module instruction regions | Their bounded names identify domains as knowledge data | Full module instructions, tools and configuration; retrieve these through the host |
| Chat discussion and prior host outcomes | Existing separately labeled historical data, never instructions or a new task | Native handles, internal receipts, budgets, diagnostics and execution authority |

The common source is
(`BRAIN_INTERACTION_GUIDANCE`, `packages/ui-sdk/src/server/interaction-guidance.ts:4-6`).
The section selector is
(`projectConversationGuidance`, `packages/ui-sdk/src/server/interaction-guidance.ts:17-42`).
Normal Claude turns load project settings/instructions; Pi loads both cwd
instruction files. Live mode does not imply that either backend's entire
instruction environment has reached the voice service.

## Startup sources, bounds and missing context

Only an authenticated Start with the exact disclosed profile admits reads and
provider transfer. Hello/profile discovery reads no brain context. Disclosure
names selected brain/user guidance, domain names and bounded identity/focus
context in addition to historical text; an old disclosure echo refuses before
the read/open. This applies to reviewed-only and contextual mode alike.

The concrete reader is
(`readConversationOrientation`, `packages/ui-server/src/voice/conversation-orientation.ts:32-120`).
It resolves the selected chat's backend (or the selected/default profile for a
fresh chat), collects its configured projection, and reads the two root
overlays. Selected headings, case-insensitively, are **Personal Rules**,
**Interaction Preferences**, **Communication Preferences**, **Capture Policy**,
**Brain Purpose** and **Brain Conventions**. Selection ends at the next heading
or generated region. Imports and fenced sections are excluded as
whole sections. Other override formats remain host-side; an empty selection is
explicitly unavailable rather than assumed inherited. Conflicting selected
instructions call for clarification and cannot widen authority.

When no TypeScript config exists, a readable `brain.config.json` supplies
`taxonomy.canonical.identity` and `currentFocus`, including disabled entries.
Otherwise the reader examines the conventional candidates `me/identity.md` and
`context/current-focus.md`, explicitly labeled **conventional**, and says that
runtime canonical paths were not evaluated. It never executes repository
configuration, follows instruction imports, invokes skills, or makes a
summarization/provider call. A customized TypeScript taxonomy may therefore
need a host lookup. The summary and body before the first level-two heading
form each document's knowledge lead; they are not user instructions.

Every repository source read is contained in the brain and capped at 65,536 bytes, with
the file surface's anchored descriptor reader on Linux. Missing, invalid,
unreadable, escaped or oversized sources become gaps. Repository orientation
is withheld when governance is invalid or any provider rule exists: startup
has no admitted taxonomy worker with which to resolve those rules. The host
retrieves context under ordinary policy when relevant. This conservative rule
does not change prior-chat history policy or claim that an ordinary task may
disclose a protected source.

The adapter's exact serialized orientation ceiling is **3,200 UTF-8 bytes**,
including framing. At most eight guidance sections, four knowledge entries
and eight source-gap labels are considered. Entries have at most 100 source
characters and 900 text bytes. An oversized guidance section is omitted whole;
knowledge may keep whole leading paragraphs within 700 bytes and an explicit
omission marker. Aggregate pressure drops supplemental knowledge before
guidance. `omitted` reports byte/count omissions; `unavailable` and the partial
coverage label report source gaps and deliberate exclusions.

Orientation, history and resync share the existing total startup ceilings:
Gemini **24,000 bytes**, GPT **7,500 bytes**. Orientation reserves its actual
bounded bytes before history/resync selection; history and resync still share
their existing fact caps. These are local serialization bounds, not tokenizer,
provider acceptance or recall guarantees. With no orientation opening option,
the previous history/resync allocation and empty input shape are preserved.

The snapshot is serialized once per epoch, before audio. Repository edits
cannot rewrite it or a prior message. A new Start/replacement epoch reads new
sources; configured append changes follow their existing backend configuration
activation boundary. Neither startup nor replacement executes prior tasks.
Missing capture policy means asking before preserving an emerging fact. A
clear explicit save request still proceeds through ordinary policy. More
identity detail, domain procedures, current facts and verification belong in
an asynchronous host lookup, not an invented answer or exhaustive startup dump.

## Honest task acknowledgement

The host binds the exact native handle to a new task/request before admission.
Only after its initial identity save succeeds does it send **queued** status;
**running** follows the actual ordinary host turn's start. Neither is a result,
permission grant, successful write or playback receipt. The provider receives
only model-needed progress and bounded uncertain recognition, without the
UI's task/turn receipts or diagnostic data.

The status path is
(`reportWorkStatus`, `packages/ui-server/src/ws/conversation.ts:810-827`).
Gemini sends a continuing function response for the exact call id:
`willContinue:true`, `WHEN_IDLE` for queued acknowledgement, `SILENT` for running
progress. GPT appends queued commentary and running thinking context under
the exact `delegation_id`. Both retain the binding for the later real result,
reject mismatched identities and backward states, and suppress duplicate status.
GPT progress acknowledgements cannot acknowledge a result. Refusal terminates
the exact native request without a turn; Gemini uses `WHEN_IDLE` so the refusal
can be explained. Failed persistence, withdrawal, replacement or lost authority
cannot emit a later acceptance. A status-send failure ends the epoch without
retry or replay; already dispatched host work retains its ordinary lifecycle.

Both prompts explicitly request a brief spoken acknowledgement **for each
accepted task**, naming the intended background work and its pending state,
then continued conversation. Before feedback, acceptance is unconfirmed.
Refused, queued, running and completed states are distinct. A successful
capture/update tool outcome is required before saying information was saved;
host turn completion by itself does not establish that a note exists.
Reviewed-only mode explains separate reviewed submission and promises no
automatic work. Speech cannot approve a screen card in either mode.

## Behavioral qualification

Keyless source, startup-frame, admission, identity, omission, replacement and
prefix tests establish request assembly and host behavior. Scripted audio and
prompt substrings do not establish model obedience, recognition, judgment,
audible acknowledgement or semantic recall. Actual-provider comparison remains
with #3131/#961; persona/provider Settings remain #3617/#3616.

Useful listening scenarios are:

| Conversation | Intended behavior to observe with a real model |
| --- | --- |
| “Hello” or a clarification about the last answer | Converse without delegation |
| “What did we decide about the mast?” with no reliable result | Request host retrieval; after acceptance, briefly acknowledge pending work |
| A new watch decision or lasting preference emerges | Recognize its relevance to identity/focus/domain context; follow capture policy, clarifying when missing or uncertain |
| An uncertain name, ambiguous correction or conflicting preference | Ask a focused question before a write |
| A substantial route comparison or external harbour research | Delegate reasoning/research and keep discussing while pending |
| A task is queued, running, refused, or awaits a screen card | Describe exactly the known state; never claim the effect or a spoken grant |
| “Which timber was that?” after an identified current result | Answer from that result without repeating retrieval or capture |

Record real-model observations separately from transport receipts, including
any untested provider/device cells. No prompt-only test closes those cells.
