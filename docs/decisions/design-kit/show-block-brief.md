# Design kit — show_block brief

Part of the [design-kit decision record](../design-kit.md). Entries retain their
original dates and order within this subject; the index maps the complete chronology
and relationships with [other subjects](../design-kit.md#subjects).

<a id="2026-09-22--d43-the-show_block-brief-stays-because-it-is-the-tools-only-discovery-path"></a>

## 2026-09-22 — D43: the `show_block` brief stays, because it is the tool's only discovery path

**Question.** D42 left it open: "whether `show_block` is still worth its brief
once the net exists (measure the tool's use rate after wave 14)". The brief
rides every turn, and the premise for retiring it was wave 13's number — five
comparison prompts, zero tool calls, after the prompt had been rewritten twice
— plus the classification pass now catching the common case structurally. If
the model never calls the tool for what the pass already reaches, most of the
brief is being paid for on every turn and returning nothing.

**Method.** `scripts/measure-show-block.ts`, an A/B over the **Claude
backend's** real SDK options — every rate in this record is that backend on
`claude-sonnet-5`, and the pi section below says why that qualifier is
load-bearing rather than pedantic. Nine prompts, two arms, six repetitions: 108
live turns, against a copy of `packages/core/fixtures/corpus/`, $7.15 of
API spend. The arms differ in exactly one thing — `buildSystemPromptAppend`'s
`tools.block`, which is what puts the brief in the system prompt. The tool is
registered, allowed and byte-identically described in both, so the `no-brief`
arm is precisely the "retire the brief, keep the tool" shape. Production's own
`createAgentHook()` is registered, so the 18 turns that delegated behaved the
way they do there rather than losing a backgrounded subagent at turn end;
18 of the completed turns delegated, 24 of all 108.

Four rules decide what counts, and each of them changed a number:

- **Only calls that would have rendered.** The argument has to parse through
  the contract's own schema; a rejected call drew nothing. An earlier run had
  three.
- **Subagent frames are not the answer.** `parent_tool_use_id` is non-null on
  frames a subagent produced, and the chat adapter keeps those off the surface.
- **The turn budget is enforced, not just advertised.** Production aborts a
  turn at `turnTimeoutMs` (`timeoutHandle = setTimeout`,
  `packages/ui-server/src/ws/run-session.ts:326`), so
  the harness aborts at the same 180 s. Without it an answer no reader could
  have received still scored: an earlier run had five turns of 190–306 s.
- **A turn that did not complete is excluded from every rate**, in both
  directions — not counted as declining to call the tool, and a call it made
  before failing does not count either. Six were excluded here, all on the
  budget, five of them `trend` (which delegates, and foreground subagents are
  slow). The exclusions are lopsided — five brief against one no-brief — and
  they fall on a prompt the brief arm otherwise wins, so 59% is if anything
  conservative.

Each turn's text parts then go through `planClassification`, the same entry
point `ui-server` calls, so a turn that did not call the tool is scored for
whether it left the pass a candidate. Detection is necessary but not
sufficient, so a candidate is an upper bound on what the pass would have drawn.

Named divergence from production: `disallowedTools` withholds `Bash`, `Edit`,
`Write`, `WebSearch` and `WebFetch`, where production withholds only
`AskUserQuestion`. `Bash` because the harness runs `bypassPermissions` on a
real host; `Edit`/`Write` because every turn shares one staged brain, so a
mutation would leak into every later turn in both arms; the two network tools
because a live search is neither reproducible nor free. It is identical in both
arms, so it cannot move the contrast — only where both arms sit. Checked
afterwards: every staged brain still matches the fixture corpus byte for byte,
except for an empty `.claude/` the CLI creates beside it, so no turn changed
what a later turn read.

**Numbers.** Claude backend, `claude-sonnet-5`, 102 completed turns of 108.

*Quote this entry from the tables in this section and the always-loaded one
below, never from a sentence — and give a figure that arrives from another
record, another agent or a summary the same treatment before repeating it.*
Five figures in this record had to be corrected within a day of writing it.
Two were numbers restated in prose that drifted from the table they came from.
**Three arrived from outside**: lifted from another document quoting an earlier
version of this one, or taken from one agent's summary of one run when the
pooled data said otherwise. A figure is reconciled against its own primary
table or it is not quoted, whoever sent it. The tables are the record; the
prose cites them.

| arm | turns | a `show_block` call | rate | no call, but a candidate the pass would see |
| --- | --- | --- | --- | --- |
| brief | 49 | 29 | **59%** | 6 (12%) |
| no-brief | 53 | 1 | **2%** | 33 (62%) |

Split by whether the pass can reach the kind — it reaches eight of the eleven
(comparison, table, steps, timeline, schedule, quote, receipt, stats) and has
no route to `trend`, `bars` or `contact`:

| kinds the pass reaches | arm | turns | calls | rate |
| --- | --- | --- | --- | --- |
| yes | brief | 35 | 21 | 60% |
| yes | no-brief | 36 | 1 | 3% |
| no | brief | 14 | 8 | 57% |
| no | no-brief | 17 | 0 | 0% |

> **2026-09-30 — Implementation context (D43's production deferral claim).** The
> [bridge server before D44](https://github.com/schlessera/brain-kit/blob/70e7ed3808c81a6aa5d59ea316dec9888851c155/packages/ui-backend-claude/src/ask-user-tool.ts#L104-L108)
> omitted `alwaysLoad`. The
> [D44 implementation](https://github.com/schlessera/brain-kit/commit/2efd725e233abefca36c25693cd362cf69a0b1bd)
> sets it, under the
> [D44 decision](https://github.com/schlessera/brain-kit/blob/2efd725e233abefca36c25693cd362cf69a0b1bd/docs/decisions/design-kit.md#L2522).
> The following production claim and rate tables describe the pre-D44 runs;
> they do not describe the current bridge-tool posture. The measurements remain
> evidence for D44's choice.

**Why the no-brief arm is near zero, which is the actual finding.** Not
reluctance. The SDK **defers an MCP server's tools behind tool search by
default** — they are not in the model's context at all until it runs
`ToolSearch` — and `packages/ui-backend-claude/src/ask-user-tool.ts:107` does
not pass `alwaysLoad`, so this is production's behaviour and the harness
inherits it. Over the two runs below — **run A**, 108 turns, taken before the
turn budget was enforced and therefore losing none, and **run B**, the 108-turn
run this entry's rate tables report, losing 6 to the budget — 210 completed
turns of 216. The two are a harness generation apart and the table pools them,
which is sound for this quantity because enforcing the budget changes which
turns are counted and not how the model reached the tool. Each run's rows are
printed by the harness itself under "`ToolSearch` against calls", so this is
reproduced rather than hand-assembled, and either generation can be read alone:

| run | arm | completed | ran `ToolSearch` | called `show_block` | called without searching |
| --- | --- | --- | --- | --- | --- |
| A (pre-budget) | brief | 54 | 33 | 33 | **0** |
| A | no-brief | 54 | 1 | 0 | **0** |
| B (enforced) | brief | 49 | 29 | 29 | **0** |
| B | no-brief | 53 | 3 | 1 | **0** |
| pooled | brief | 103 | 62 | 62 | **0** |
| pooled | no-brief | 107 | 4 | 1 | **0** |

**No turn in either run ever called `show_block` without first running
`ToolSearch`, and in the brief arm every turn that searched then called.** The
brief is the only text in the prompt that names the tool, so it is the only
reason the model goes looking. The one no-brief call came from one of the three
turns that searched speculatively.

Forcing the tools into the prompt (`--always-load`, eight prompts x two arms x
three reps, 44 completed turns) settles what the brief is doing. Same prompts,
default configuration on the left:

| `show_block` in the prompt? | brief | no-brief |
| --- | --- | --- |
| behind tool search — what shipped when this was measured | 23 of 43 (53%) | **1 of 47 (2%)** |
| always loaded | 17 of 22 (77%) | **17 of 22 (77%)** |

The two rows are a harness generation apart and it shows in the denominators:
the top row is run B, with the turn budget enforced, and the always-loaded row
was taken before that and is reported over the turns that finished inside the
same 180 s. That is why 22 rather than 24.

Identical, and higher than the brief reaches on its own. **The brief's entire
measured effect is discoverability, not persuasion.** Once the model can see
the tool, the brief adds nothing at all **to the rate**. That qualifier is
load-bearing and it is not a hedge: every figure in this entry scores whether a
block was drawn and never which kind, while the brief's text is mostly about
*which* kind to pick. Nothing here licenses deleting that text — see "What is
not claimed" below, and #157, which is where it is decided.

Per prompt in that loaded condition, which is the table the per-kind claims
below cite:

| prompt | brief | no-brief | combined |
| --- | --- | --- | --- |
| `compare-short` | 3/3 | 3/3 | 6/6 |
| `compare-long` | 3/3 | 3/3 | 6/6 |
| `table` | 3/3 | 3/3 | 6/6 |
| `steps` | 3/3 | 3/3 | 6/6 |
| `bars` | 3/3 | 3/3 | 6/6 |
| `trend` | 1/1 | 1/1 | 2/2 |
| `quote` | 0/3 | 1/3 | **1/6** |
| `contact` | 1/3 | 0/3 | **1/6** |

`trend` has two turns rather than six because the rest exceeded the turn
budget. `quote` and `contact` are the two kinds the loaded model declines, at
the same rate — but only one of them matters, and the difference is not the
rate. A declined `quote` leaves a blockquote, which the classification pass
turns into a `quote` block; that is the designed fallback working. A declined
`contact` leaves prose the pass has no route for (#132), so it leaves nothing.

**The pi backend does not reproduce any of this, and the reason is probably in
the code.** #50 measured pi at the server level and #137 records the gap: on
the same four prompts, same model, same corpus, pi called the tool on 52 of 60
counted turns (87%) across two runs against this record's 59% brief-arm rate in
the table above (pooling those two runs is sound because each pi turn is its
own session — `scripts/measure-show-block-server.ts`, which ships with #149
and is not in the tree yet, clears state per turn —
and because that harness excludes turns that never reached a result, the same
discipline as this one; the reason offered for it, that the classification pass
runs after the result frame, is true but answers a different question, since it
rules out the pass contaminating a turn rather than establishing that two runs
sample the same thing), and on the two prompts this record measured at zero — "Compare Bun and
Node.js … keep it short" at 6 of 6, `contact` at 3 of 6. (Figures from #137; an earlier
pi pass on `claude-sonnet-4-6` drew a block on 21 of 23 turns, which is a
different run and not the one above.) **No pi turn was run or re-scored for
this entry.** Every pi number here was reconciled against #137's own per-run
table for arithmetic and provenance before being repeated, which is a weaker
claim than having reproduced it, and the two should not be confused.

**pi has no deferral.** It registers `show_block` as a plain `ToolDefinition`
in its own tool list (the `showBlock` definition, `const showBlock`,
`packages/ui-backend-pi/src/bridge-tools.ts:266-277`, and the unconditional
push into `tools`, `const tools: ToolDefinition[]`, `:279-282`);
there is no MCP server, no tool search, and no `alwaysLoad` to set, so the tool
is in the prompt on every pi turn by construction. That makes pi's shipping
configuration the structural equivalent of this record's `--always-load`
**brief** arm — and only that one. pi has no no-brief arm and no supported way
to have one: `block: "show_block"`,
`packages/ui-backend-pi/src/session-resources.ts:165` passes the
block brief unconditionally, where the four lines above it gate their briefs on
a capability. So pi can corroborate the loaded *rate* and can say nothing at
all about whether the brief matters; the 77%/77% here and #148's 76%/77% are
one backend measured twice, not two backends agreeing. It is also not the
Claude backend's configuration as this entry measured it, and `--always-load`
is the controlled
version of the same comparison: it flips deferral alone, on one backend, one
model, one host. Flipped, this backend also calls on `compare-short` — 3 of 3
in both arms, against 0 to 6 of 6 depending on the run when deferred — and also
stops caring whether the brief is present.

What that does NOT settle, and #137 owns:

- **The remaining height.** pi's 87% over 60 turns against 77% always-loaded
  here, and #148's 76–77% over 47–48 on the shipped configuration, is a real
  gap of about ten points, and deferral does not explain it.
- **`contact`.** 3 of 6 on pi against 1 of 6 loaded here. Six turns a side is
  not enough to call a difference, and this record should not be read as
  having found one.
- **The method difference.** #50 drives the whole server over a socket; this
  harness drives the Agent SDK directly. #137 names a host-isolation confound
  on the Claude side of its own comparison that has to be closed first.

The prediction this makes is falsifiable, and #148 has since checked it: if the
Claude backend adopts `alwaysLoad: true`, its numbers should move toward pi's
87% rather than merely upward. **They landed at 76–77%, short of it.** In
points, which is the only form that does not depend on a chosen baseline:

| step | rate | moved |
| --- | --- | --- |
| Claude, deferred, no brief | 2% | — |
| Claude, deferred, brief (this entry's headline) | 59% | +57, the brief |
| Claude, always-loaded (#148, shipped) | 76–77% | +17 to +18, the loading |
| pi, always-loaded by construction | 87% | **+10 to +11, unexplained** |

Stated as a fraction it is whatever the denominator is chosen to be — an
earlier revision of this entry said "roughly a third" without showing which,
which is the failure this entry's own quoting rule is about. Ten points is the
measured distance and it is what #137 owns. So the
prediction partly failed, which is the useful outcome — deferral is not the
whole cause, and whatever else separates the two backends is #137's to find.
About ten points of the gap this record attributed to deferral is unexplained
by it, now on 60 pi turns against 47–48, which is better powered than the
comparison #137 was filed with and did not close.

**Decision. The brief stays, unchanged.** On the Claude backend, in the
configuration this entry measured — tools deferred behind tool search, which
#148 changes the same day — it is
not encouragement to use a tool the model can already see; it is the only thing
that tells the model the tool exists. Retiring it does not lower the rate from
59% to something smaller — it takes the rate to the noise floor and makes three
block kinds unreachable by any path. It costs 257 input tokens per turn (11
lines, 749 characters, counted by `count_tokens` rather than estimated), and
`packages/ui-sdk/tests/tool-contracts.test.ts` pins both budgets at what was
measured — eleven lines, down from `< 15`, and 749 characters, because eleven
long lines cost more than twelve short ones.

"Shorten it to the kinds classification cannot reach" loses for the same
reason, and more sharply than the split table alone would show: a brief naming
only `trend`, `bars` and `contact` leaves the other eight kinds
*undiscoverable*, not merely unencouraged. D42's own rule is that no code path
may depend on the classification pass having run — and where the pass cannot
reach at all, its fallback is not a missing block but a wrong one: the
`no-brief` turns on `trend` and `bars` left `table` candidates, which would
have drawn a data table where the answer was a trend.

**What this corrects in D42.** D42 opens "wave 13 measured the comparison
prompt at 0 of 5 … prompt text is not the lever." Its decision stands and the
pass earns its place, but that framing is now wrong twice over. Four of those
five runs were the same prompt, and the deferral finding says the brief is not
"prompt text" in the sense that sentence means — it is the tool's discovery
path, and removing it removes the tool. The lever that actually governs the
rate is neither the brief's wording nor the pass: it is whether the tool is in
the prompt at all.

**Three findings this surfaced, filed rather than fixed here.**

- `alwaysLoad: true` on the bridge MCP server reaches 77% with no brief at all.
  That is the real lever and it may supersede the brief entirely, but it
  changes the backend rather than the advertisement, which #45 scoped out.
- `contact` is barely reachable by anything: 0 of 12 across both default arms
  and 1 of 6 with the tool loaded. It is not uniquely low — `quote` is also 1
  of 6 loaded — but it is uniquely *consequential*, because a declined `quote`
  still reaches the reader through the classification pass and a declined
  `contact` reaches them as prose.
- The pass has no route to `contact` or `trend`, though D42's decision 6
  specifies both. Every transform in `classification/catalogue.ts` returns one
  of eight kinds and `CandidateKind` has no number series. That is a
  discrepancy between this record and the code, not a measurement result.

**What is not claimed, and this is the limit that matters most.** Every figure
here scores *whether* a block was drawn, never *which kind*. A model that
reaches for `table` where `comparison` was right, or `timeline` where
`schedule` was right, scores identically in all of it. So "the brief's entire
measured effect is discoverability" is a claim about the **rate** and says
nothing about whether its content — which is mostly *which* kind to pick —
does work. Nothing measured anywhere yet answers that, on either backend.

#50's kind-correctness pass on pi — 23 of 25 scorable turns drawing the right
kind, with one systematic miss (`schedule` prescribed, `timeline` drawn, 2 of
2) — is sometimes read as evidence the brief's content works. It is not, and
this record refused the same move 100 lines above: pi has no no-brief arm, so
every pi turn was measured **with the brief present** and a single-arm result
cannot attribute anything to it. What that pass does establish is narrower and
still useful: **kind-correctness is a dimension with real variance**, it can be
scored, and a systematic error lives in it that every rate table on both
backends is blind to. That is a reason to measure the brief on kind-correctness
before touching it, not evidence of how that measurement will come out.

So nobody should read the 77%/77% as licence to delete the brief's text, and
nobody should read pi's 23 of 25 as licence to keep it. #157 is where it is
decided and it needs a two-armed, kind-scored measurement, which nothing has
run.

Per-prompt rates are noisy — `compare-short` measured
0 of 6, then 5 of 6, then 6 of 6 across three runs of the corrected harness,
because the variance is in whether the model spends a `ToolSearch` round-trip,
not in whether it wants a block. Only the arm-level contrast is stable, and it
is stable because it is a discoverability effect rather than a preference. One
model, one backend: every number here is `claude-sonnet-5` on the Claude
backend, driven through the Agent SDK directly. A reader who takes any of them
as "the block rate" will be wrong on pi, and wrong on this backend too once
`alwaysLoad` ships. `scripts/measure-show-block-server.ts` — #50's harness,
which arrives with #149 and is not in this tree — is the instrument for the
other level — it drives the whole server over a real socket
and is backend-agnostic, so it sees the classification pass, the wire frames
and the client that this harness, sitting below all three, cannot.

**Reproducing it.** `bun scripts/measure-show-block.ts --reps 6 --concurrency 6
--out runs.json --md report.md`, with `ANTHROPIC_API_KEY` set. The
always-loaded table is a different shape — eight prompts at three reps, not
nine at six, with `recommend` the one this entry's nine that it omits:

```sh
bun scripts/measure-show-block.ts --always-load --reps 3 --only \
  compare-short,compare-long,trend,contact,table,steps,quote,bars
```

It is a script and not a test: it needs
the network and a key, so CI never runs it. Re-run it before changing the brief
again.

