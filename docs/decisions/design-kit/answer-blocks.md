# Design kit — Answer blocks

Part of the [design-kit decision record](../design-kit.md). Entries retain their
original dates and order within this subject; the index maps the complete chronology
and relationships with [other subjects](../design-kit.md#subjects).

<a id="2026-09-21--d41-the-answer-blocks-reach-the-model-through-one-tool-show_block"></a>

## 2026-09-21 — D41: the answer blocks reach the model through one tool, `show_block`

**Question.** The kit holds the design's §08 and §10 answer blocks —
`ComparisonTable`, `StatTiles`, `TrendChart`, `DataTable`, `BarList`,
`Receipt`, `StepList`, `TimelineList`, `ScheduleList`, `QuoteCard`,
`ContactCard` and more — and the app renders none of them from an answer.
The model can reach markdown (tables, fences, wikilinks, the share block) and
the four bridge tools; nothing tells it a comparison table exists, and it has
no way to emit one. Asked on 2026-09-21: do the agent's instructions, skills
and tools cover the inline components? They do not. This is the wave that
closes it, on the seam D3 already settled.

**Decision.**

1. **One tool, a union of blocks.** A single contract, `show_block`, whose
   input is a zod discriminated union on `block`: `comparison`, `stats`,
   `trend`, `table`, `bars`, `receipt`, `steps`, `timeline`, `schedule`,
   `quote`, `contact`. Its payload is the same schema: the handler validates
   and echoes, and the client renders the echoed payload through `bind()`.
   One tool keeps the prompt to one paragraph and the contract count at
   five; per-block tools would ride a dozen paragraphs on every turn for
   guidance that belongs in the tool description, which the model reads
   once per session.
2. **Data only, no handlers.** A block variant carries only what
   serialises. `ContactCard` ships its facts and no actions;
   `LinkPreviewCard` (needs a URL the kit prop has no home for),
   `Disclosure` (a body the model would author as markdown), `FeedbackRow`
   (a rating that must be recorded somewhere) and `SuggestionChips`
   (follow-ups that send through the composer) each need a handler or a
   second decision and wait for one. `MapView` already arrives through
   `get_current_location`; agent-authored pins are a later variant.
   `CodeBlock` is the markdown fence. `SearchResultCard`, `TraceSteps`,
   `DigestCard`, `StreamingAnswer` are the surface's own evidence and never
   the model's to draw.
3. **A block is part of the answer, not a step in the trace.** In the
   transcript it renders inline at the tool call's chronological position,
   the way `ask_user` does, not inside the collapsible tool timeline. In the
   Actions trace it stays an ordinary tool step, because it was one; the
   recorder does not change.
4. **The schema mirrors the kit's props and drift is a `tsc` error.** The
   block renderer is one switch typed by the contract's payload, handing
   each variant to its kit component. A kit prop the schema does not carry,
   or a schema field the kit does not accept, fails typecheck in both
   directions, as `bind()` promised in wave 6. Tone enums in the schema are
   the kit's `Tone` / `ValueTone` / `DeltaTone` sets and a test asserts the
   lists are equal.
5. **Side-effect free, so auto-allowed and bridge-free.** The handler needs
   no browser and no turn bridge; it lives in `ui-sdk/server` as
   `handleShowBlock` and both backends call it. It joins the auto-allow
   posture like the other bridge tools: an approval card for drawing a
   table would be the surface asking permission to answer.
6. **The brief says WHEN, the description says HOW.** The generated prompt
   line names the tool and the eleven blocks with one clause each on when a
   block beats prose: a comparison when the reader is choosing, tiles for
   three to four headline figures, a trend for one figure over time, a table
   for records, bars for shares of a whole, a receipt for what a tool did,
   steps for a procedure, a timeline for what happened when, a schedule for
   what is coming, a quote when the words themselves are the evidence, a
   contact when the answer is a person. The description carries the
   per-block shape rules the design set: at most three comparison columns
   under 700px, tiles in threes, values pre-formatted because the kit does
   no arithmetic, `recommended` on at most one column and only with a
   footnote that states the cost.
7. **It is a `CONTRACT:` commit.** A new tool name and payload in the
   chat-UI tool table of `docs/integration-contract.md`, in the same commit.

**Alternatives refused.**

- *Fenced blocks* (` ```brain-comparison ` with JSON inside): D3 refused
  this in 2026-09-15 and the reasons hold — no schema the model is handed,
  no description it reads, partial JSON while streaming, and the renderer
  becomes the validator.
- *Per-block tools*: eleven briefs on every turn, and eleven entries in
  every backend's allow list and renderer pack, to say what one union says.
- *A brain MCP tool in core*: the block is a fact about the surface, not
  the brain. Core has no chat.

**Not decided here.** The share-as-image path renders the last text group
only; a block inside the message is not in the PNG. That is the share
renderer's question and waits for it. Whether the model actually reaches for
the tool is measured, not assumed: wave 13 ends with three canned prompts on
each backend and the block rate recorded.

**Built 2026-09-21, two adjustments.** The union sits under a `block`
argument and discriminates on `kind`, not at the root on `block`: the Claude
SDK's `tool()` takes a raw object shape, so the argument root must be an
object. `ContactCard`'s `kind` prop travels as `contactKind`, because `kind`
is the discriminator. The tone-equality test is type-level and lives in
ui-react (`tests/block-contract.test-d.ts`), the one package that depends on
both the kit and the SDK — the kit exports types, not lists, so equality can
only be asserted where both are in scope.

<a id="2026-09-21--d42-the-surface-classifies-what-the-model-typed-once-per-answer-through-jev"></a>

## 2026-09-21 — D42: the surface classifies what the model typed, once per answer, through Jev

**Question.** Wave 13 measured the comparison prompt at 0 of 5: the model
reads "never write a markdown table; call `show_block`" back verbatim and
types the table anyway. Prompt text is not the lever. The surface can
still draw what it typed in the kit's shape, if something decides which
shape — a markdown table is a comparison, a data table, or neither; an
ordered list is a recipe, a checklist, or events in time; a run of
key-colon-value lines is a receipt, three stat tiles, or a person. Those
are judgments, not parses, and the user wants them made by Jev, TypeSafe
AI's System One model, which answers typed questions with calibrated
probabilities and generates no text.

**What Jev is, verified 2026-09-21.** `POST https://api.typesafe.ai/v1/systemone`,
model `jev-latest` (jev-1.13.0), bearer key from `TYPESAFE_API_KEY`;
`@typesafe-ai/sdk` 0.6.0 on npm, MIT, Node 20+. One request carries a
`state` (string, object or array, text only, 32k tokens) and a map of
named questions — `choice` over up to 255 options with per-option
probabilities and a confidence, `score` over 2–10 rubric levels, `noul`
as a 0–1 — all evaluated in parallel against the same state; "adding more
questions usually has little effect on response time". Latency 70–500 ms,
$0.042 per MTok in, output free. Documented rough edges: literal reading,
no arithmetic or counting, accuracy falls with irrelevant state, no
guarantee two phrasings agree. Their own "structure recovery" cookbook is
this design: one choice question per block with speculative companions,
in one call, with the code doing every extraction and every render.

**Decision.**

1. **One pass per answer, and only when warranted.** At turn end the
   server walks the markdown AST of the assistant message and collects
   CANDIDATES deterministically: GFM tables, ordered and task lists,
   blockquotes, key-colon-value runs, bullet lists whose items open with
   a time or a day, number series. Blocks already drawn by `show_block`
   are excluded. No candidates, no call — the common case. Candidates
   go in one Jev request as `{ items: [{ id, kind, text, headers?,
   rows? }] }`, never the whole answer, because irrelevant state costs
   accuracy; questions are per item with speculative companions read
   only when the primary answer makes them relevant.
2. **Progressive enhancement, never a dependency.** The answer streams
   and renders as markdown exactly as today; the pass runs after the
   stream ends and, when it returns, the client swaps classified blocks
   in at their AST positions. The call carries a **2 s timeout**
   (`AbortSignal.timeout(2000)`; planned at 1 s, raised the same day the
   live run measured Jev at 700–800 ms, which left no room for the
   retry), one retry on 429/529 inside that
   budget, and no other retry. Per the decision on #49, this deadline covers
   the HTTP request, not the complete pass. Local confidence recording is
   synchronous afterward and can add SQLite lock-wait latency (the server
   connection has a 5000 ms busy timeout). A timeout, an error, a missing key, an
   answer below the confidence threshold, or a candidate the transform
   cannot map all mean the same thing: the markdown stays. Nothing about
   an answer waits on Jev, and nothing about an answer can be worse for
   Jev having been asked. A classifier that keeps failing is not asked
   (added 2026-09-21, the user's call): after three consecutive failures
   the client opens a breaker and skips the pass for 30 s, doubling on
   every failed probe up to 30 minutes, and one answered probe closes it.
   Bad connectivity then costs one probe per window, never a budget's
   worth of waiting on every answer.
3. **Code extracts, Jev judges, code renders.** Every answer is a
   `choice` or a `noul` over things the surface can name from the text:
   which shape, which header is the recommended column (or none), which
   tone from the kit's fixed sets, whether the first column names
   criteria. Nothing Jev cannot answer from the text is invented — no
   footnote, no delta figure, no source line the text does not carry —
   the same rule the sparse-block fix set in wave 13. The transform's
   output is a `Block` from D41's union, rendered by `BlockCard`; the
   surface learns no new component.
4. **Server side, backend-agnostic, persisted.** The pass lives in
   ui-server at the point the turn's result frame is emitted, so pi and
   Claude get it alike and the key never reaches a browser. Results
   persist with the message (a `blocks` array of `{ anchor, block,
   confidence }`), so history renders identically without a second
   call, and a rerun of the pass is a maintenance action, not a render
   step. On the wire it is one additive frame after the result frame,
   `ServerMessageBlocks`, and a message-history field: `PROTOCOL_REV`
   4, a `CONTRACT:` commit.
5. **Confidence gates the swap.** Start at 0.6 for a swap and 0.8 for a
   tone; below that the block stays markdown and the answer records why.
   Thresholds are measured on the transcript corpus, not assumed —
   TypeSafe calibrates the probabilities, we pick where to act. Measuring
   needs the numbers, and the first cut recorded only the outcome, so a
   `kept` was a count with nothing behind it. The pass now also records
   what it was confident about (added 2026-09-22): one row per answered
   question in `classification_confidence` — the candidate it was asked
   about, its kind, the question, the answer, its confidence, the line that
   confidence had to clear, and whether the candidate ended up drawn —
   written after the call has resolved, so it takes none of the call's
   budget. It is read back with `confidenceDistribution`
   (`packages/ui-server/src/classification/confidence-store.ts`, exported
   from the package root), or straight off the file:

   ```sql
   SELECT candidate_kind, question, threshold,
          CAST(confidence * 10 AS INTEGER) / 10.0 AS bucket,
          COUNT(*) AS n, SUM(cleared) AS cleared,
          SUM(outcome = 'swapped') AS swapped
     FROM classification_confidence
    GROUP BY candidate_kind, question, threshold, bucket
    ORDER BY candidate_kind, question, bucket;
   ```

   One pass's rows share a `pass_id`, so `(pass_id, candidate_id)` names one
   candidate — a minted id rather than the clock, because the pass is fire
   and forget and a session's slow pass can still be writing when the next
   turn's starts. Some questions have to be read per candidate or they are
   meaningless:
   the catalogue asks `criteria_first` of every table, including the ones
   the shape answer calls `data`, so unconditioned its answers are two
   populations stacked on each other (measured 2026-09-22: 12 of 26 at or
   below 0.3, 13 at or above 0.9). Join the candidate back to its own shape
   answer before tuning anything on it.

   Instrumentation, not state: nothing renders or replays from it, a write
   that fails is a log line rather than a block the reader does not get,
   and rows age out after 30 days.
6. **The catalogue is the contract.** The candidate kinds, the questions
   asked of each, and the transform from answers to `Block` are one
   table in ui-sdk (`classification/catalogue.ts`), so a new kind is one
   row plus its transform, and the prompt to Jev is generated from it —
   the same move D3 made for tool briefs. First cut: table →
   comparison | data | plain (+ recommended header, + criteria-column
   noul); ordered list → steps | plain (+ variant); bullet list → schedule
   | timeline | plain; key-value run → receipt | stats | contact | plain
   (+ contact kind, + per-row value tone); blockquote → quote | plain
   (+ quote tone, + "next line is the source" noul); number series →
   trend | plain (+ delta tone).

**Alternatives refused.**

- *Deterministic heuristics alone*: they separate a table from prose but
  not a comparison from a data table or a recipe from a timeline, and
  every rule is a future bug report. Heuristics stay for what they are
  good at — finding candidates — and hand the judgment on.
- *Asking the answering model to classify its own output*: a second
  frontier call per answer, seconds not milliseconds, and it generates
  text that must be parsed.
- *Client-side classification*: the key would ship to the browser.
- *Blocking the render on the pass*: refused by the user's own rule and
  by wave 13's — a table the reader can see beats a kit table 400 ms
  later.

**Not decided here.** Whether `show_block` is still worth its brief once
the net exists (measure the tool's use rate after wave 14). Cells with
inline markup render plain until the kit's table cells accept nodes,
which is the kit's decision. Whether the pass should also run over the
share PNG's source.


<a id="2026-09-22--d45-the-pass-routes-to-contact-trend-stays-the-tools-because-its-payload-is-numbers"></a>

## 2026-09-22 — D45: the pass routes to `contact`; `trend` stays the tool's, because its payload is numbers

**Question.** D42's decision 6 names six catalogue routes. Two of them were
never built, and nothing recorded a decision to drop them (#132): `contact`
from a key-value run, and `trend` from a number series — together with the
per-row value tone named in the same sentence as the first. `bars` is not in
that list, so the gap is exactly the two routes the record claims are covered
and the code does not have. The question is per route: build it, or correct the
record.

**Decision.**

1. **`contact` is built, from the key-value run D42 names.** The run's `shape`
   question gains a fourth option, and the transform draws a `ContactCard` from
   the lines the text already has. The block's `label` is required and a run
   does not say which line is the name, so a `subject` question asks the
   classifier to choose one of the run's own keys, or `none` — the same move
   the table row's `recommended` question already makes over its headers. The
   chosen line's value becomes the label, the remaining lines become the card's
   facts, and a `contact_kind` question fills D42's "+ contact kind". A run the
   classifier calls a contact but cannot name stays markdown: a label the text
   does not carry is one the surface would be inventing, which
   `docs/integration-contract.md` already forbids.

2. **`trend` is not built, and D42's "number series → trend | plain (+ delta
   tone)" is withdrawn.** Three reasons, in the order that decided it.

   *Its payload is numbers, and the pass only ever passes strings through.*
   `trend.values` is a `number[]` and `bars.pct` is a `number`; those two are
   the only members of D41's eleven whose payload is not text the answer
   already contains — checked against the schemas rather than read off, and
   asserted by a test, because the whole entry rests on it. Every transform in
   the catalogue hands the kit the candidate's own strings verbatim; the only
   text any of them authors is a fixed label, the one-group schedule's "Coming
   up", and never a value. A `trend` route would have to turn
   "1,200", "$1.2M" or "12%" into numbers — a parse with no ground truth and a
   locale ambiguity a reader cannot see ("1.200" is twelve hundred in one place
   and one-point-two in another), feeding a sparkline whose shape is the claim.
   That is precisely the reason D42 gave for never routing `bars`. It applies
   to `trend` unchanged, and D42's route list was inconsistent on the point;
   this entry makes it consistent. The consumer rule it also satisfies is
   already written down: *"Blocks contain only what the text carried. The
   classifier chooses a shape and a tone; it never invents a footnote, a
   figure, or a source line."*

   *There is no gap to fill.* The two routes look symmetric and the
   measurements say they are not. With the tool loaded — the configuration D44
   ships — `trend` fires 3 of 3 in both arms in D43's run and again in #148's,
   while `contact` is 1 of 12 pooled across the same two runs (#119 carries the
   pooled table; the full count across both loading configurations is on that
   issue). A fallback earns its place for the kind the model declines, not for
   the kind it reaches every time.

   *It needs a candidate that does not exist, and the detector under it is the
   part the classifier cannot rescue.* D42 hands judgment to the classifier and
   keeps extraction deterministic. "These lines are a series, oldest first" is a
   judgment and could be asked; "1.2M is 1200000" is extraction, and it is the
   half with no answer in the text.

   What this does **not** claim is that `trend` is unreachable. It is reached by
   `show_block`, where the figures come from an author who knows what they mean
   — which is the right place for a number.

3. **Per-row value tone is built, and bounded.** One `choice` per line of the
   run, with the options named by what the text says rather than by their
   colour ("it reports a failure, an error, or an outcome the reader would not
   want" → red), gated at the tone threshold of 0.8 like every other tone. The
   fall-through option is `none`, not `neutral`: in this kit `neutral` is the
   grey machine-meta accent and means that everywhere, so a value that wants
   the default carries no tone at all and each component falls back on its own
   (`design-feedback.md` §4, `packages/ui-kit/src/types.ts`). Offering `neutral` as "no
   strong reading" would have taught the classifier a meaning the 2026-09-18
   drop retired. It is one question set on the run and whichever branch wins
   reads it, so a
   receipt's rows, a stat tile and a contact's facts are coloured by the same
   answers. It is asked only of a run of eight lines or fewer — the bound stat
   tiles already had, and now the bound on the contact questions too — so the
   question count follows the run's shape and not the text's length. That bound
   is not only editorial: the `subject` question offers one option per line,
   the classifier takes at most 255 of them, and one oversized question fails
   the whole request, which carries every candidate in the message. A run
   longer than a card is asked what shape it is and nothing else, and the
   transform refuses the contact branch on its own rather than relying on the
   answers being absent.

4. **The route list is a test now, not a reading.** Each catalogue row declares
   the block kinds its transform can return, `CATALOGUE_BLOCK_KINDS` is their
   union, and `packages/ui-sdk/tests/classification-catalogue.test.ts` drives
   every declared kind through a real transform and asserts that what is left
   over is exactly `trend` and `bars`. #132 was found by a reader comparing a
   decision record to a file. The next divergence fails a test instead.

**What the pass reaches, after this.** Nine of the eleven: `comparison`,
`table`, `steps`, `timeline`, `schedule`, `quote`, `receipt`, `stats`,
`contact` — every kind whose payload is the answer's own strings. The two it
leaves are the two whose payload is numbers. That is now a sentence with a
reason in it, rather than a count nobody had taken.

**Alternatives refused.**

- *Routing `trend` from the key-value run instead of building a new candidate.*
  A run of `period: figure` lines is nearly what the detector already finds, and
  a `trend` option on the run's `shape` question would need no detector work at
  all. It was the cheapest way to build the route, and it is refused for the
  first reason above: it moves where the route hangs without touching the number
  parse, which is the actual objection.
- *Restricting `trend` to bare integers* (`^\d+$`), which removes the locale
  ambiguity by construction. It also removes the case. A model writing a series
  writes "1,200" or "$1.2M"; a route that fires only on the shape nobody types
  is a route in name.
- *Dropping `contact` as well, on the ground that prose is the right answer to
  "who is this person".* That is #119's question and this entry does not settle
  it. What it settles is narrower and mechanical: when the model **does** type a
  run of facts about a person, the pass now draws it, where before the best it
  could do was a receipt. #119's own reframing is that `contact` was the one
  kind where a low call rate reached the reader as a missing block; after this
  it is a kind whose decline is caught, like `quote`'s.
- *Asking the classifier for the display name as a string.* It generates no
  text by design (D42), and a name is not a judgment. Choosing among lines the
  text already has is.

**What this corrects in D42.** Decision 6's fourth route is now built as
written. Its sixth route is withdrawn, with the reason above; there is no
number-series candidate, no `trend` transform and no delta-tone question, and
the record no longer says there is. The other four routes were already built and
are untouched.

**Known limit, since lifted (2026-09-23, #167).** GFM autolinks a bare email
address or URL, a link is inline markup the kit's cells cannot hold, and so a
run carrying one was not a candidate at all — which removed the most natural
shape a contact has. The maintainer's ruling on #167 narrows the rule for every
candidate kind: a link whose text is its own destination flattens to that text,
since nothing is lost, and a `mailto:` destination reads as the bare address.
A labelled link (`[the docs](https://…)`) still keeps its candidate out of the
pass, because flattening it would drop where it points; so does a link with a
title or an image inside it, and GFM's `www.` form, whose destination adds a
scheme its text does not carry. So the filter is narrower, not gone.
`packages/ui-sdk/tests/classification-detect.test.ts` pins both sides.

<a id="2026-09-22--measured-pi-draws-the-block-so-the-net-never-gets-cast"></a>

## 2026-09-22 — measured: pi draws the block, so the net never gets cast

**Question.** D41 left the tool's use rate to be measured and D42 measured
the classification pass once. Both numbers are the Claude backend's, because
the test deployment configures no other, and D43 has since replaced the
first with a 108-turn A/B. The pi backend had never had a number at all, and
the two backends hand a tool to a model differently enough that the gap was
worth measuring rather than assuming.

**Method.** `scripts/measure-show-block-server.ts`, a companion to D43's
harness rather than a copy of it: that one drives the Agent SDK directly,
which is what an A/B over the brief needs and what pi has no equivalent of,
while this one boots a real ui-server on loopback and drives it with the
shipped client over a real socket, so any backend can be put through the
same measurement. Two runs of the same 32 turns on 2026-09-22,
`claude-sonnet-5` through pi's builtin Anthropic provider, against a copy of
`packages/core/fixtures/corpus/`: the first with the classification pass
off, the second with it on, 18:29:13Z to 18:44:35Z. $2.18 of API spend.
D43's counting rules are carried over — a call counts only when the handler
accepted its payload, subagent frames are skipped, a turn that did not
complete is excluded — and one is added: a turn whose tool arguments named a
path outside the brain answered about a different brain and is excluded too.
Two of each 32 were. Thirty turns counted per run.

The environment can redirect a turn without showing up in a number — a
different endpoint, a different credential store, a different binary — so
what was set is part of the measurement. Both runs: `ANTHROPIC_API_KEY`, and
`TYPESAFE_API_KEY` on the second. `ANTHROPIC_BASE_URL`,
`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_PATH` and `PI_CODING_AGENT_DIR` were
unset, so the turns went to Anthropic's own endpoint with pi's default agent
directory. The harness records that set of presences with every run and
`--report` prints it.

**pi has no deferral, so this is the always-loaded regime.** `const showBlock`,
`packages/ui-backend-pi/src/bridge-tools.ts:266` registers `show_block` as one
of pi's own `ToolDefinition`s, and pi's `splitDeferredTools` only ever defers a
name that arrived through a tool-result's `addedToolNames` and has not been
called since — a statically registered tool can never be deferred. Across all 64
turns the complete roster the model reached for was `bash`, `show_block`,
`brain_read`, `grep`, `brain_search`, `read_file`, `brain_list`, `brain_graph`:
no search-then-load round trip, ever. The brief is in the prompt on every turn
unconditionally (`block: "show_block"`,
`packages/ui-backend-pi/src/session-resources.ts:165`, not behind a capability
check like the four bridge tools beside it). So pi is the structural twin of
D43's `--always-load` arm and has never run any other configuration.

**The rate.** Each cell is turns that drew at least one accepted block.

| prompt | expected kind | run 1 | run 2 | pooled | right kind |
| --- | --- | --- | --- | --- | --- |
| `compare-short` — "…Keep it short." | `comparison` | 6/6 | 6/6 | **12/12** | 12/12 |
| `compare-long` — the same without it | `comparison` | 6/6 | 6/6 | **12/12** | 12/12 |
| `trend` | `trend` | 4/4 | 4/4 | **8/8** | 8/8 |
| `contact` | `contact` | 3/6 | 2/6 | **5/12** | 5/5 |
| `steps` | `steps` | 2/2 | 2/2 | **4/4** | 4/4 |
| `schedule` | `schedule` | 2/2 | 2/2 | **4/4** | **0/4** |
| `quote` | `quote` | 2/2 | 1/2 | **3/4** | 3/3 |
| project summary | — | 2/2 | 2/2 | **4/4** | not scored |
| overall | | 27/30 | 25/30 | **52/60 (87%)** | **44/48** |

Pooling the two runs is legitimate for this number: the classification pass
runs after the result frame and cannot change what the model did during the
turn. **A figure of 90% circulated before the second run existed** — that is
27 of 30, the first run alone. D43 and D44 both quoted it and both now carry
52 of 60, read off this record's per-run breakdown rather than relayed. The
spread between 90% and 87% is what 30 turns of sampling noise looks like on
this measurement, which is worth knowing before either is treated as
precise. Across all sixty turns the model typed **zero markdown tables**. Two
calls were rejected by the handler, both `comparison`, both on a turn that
retried and succeeded — the same shape D43 saw at three in 108, and the
reason a call is not counted until its payload parses.

Beside the Claude backend, on one axis. The two Claude columns are
independent runs of the same four cells — D43's and D44's, both above —
quoted from those records rather than relayed:

| configuration | Claude, D43 | Claude, D44 | pi |
| --- | --- | --- | --- |
| behind tool search — what shipped, with brief | 23 / 43 (53%) | 14 / 25 (56%) | n/a |
| behind tool search, no brief | 1 / 47 (2%) | 0 / 25 (0%) | n/a |
| always loaded, with brief | 17 / 22 (77%) | 19 / 25 (76%) | **52 / 60 (87%)** |
| always loaded, no brief | 17 / 22 (77%) | 20 / 26 (77%) | unreachable |

D43's deferred rows here are the ones from its own `--always-load`
comparison, so both of its rows come from one run; its headline A/B is a
larger, separate run at 59% and 2%. pi's cell sits on the "with brief" row
and nowhere else: the brief is
hardcoded into pi's prompt, so pi has no no-brief arm and no supported way
to have one. The two Claude no-brief cells are therefore one backend
measured twice and not two backends agreeing.

**pi does not contradict either record; it replicates their always-loaded
arm on a different backend.** What is not accounted for is the remaining
height — **87% against 76–77%**, on 60 turns against 47–48 across the two
Claude runs. Three things could explain it and none is measured: the layer
(both Claude records drive the Agent SDK, this drives the whole server, and
no backend has been measured at both), the roster the block competes in
(D43 records that narrowing it moves the absolute rate, and pi's roster here
carried four brain tools), or the backend itself. That is #137.

D44 puts the same residue the other way round and names its own failure
condition: if deferral were the whole difference, making the Claude backend
always-load should move it toward pi's rate rather than merely upward. It
moved to 76–77%. That is the prediction failing, and the shortfall is what
#137 is for.

**Which kind, not just whether.** Every measurement before this one scored
whether a block was drawn and never which one, so a model reaching for the
wrong kind scored as a success. Scoring against the kind the brief itself
prescribes — clause by clause from `SHOW_BLOCK_CONTRACT.brief`, with the
project-summary prompt left unscored because the brief prescribes nothing
single for it — gives **44 of 48**, and every miss is the same miss: asked
what is coming up over the next few weeks, pi drew a `timeline` rather than
the `schedule` the brief names for "what is coming", 4 times out of 4. A
kind can be reachable and still be reached for the wrong question, and no
rate measures that.

**What this does not say.** Seven of eight prompts drawing the kind the
brief prescribes is not evidence that the brief's *content* is what did it.
Every pi turn was measured with the brief present, because pi has no
supported way to run without it, so this is a single-arm result and
attributes nothing to the brief in either direction — the description names
all eleven kinds too, and several of these prompts have an obvious kind. A
comment of mine on #157 drew that inference and is retracted there; D44 is
where it was caught. What survives is the part that needs no attribution:
**a wrong kind was drawn reliably, and a call-rate metric would have scored
all four of those turns as successes.**

That clause is worth naming precisely, because it bears on whether the brief's
enumeration earns its tokens now that the tools are always loaded (#157). The
brief says "a `timeline` for what happened when; a `schedule` for what is
coming". The tool's own description already says, at `schedule: what is coming`,
`packages/ui-sdk/src/tool-contracts/blocks.ts:727`, "timeline: what happened
when, oldest first … schedule: what is coming, grouped by day". The model drew
the wrong one of the two 4 times out of 4 **with both surfaces in the prompt
saying nearly the same words**. So for this pair the brief duplicates the
description rather than adding to it, and saying it twice does not fix the miss
— the same lesson D42 recorded when the brief was rewritten twice and still
measured zero. More text is not the lever.

One thing only a per-kind count shows: the `trend` prompt drew 14 blocks
across 8 turns — the prescribed `trend` every time, plus an unprescribed
`bars` companion on most of them. "One or two blocks per answer" is a
description rule being stretched, and a rate cannot see it.

**The classification pass, live.** Thirty-two turns with the pass enabled
against `jev-latest`, 18:29:13Z to 18:44:35Z: **31 `skipped_no_candidates`,
1 `swapped` at 718 ms, zero timeouts, zero errors, zero rate limits, and the
breaker never opened.** The one swap drew a `receipt` from a key-value run
in the trail-signage answer; that corpus predates [the ruling](../example-corpus.md).
Latency sits in the 700–800 ms band D42 measured on the Claude side.

The shape of the difference is not the classifier; it is that pi hardly ever
leaves it anything. D42's Claude measurement was eight turns, three swaps,
five with no candidate — 3 of 8 answers carried a candidate. Here **1 of 30
did**, and D43's no-brief arm, where the tool is invisible and the model
types markdown instead, carries one on 62% of turns. **pi draws the block
itself, so the net is cast over an empty deck.**

Put the other way round, so the absence is not the only evidence: sending
every recorded pi answer that *does* carry a candidate through the real
classifier (`--classify`, same client, same 2 s budget) answered both of
them, at 716 ms and 259 ms — one drew a `receipt` at 0.96 confidence, one
cleared nothing and kept its markdown. That is three live calls in total,
counting the swap inside the turn: too few to say the classifier is
*indifferent* to which backend wrote the markdown, enough to say nothing
observed suggests otherwise, and all three inside D42's measured latency
band. There is just almost no pi-authored markdown to ask about.

**Trap, recorded.** The brain the harness points at must live outside any
checkout of this repo. The agent's cwd is the brain, and a brain nested in
the worktree lets the model walk up into it: on the first attempt two pi
answers compared Bun and Node by quoting this repo's own `AGENTS.md`. The
shell is not confined to the brain either — the deployment container is that
boundary (the container privilege record, in brain-hosting-template) and a developer host does not have one —
so the harness records when a tool argument names a path outside the brain
and drops that turn from the rate. Four turns across the two runs were
dropped that way, and **all four were the `trend` prompt** — the one that
sends the model counting notes, so it is the one that goes looking. Three
plainly answered about a different brain (one reported 1,953 files, against
this corpus's 25). The fourth answered from the corpus and was dropped
anyway, because it named a path outside it: the rule is deliberately the
conservative one, since an over-eager exclusion shrinks a printed
denominator while an under-eager one quietly corrupts a rate. It is why the
`trend` row reads 4 of 4 rather than 6 of 6 in both runs.

A Claude-backend control on this harness is still owed and is #137's. Two of
its three blockers now have known fixes: keep the brain outside any
checkout, and point `CLAUDE_CONFIG_DIR` at an empty directory, which stops
the Agent SDK answering about this repository instead of about the brain.
The third is open — in the probe turn no brain MCP tool came up at all,
where pi had four, and a control whose roster is missing them is not
comparable.

_Resolved on 2026-09-25, in "measured: the Claude backend at server level,
beside pi (#137)" below. The brain tools were present but deferred, and the
remaining leak was the CLI's ancestor walk, not the config directory. Two
turns there still ran a `find /` that the escape rule cannot see, and were
excluded._
