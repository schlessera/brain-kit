# Design kit — Tool loading

Part of the [design-kit decision record](../design-kit.md). Entries retain their
original dates and order within this subject; the index maps the complete chronology
and relationships with [other subjects](../design-kit.md#subjects).

<a id="2026-09-22--d44-the-bridge-tools-are-always-loaded-not-deferred-behind-tool-search"></a>

## 2026-09-22 — D44: the bridge tools are always loaded, not deferred behind tool search

**Question.** D43 ended with a filed finding rather than a decision:
`packages/ui-backend-claude/src/ask-user-tool.ts` created the `brain-ui` MCP
server without `alwaysLoad`, so the Agent SDK deferred all five bridge tools
behind tool search, and forcing them into the prompt reached 77% with no brief
at all. #148 asked whether that is the configuration that should ship. It is an
arithmetic question and nobody had done the arithmetic.

**What the SDK actually offers**, checked against the installed
`@anthropic-ai/claude-agent-sdk@0.3.278` rather than recalled:

- `createSdkMcpServer({ alwaysLoad: true })` stamps
  `_meta["anthropic/alwaysLoad"]` on every tool it registers. Leaving it unset
  is deferral, and that is the default.
- **A per-tool split is possible.** `tool(name, description, schema, handler,
  { alwaysLoad })` exists and is OR'd with the server-level flag, so "load some
  and not others" was a real option; it is rejected below on its merits rather
  than for being unavailable. The same extras object carries `searchHint`,
  which steers the search index. Nothing in the tree sets one.
- **The startup-latency objection does not apply the way it reads.** The
  warning that `alwaysLoad` "blocks startup until the server is connected
  (capped at the standard 5s connect timeout)" is attached to
  `McpStdioServerConfig`, `McpHttpServerConfig` and `McpSSEServerConfig` — the
  out-of-process transports — and it describes a **server-config** flag. The
  CLI's startup-wait filter reads `config.alwaysLoad` and, once tool search is
  on, waits only for servers that set it. `createSdkMcpServer` does not put
  the flag on the config it returns: it stamps `_meta["anthropic/alwaysLoad"]`
  on each registered tool and hands back a plain
  `{ type: "sdk", name, instance }`. So this change never enters that wait set,
  and the in-process server has nothing to connect to in any case. The reading
  that matters is the empirical one below: first frame did not move.
- The deferral is the API's mechanism rather than a client-side index: the
  shipped CLI binary contains `defer_loading`, `tool_search_tool_regex` and
  `tool_search_tool_bm25`, which is what makes both shapes priceable by
  `count_tokens`.

**The arithmetic, counted rather than estimated.**
`bun scripts/measure-show-block.ts --tokens` takes the schemas from the real
server — `createBrainUiMcpServer` with every handler supplied, listed over an
in-memory MCP client, which is the serialisation the CLI forwards — and prices
them with `count_tokens` on `claude-sonnet-5` in the two shapes the API
receives: a plain tool definition, and one carrying `defer_loading: true`
beside a tool-search tool. Both columns are measured against the same floor (a
search tool plus one undeferred tool, 682 tokens), so what is left is what this
decision is responsible for.

| bridge tool | in the prompt | its brief | brief lines |
| --- | --- | --- | --- |
| `show_block` | **5270** | 256 | 11 |
| `ask_user` | 756 | 87 | 4 |
| `query_activity` | 552 | 108 | 4 |
| `request_image_mask` | 383 | 110 | 5 |
| `get_current_location` | 374 | 94 | 4 |
| **all five** | **7335** | **655** | 28 |

Deferred: **93 tokens** for the whole set, and the same 93 for one deferred
tool as for five — the API prices the deferred set as a fixed block rather than
per tool. Both figures are insensitive to which tool-search tool is declared
alongside them: `tool_search_tool_bm25_20251119` and
`tool_search_tool_regex_20251119` give 93 and 7335 alike, differing only in
their own weight (682 against 710), which is subtracted as the floor either
way. The five per-tool rows sum to the measured all-five figure exactly
(374 + 756 + 552 + 383 + 5270 = 7335), so the floor subtraction is linear here
rather than hiding a per-request constant.

The brief column is counted the same way but against its own floor — the same
system prompt with and without that brief, no tools declared in either request.
Each column is a delta against a matched baseline; the two columns are not
measured in the same request and should not be added to a single "what the
prompt costs" figure.

Ten to one, then, and `show_block` is 5270 of the 7335: 72% of the bridge
surface is one eleven-variant union, 11,452 serialised characters of which
11,319 are a flat `oneOf` with no `$defs` and no `$ref`. **That ratio is the
number this decision was expected to turn on, and it is not what decided it.**

**The measurement.** `scripts/measure-show-block.ts`, nine prompts, two arms,
three repetitions, run once in each configuration: 108 live turns on
`claude-sonnet-5` against a copy of `packages/core/fixtures/corpus/`, $11.43 of
API spend, **every turn completed in both runs**. D43's counting rules carry
over unchanged — only calls whose argument parses through the contract's schema
count, subagent frames are skipped, an incomplete turn is excluded from every
rate. Two columns are new: per-turn input tokens as the SDK reports them, and
wall time to the first assistant frame.

| configuration | arm | a `show_block` call | ran `ToolSearch` | input per round-trip | first frame |
| --- | --- | --- | --- | --- | --- |
| deferred — what shipped | brief | 14 of 25 (**56%**) | 15 | 24,087 | 3897 ms |
| deferred | no-brief | 0 of 25 (**0%**) | 0 | 21,088 | 4549 ms |
| always loaded | brief | 19 of 25 (**76%**) | 0 | 26,694 | 4371 ms |
| always loaded | no-brief | 20 of 26 (**77%**) | 0 | 27,522 | 4716 ms |

**These runs were taken on the harness before `e017715` enforced the 180 s turn
budget it advertises**, which is the same correction that moved D43's
always-load arm from 19 of 24 to 17 of 22. Seven of the 108 turns ran over, six
of them the `trend` prompt, and the table above already excludes them the way
the enforced harness would. Left in, the four cells read 56%, 0%, 78% and 78%
over 27 turns each; the conclusion does not move either way, and the enforced
figures are published because they are what a re-run will produce.

D43's 77%/77% replicates at 76%/77%. Across the two runs that is 47–48 turns
per cell agreeing: **once the tool is in the prompt, the brief changes
nothing** — on rate, which is the only thing any of it measures.

The two no-brief arms isolate the schema as cleanly as this harness can —
neither searches, so the only difference between them is the schema in the
prompt: 21,088 against 27,522, a delta of **6434** against the 5270
`count_tokens` priced. Over non-delegating turns only, where `usage`'s
main-loop scope and `num_turns` cannot disagree, it is 20,279 against 26,296, a
delta of **6017**. The live run brackets the counted figure rather than
reproducing it: it confirms the sign and the order of magnitude, which is what
the decision rests on, and not the third digit.

A note on provenance, because the two tables below do not share a source. The
token columns come from the result message's `usage`, which the SDK documents
as the main agent loop only, divided by `num_turns`; the dollar column comes
from `total_cost_usd`, which covers the whole query pipeline including
subagents. Nothing here reasons across the two — the token claim and the cost
claim are made separately, and the cost table excludes delegating turns for
exactly the reason the scopes differ.

**What it costs, which is the part the ratio got wrong.** Turns that delegated
to a subagent are excluded from the cost comparison — a subagent's bill is
several times the turn's own and the two runs drew a different number of them
(11 and 10), so leaving them in measures delegation rather than loading.

| configuration | arm | turns | $ / turn | median $ / turn | rate |
| --- | --- | --- | --- | --- | --- |
| deferred | brief | 21 | $0.0559 | $0.0550 | 57% |
| deferred | no-brief | 22 | $0.0383 | $0.0327 | 0% |
| always loaded | brief | 23 | **$0.0594** | $0.0472 | 78% |
| always loaded | no-brief | 21 | $0.0475 | $0.0419 | 81% |

**Like for like, always loading the tool raised the bill by 6%** — not by the
ten to one the token ratio implies, and not by the 24% the isolated no-brief
comparison shows either. The reason is that the deferred configuration does not
avoid the schema; it postpones it. A tool search **appends** the matched
definition rather than swapping it, so from the search onwards every remaining
round-trip of that turn carries the full 5270 anyway — and the turn has also
paid for an extra model round-trip to get it. Measured across the shipped
configuration: turns that ran `ToolSearch` billed 25,715 input tokens per
round-trip against 21,247 for turns that did not. **Deferral saves the schema
only on the turns that never wanted the tool.**

First frame did not move in any direction the samples can distinguish
(3883–4449 ms deferred, 4277–4620 ms loaded; medians 3185–3804 against
3263–3553). The in-process server has no connect step to block on, and the
numbers agree.

**Decision. `createBrainUiMcpServer` sets `alwaysLoad: true`.** The bridge
tools ride every prompt. 20 percentage points of call rate for 6% of a turn,
no measurable latency, and the end of a structural fragility: under deferral a
tool's existence depended on a line of prompt text, so an editor shortening a
brief could silently remove a tool and no test would notice. That is not a
trade-off anyone would choose on purpose, and D43 found it by accident.

`tests/bridge-tools.test.ts` ("bridge tool loading posture") holds it: every
registered bridge tool carries `_meta["anthropic/alwaysLoad"]`, with a
companion test registering the same factory without the flag and asserting the
meta is absent, so the first assertion cannot pass vacuously.
`packages/ui-backend-claude/tests/sdk-options-mcp.test.ts` holds the same thing
one level up, over the `mcpServers` entry `createClaudeSdkTurn` actually builds
— the factory being right is not the same claim as the call site using it.

One thing this was checked against and does not do: it introduces no new cache
invalidation. The tools block is the first cache segment and this makes it the
largest, so a roster that varied between turns of a session would now be
expensive. It does not vary. `createBrainUiMcpServer` registers a tool when the
host supplies its handler, and the handlers come from the host's own
configuration (`packages/ui-server/src/ws/bridge.ts`) rather than from anything
the client reports per turn, so the set a session starts with is the set it
keeps.

**Why not keep deferral.** Its case is the 7335-against-93 ratio, and the live
run says that ratio does not reach the bill. Its second argument — that D42's
classification pass already reaches eight of the eleven kinds, so the extra
calls are redundant — holds as far as it goes, and the split table says the gain
is indeed concentrated there (9 of 18 to 15 of 18 on pass-reachable kinds, 6 of
9 either way on the three the pass cannot reach). But D42's own rule is that no
code path may depend on the pass having run: it needs a key, a live classifier
inside 2 s and an answer over the confidence gate, and a deployment missing any
of those gets nothing on those eight kinds unless the tool fires. Redundancy
with a conditional path is not redundancy.

**Why not a per-tool split.** The SDK allows one, so it was considered rather
than assumed away. It loses on coherence: the only tool with a measured
discoverability gap is also the expensive one, so loading "just the cheap four"
spends 2065 tokens on tools that have no measured problem and leaves the one
that does behind the search — and a surface where four tools are found one way
and the fifth another is a thing every later reader has to be told.

**Why `searchHint` is still unused.** It steers the search index, and the
search index is not where the loss was: over 54 turns in the deferred
configuration, 16 ran `ToolSearch` and 15 of those called `show_block`. The
search found the tool essentially every time it ran. The loss was in the model
not running one — and with the tools loaded there is no search to steer.

**What this means for backends that are not the Claude SDK.** Deferral is a
property of the Claude Agent SDK, not of the bridge, so this decision is scoped
to that backend. The backend-neutral obligation is one line: **a bridge tool
has to be in the model's context, and each backend says how.**

D43's pi section above already establishes that pi has no deferral to apply to
a statically registered tool and that its shipping configuration is therefore
the structural equivalent of the `--always-load` **brief** arm and of that one
only — pi has no no-brief arm, so it corroborates the loaded *rate* and says
nothing about whether the brief matters. That ground is not re-covered here. One detail found independently while deciding this and worth
adding to it: the mechanism is `splitDeferredTools` in pi's shipped bundle,
which puts a tool in the deferred set only when an earlier tool result added it
to the conversation and nothing has called it since. A statically registered
`ToolDefinition` can never satisfy that, which is why the absence of deferral
is structural rather than a default someone could flip.

What this decision adds to #137 is only that the Claude side has now moved: the
two backends were being compared across a configuration difference, and after
this they are not. The remaining height between them — **87% on pi over 60
turns against 76–77% here over 47–48**, roughly ten points — is #137's to
explain, and this entry makes no claim about it. The pi figure is the pooled
one over both runs (27 of 30 and 25 of 30); the 90% that circulated is the
first run alone, reported before a second existed, and the spread between them
is what 30 turns of sampling noise looks like on this measurement.

**One cross-backend result that outlives this decision.** The misses on the
always-loaded Claude arms are not spread thin — they concentrate in two kinds.
`contact` is 0 of 3 in both arms and `quote` 0 of 3 and 1 of 3, while six other
prompts are 3 of 3. On pi, pooled over 60 turns, `contact` is 5 of 12 and
`quote` 3 of 4, with every other prompt at full marks. **The same two kinds, on
two backends, in two different harnesses.** Two small samples agreeing is not a
result, but it is a better lead than a rate gap, and it is what #137 and #119
should be pointed at rather than the ten points.

**The two backends do not fail the same way, and the distinction is on two
different axes.** The concentration above is a *call-rate* one: which kinds the
model declines to draw at all. pi's one *wrong-kind* error is a different
dimension — `schedule` prescribed and `timeline` drawn, 4 times out of 4, a
kind reached reliably and reached for the wrong question, which a call-rate
metric cannot distinguish from a success. So `contact`/`quote` and `schedule`
are not two readings of one phenomenon and should not be merged into one.

That `schedule` miss carries one fact worth having before #157 is worked. The
clause the model failed to follow is stated **twice**, in near-identical words:
the brief says "`schedule` for what is coming", and the description says
"schedule: what is coming, grouped by day" (`schedule: what is coming`,
`packages/ui-sdk/src/tool-contracts/blocks.ts:727`, where it sits in the same
sentence as the `timeline` clause). The model drew the wrong one 4 of 4 with
both surfaces saying nearly the same thing. **Saying it twice did not fix the
miss** — which is evidence for the description-overlap arm on #157 and against
assuming duplication is harmless redundancy.

**The SDK-level harness used for this entry does not score kind at all**, only
the server-level one does, so any future Claude-against-pi comparison has half
an instrument until that changes — and a per-brief A/B has to score kind on
both sides, because the two backends' failures do not overlap.

**The prediction, with the condition that would falsify it.** If deferral is
the whole of the difference, this change moves the Claude backend *toward* pi's
87% and not merely upward from 56%. It has already landed at 76–77% in the
measurement above, which is short of pi on a better-powered comparison than
#137 was filed with — 60 turns against 47–48 — and the gap did not close. **That shortfall is the prediction
failing, not confirming**, and it says something besides deferral is also in
play — so #137's search stays live and this entry does not close it. The
honest claim is narrower than "the backends now agree": the configuration
difference is gone, and a residue of roughly thirteen points is not.

Two things stop that residue being read as a like-for-like gap, and both cut
against reading pi as a second replication of the brief result. pi is on a
different harness driving the model directly, and — this is the one that matters
— **pi has no no-brief arm and no supported way to have one.**
`block: "show_block"`, `packages/ui-backend-pi/src/session-resources.ts:165`
passes the block brief into `buildSystemPromptAppend` unconditionally, not
behind a capability check like `askUser`, `location`, `activity` and `mask` on
the lines above it. So every pi number was measured with the brief present. The
77%/77% and 76%/77% cells are one backend measured twice, not two backends
agreeing.

**A consequence for the brief that only exists because of this decision.**
Deferred, `show_block`'s *description* was not in the prompt either — it
arrived with the tool when a search fetched it — which is why D43 found the
brief was the only enumeration of the eleven kinds the model could see without
searching. Always-loading puts the description in every prompt, and the
description names all eleven kinds too: 11 of 11, with nothing in the brief's
enumeration that the description omits (2107 characters against the brief's
749). D41's decision 6 divides them — *"The brief says WHEN, the description
says HOW"* — and the brief does not honour it, enumerating all eleven with a
clause each. Under deferral that duplication was load-bearing. Under this
decision it is duplication, and the eleven kind names now ride every turn
twice. That is not a reason to cut anything here — nothing has been measured
against it, and the kind names are the one part of the brief whose removal a
rate metric could not detect — but it is a fact this decision created and #157
is where it is priced.

**What this changes in D43.** Its decision — the brief stays — stands, and its
measurement is the evidence this entry rests on; the deferral finding is D43's,
not this one's. What this supersedes is its *reason*. D43 kept the brief
because removing it took the rate to 2%, and that was true only of the
deferred configuration. With the tools loaded, the brief measures at no effect
at all: 76% with it and 77% without it here, 77%/77% there, 47–48 turns per
cell.
The brief is no longer the tool's discovery path, so whether it earns 655
tokens across five tools has to be re-argued on its own merits rather than
inherited. **#148 scoped the brief's wording out of this decision, so nothing
about it changes here** and its budget in
`packages/ui-sdk/tests/tool-contracts.test.ts` is untouched at eleven lines and
749 characters — now a ceiling on drift rather than evidence that the lines
earn their place. The question is #157.

**What is not claimed.**

- **Every rate in this entry scores whether a block was drawn, never which
  kind.** A turn that reached for `table` where `comparison` was right counts
  as a call in all of it, in both configurations and both arms. So "always
  loading raises the rate from 56% to 77%" is a claim about reaching for the
  tool and not about the answer being better. **Nothing here should be quoted
  as evidence that the surface draws the right block.**

  The same distinction applies to the brief, and it is the one most likely to
  be misused. The brief's text is mostly about *which* kind to pick rather than
  whether to pick one, so "the brief measures at no effect once the tools are
  loaded" is a **rate** claim, and reading it as a **content** claim is a
  category error. This entry's runs and D43's both support the first and
  neither touches the second.

  **Nothing else touches it either, and #50's kind-correctness pass on pi is
  not the exception it looks like.** Every pi turn was measured with the brief
  present — `packages/ui-backend-pi/src/session-resources.ts` passes it
  unconditionally and pi has no supported way to run without it — so it is a
  single-arm result and attributes nothing to the brief's content, in either
  direction. An earlier revision of this entry said it "points the other way"
  and "suggests the brief's content does measurable work". **Both are wrong for
  the reason this entry already gives about pi elsewhere**, and they are
  recorded here rather than quietly deleted because the same overreach reached
  D43 and was caught there by review.

  What the pass does establish is narrower and worth having: **kind-correctness
  is a scorable dimension with real variance, and a systematic error lives in
  it.** Pooled, 44 of 48 scorable turns drew the prescribed kind, and the whole
  of the error is one clause — `schedule` prescribed, `timeline` drawn, 4 times
  out of 4. So: nobody should read 76%/77% as licence to delete the brief's
  text, and nobody should read 44 of 48 as licence to keep it. #157 makes
  kind-correctness its metric, and that is a reason to measure before touching
  it rather than a prediction of how the measurement will come out.
- **Every figure here that came from another record was reconciled against
  that record's own primary table before being repeated, and the ones that
  could not be are named.** pi's 87% is read off #50's per-run breakdown (27 of
  30 and 25 of 30) rather than from a summary; D43's cells are read off D43's
  tables. Three of the five figure corrections in this lineage today arrived
  from *outside* the record — lifted from another document quoting an earlier
  version, or from one agent's account of one run — rather than drifting inside
  it, which is a different failure from prose disagreeing with its own table
  and needs the same discipline applied to inbound numbers, whoever sent them.
  What this entry cannot claim: **no pi turn was re-run or re-scored here.**
  Every pi number is #50's measurement, checked for arithmetic and provenance
  and not reproduced.
- One model (`claude-sonnet-5`, pinned so a re-run compares like for like) and
  one brain, a copy of `packages/core/fixtures/corpus/`. A larger brain means a
  larger base prompt, so the 7335 is a smaller share of it — and also more
  round-trips to pay it on.
- The cost figures are 21–23 turns per cell, and they are the least stable
  numbers here: mean and median disagree by up to 20% within a cell. The
  direction is consistent across both statistics and both arms; the magnitude
  is not to be quoted to two figures. **"6%" is the mean-to-mean figure in the
  brief arm and it is the weakest number in the headline** — the same
  comparison by median runs the other way, because the deferred arm's search
  round-trips sit in its tail. What both statistics agree on is that the ten to
  one the schemas imply is not what the turn pays.
- The two runs were taken in different windows against a shared rate limit, so
  wall-clock durations are not comparable between them and no claim here rests
  on one. First-frame latency is reported because it is what #148 asked for,
  and the honest reading of it is "no detectable difference", not a number.
- Only `show_block` was registered in the measured server, as it was in D43, so
  the live arms measure 5270 tokens of schema and the 7335 figure is the
  arithmetic for the roster a fully wired deployment registers. The four other
  tools' briefs have never been A/B'd against anything.
- `count_tokens` prices the deferred set as a flat 93 tokens whether one tool
  is deferred or five. That is the API's own accounting and it is what gets
  billed, but it means this entry cannot say what a sixth deferred tool costs.

**Reproducing it.**

```sh
bun scripts/measure-show-block.ts --tokens
bun scripts/measure-show-block.ts --reps 3 --concurrency 6 --out deferred.json --md deferred.md
bun scripts/measure-show-block.ts --always-load --reps 3 --concurrency 6 --out loaded.json --md loaded.md
```

Both need `ANTHROPIC_API_KEY` and the network; CI runs none of it. Note that
the harness's default arms now measure the shipped configuration only when
`--always-load` is passed, because what ships changed — the flag's name is left
alone so D43's invocations keep reproducing D43's tables.

**Re-checking it on a later runtime (#209).** The measurement above names only
the SDK. Its CLI half — the stamp reaches the model undeferred, and the server
config carries no `alwaysLoad` so the in-process server never joins the
startup wait set — is now the `d44-always-load-reaches-the-model` case of
`scripts/measure-claude-runtime.ts`, keyless, against the runtime
`MEASURED_RUNTIME` names. The latency and rate halves still need a live
model: `bun scripts/measure-show-block.ts --both-arms` runs both load modes in
one invocation and records the Claude Code version of every turn.

