# Design kit — Follow-ups

Part of the [design-kit decision record](../design-kit.md). Entries retain their
original dates and order within this subject; the index maps the complete chronology
and relationships with [other subjects](../design-kit.md#subjects).

<a id="2026-09-28--d50-the-model-may-offer-two-follow-ups-drawn-under-the-answer-that-fill-the-composer-and-never-send-40"></a>

## 2026-09-28 — D50: the model may offer two follow-ups, drawn under the answer, that fill the composer and never send (#40)

**Question.** `SuggestionChips` was used only for the welcome state, a fixed
set the app chooses. Should the model author chips as follow-ups to its own
answer, and if so, what does taking one do, where does the row sit, and what
does a replayed session show?

**Ruling (maintainer, recorded on #40).** Yes, within these limits.

1. **A chip fills the composer and never sends.** Its words go below the
   reader's draft, which is kept byte for byte, and the caret goes to the end.
   It is never a `chat_message`, never the answer to a pending question and
   never an approval. *Rejected: sending on tap.* The model wrote the words,
   and a tap would run them before the reader could change them. Zero, one or
   two suggestions per answer. None is a valid answer, and generic filler is
   not offered.
2. **The payload is the kit's data, minus tone.** The schema
   (`suggestionsBlock`, `packages/ui-sdk/src/tool-contracts/blocks.ts:603-630`) carries the row's
   `label` and `items[1..2]{label, icon?}`: `SuggestionItem` without `onClick`,
   which is a callback, and without `tone`, because a suggestion carries no
   effect and so is never amber. `packages/ui-react/tests/block-contract.test-d.ts`
   asserts the keys equal in both directions. Adding `tone` to the schema turns
   that test red, and the PR that added it recorded the mutation. The
   maintainer's 2026-10-02 ruling on #635 makes new calls reject unknown
   fields at both the suggestions block and item levels, including `tone`;
   both backends advertise and enforce the restriction. Stored and replayed
   payloads instead discard unknown fields so otherwise valid suggestions
   keep rendering. Malformed payloads keep the generic fallback. Other
   block kinds are unchanged. This accepted-input tightening is a breaking
   change shipped as a pre-1.0 minor.
3. **A separate app component draws it.** `AnswerSuggestions` in ui-react uses
   the kit's `Icon`, its untoned chip colours and `.bk-control`. It adds what
   the kit's welcome chip lacks: a real `<button>`, a 44px target, and text
   that wraps instead of ellipsising, because the chip IS the prompt. The
   welcome chips do not change.
4. **An exception to D41 §3: it is not drawn where it is called.** The turn's
   last call that parses is lifted to the answer's closing row, after the text
   and the share menu. At its call position `groupParts` draws nothing
   (`payload?.block.kind === "suggestions"`,
   `packages/ui-react/src/components/chat/message-bubble.tsx:274`), and shares
   and prints leave it out. This also amends D37 §8's "chips while live,
   `FeedbackRow` later": #41 closed as not planned, so the closing row is
   suggestions or nothing.
5. **Replay draws what live drew.** One pure function decides the row
   (`visibleSuggestions`, `packages/ui-react/src/lib/answer-suggestions.ts:118-139`).
   It reads only the transcript and state that is current either way. The
   flip (D38 §8) is any message after this one. S1 is the session's run
   state, which a resume sets from the status frame the server sends after
   the history. S3 is an `ask_user` exchange without answers, which history
   rebuilds from the tool calls. S4 is the answer's last text ending in `?`.
   S5 and S6 are the voice store. S8 means no parsed call, or nothing
   surviving the drops.
6. **A voice-conversation turn is suppressed by its user message's `source`.**
   ui-server keeps a message's source and joins it onto the replayed history
   (#549), so the rule holds on replay as well.
7. **Errors are suppressed only by #191's error card, live and on replay
   alike.** Until it lands there is no error suppression. A cancelled turn is
   never suppressed: the model calls suggestions last, so a turn that reached
   the call has an answer.
8. **The rule rides in the tool description, not the brief.** The brief sits
   at its pinned eleven lines and 749 characters, and with the tools always
   loaded (D44) it measured no effect on the call rate. The description, which
   D44 puts in every prompt, carries a `suggestions:` line. The brief's
   "names every kind" assertion exempts `suggestions` by name
   (`BRIEF_EXEMPT`, `packages/ui-sdk/tests/tool-contracts.test.ts:122-126`).
9. **It merges before it is measured, and the release waits.** #550 runs the
   keyed measurement on both backends: the suggestion rate, the rate when the
   answer ends in a question, the drop rate, the added tokens, and a read of
   the kept suggestions as grounded or filler. The release that first ships
   this is not cut until #550 closes.

**Targets.** A one-line chip paints about 29px. Its target reaches 8px past
the paint on every side (`.answer-chip::before`,
`packages/ui-react/src/theme.css:622-626`), and the chips sit 16px apart on
both axes, which is D34's half-the-gap limit. The hairline is an inset shadow,
not a border, so the reach is measured from the paint.
`tests/answer-suggestions-targets.test.tsx` lays the row out in real Chrome
at 320px and 1280px. It asks `elementFromPoint` for the point 1px inside each
edge of each target and asserts the border is zero. With the reach removed,
all four edges read false. The same file runs axe on the row in both themes.
A first axe run failed on colour contrast because it measured mid-fade,
which is why the test now waits for animations to finish.

**Proof.** `packages/ui-react/tests/render/answer-suggestions.test.tsx` mounts
the real `ChatPage` and `Composer` on a root with a fake socket. It asserts
each suppression rule twice, once on a turn built from live frames and once
on the same turn replayed from `session_history` followed by its status
frame. Every row of #40's
composer table is covered, with the assertion that nothing was sent. For each
guard, the test named for it failed when the guard was removed: S1, S3, S4,
S5 and S6, S7 (in the decision itself; ChatPage's `closing` prop is only a
render filter), S8, S9, the drops, the last call winning, the empty call
position, the kept draft, the share omission, and the classified-span filter.


<a id="d50-measurement-instruments-description-arms-and-item-accounting-550"></a>

### D50 measurement instruments: description arms and item accounting (#550)

The two harnesses select the same six prompts with `--suggestions`: three
answers with a plausible next step, and three controls that ask the model to
end its answer with a question. Both arms retain the shipped schema, brief and
always-loaded bridge tools. `rule` carries the shipping description;
`no-rule` removes only its `suggestions:` line, including the instruction to
call it last. The description's opening sentence still names the variant in
both arms. On the server, a Bun preload changes that single source line in
memory before either backend loads, in a fresh subprocess for each arm. The
keyless test lists both backends' tools and executes their real handlers to
prove that their schemas and accepted suggestions are identical across arms.

The rate is per completed turn with a parsed suggestions call. A parsed call
whose items all drop still counts as a call. Rejected calls, subagent calls,
incomplete turns and server turns that left the corpus are excluded. The
question-control rate and the rate over answers whose actual final text part
ends in a question are separate: asking the model to end with a question does
not prove that it did. Item accounting follows the client in order: empty
normalized label, duplicate, repeated user prompt, then generic filler, using
the same case/punctuation folding. Drops are measured over all accepted calls'
items. Only the last
accepted call supplies the transcript's kept-item sample; question-ending
suppression is stated separately from item drops. A quality verdict needs a
read of those transcripts, rather than another automated predicate.

Keyless schema arithmetic on 2026-09-30, using Bun 1.3.14 and the Agent SDK's
actual `tools/list` serialization: the description line adds **336 JSON
characters**; adding the variant adds **808** characters to the shipped flat
schema and **651** after D47's `definitions` transform. D47's calibrated
marginal range estimates **131–140**, **315–337** and **254–272** input tokens,
respectively, per model round trip. These are estimates; the counted command
below measures the description and variant separately against the same tool
name. The schema without the variant is only a token-count baseline, never a
live arm. These character counts and their provenance do not establish a live
rate or a keep/change/remove verdict.

After #635's two `additionalProperties: false` declarations, the same
keyless listing on 2026-10-02 adds **866** flat-schema characters and **709**
after the definitions transform; the description remains **336** characters.
These updated counts do not supply the live measurements reserved for #550.

The maintainer's 2026-10-07 ruling pins new comparisons to
`claude-sonnet-5-5`. Earlier observations on `claude-sonnet-5` keep their
original model identity and are not pooled with the new comparison.

Reproduction commands (live commands require authorized API use):

```sh
# Keyless estimate and checks.
bun scripts/measure-show-block.ts --suggestions --schema-cost
bun run test tests/measure-suggestions.test.ts

# SDK level: 6 prompts x 2 arms x 3 repetitions = 36 turns.
bun scripts/measure-show-block.ts --suggestions --reps 3 --out sdk.json --md sdk.md
bun scripts/measure-show-block.ts --suggestions --tokens

# Server level: 36 turns per backend, each against a separate fixture copy.
# Copies live outside any checkout and home directory and are indexed first.
bun scripts/measure-show-block-server.ts --suggestions --brain <claude-fixture-copy> --backend claude --model claude-sonnet-5-5 --runs 3 --out claude.json
bun scripts/measure-show-block-server.ts --suggestions --brain <pi-fixture-copy> --backend pi --vendor anthropic --model claude-sonnet-5-5 --runs 3 --out pi.json
bun scripts/measure-show-block-server.ts --report claude.json
bun scripts/measure-show-block-server.ts --report pi.json
```

Keep the reports separate by backend and model. The server report refuses to
pool unlike backends/models or legacy block-rate records with suggestion
records. The run files retain the answers, parsed items, drop reasons and
runtime/package versions for review. Keyless tests compare the counter's
survivors and question-ending decisions with the actual client's functions,
and drive accepted, rejected, malformed, subagent and failed-turn frames
through the server instrument over a real socket. Removing each guard makes
its named behavioural assertion fail.


<a id="d50-sonnet-55-measurement-and-verdict-550-2026-10-07"></a>

### D50 Sonnet 5.5 measurement and verdict (#550, 2026-10-07)

Keep the shipped description and variant. The completed comparison used six
prompts, both description arms and three repetitions through the SDK, Claude
server and Pi server: 108 completed turns, with no scored exclusions.

| Instrument | Answer turns with suggestions, rule | No-rule | Question controls, each arm |
| --- | ---: | ---: | ---: |
| SDK / Claude subscription | 0/9 | 0/9 | 0/9 |
| Claude server / subscription | 0/9 | 0/9 | 0/9 |
| Pi server / Anthropic API key | 2/9 | 0/9 | 0/9 |

Actual question-ending turns also had zero calls in every arm. No question
control emitted a row, so this does not prove active client suppression.
Pi's rule arm emitted four items; all four passed the client predicates, with
zero empty, duplicate, prompt-echo or filler drops. Zero-item arms have null
drop and quality denominators. All four labels are concrete and grounded in
the prose or accepted rendered comparison; the combined-workflow label is
weaker because the answer already supplies a workflow outline.

The subscription-authenticated token-count endpoint estimates a marginal
107 input tokens for the description and 377 for the variant. The updated
866 flat-schema and 709 definitions-transform characters imply D47 calibrated
ranges of 338–361 and 276–296 tokens; the 336-character description implies
131–140. These counted endpoint observations are not future invoice proofs.

This supports a small observed Pi benefit and no demonstrated Claude benefit.
The fixed arm order, three repeated answer prompts, backend/tool differences
and Pi API-key route limit generalization. No brief, variant, runtime filter
or payload change follows. The
[full report](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/suggestions-2026-10-07/report.md)
retains all transcripts, item judgments, exact models/runtime versions,
reviewed input hashes, private-data isolation limits, usage and billing
provenance, and parameterized reproduction sources.
