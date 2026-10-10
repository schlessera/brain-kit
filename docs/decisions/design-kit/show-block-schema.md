# Design kit — show block schema

Part of the [design-kit decision record](../design-kit.md). Entries retain their
original dates and order within this subject; the index maps the complete chronology
and relationships with [other subjects](../design-kit.md#subjects).

<a id="2026-09-25--d47-show_blocks-schema-can-lose-a-tenth-through-definitions-not-half-and-nothing-ships-until-a-keyed-run-says-the-api-and-the-model-accept-it"></a>

## 2026-09-25 — D47: `show_block`'s schema can lose a tenth through `definitions`, not half, and nothing ships until a keyed run says the API and the model accept it

> **2026-10-08 — Superseded choice.** This entry describes the former flat
> shipped form and its keyless estimates. The #336 measurement and #563
> provider-acceptance decision below select the shared and trimmed form.
> Its old counts remain historical; they do not describe the new default.

**Question.** D44 put the bridge tools in every prompt and priced `show_block`
at 5270 of their 7335 tokens, and its input schema is emitted flat, with no
`$defs` and no `$ref` (`BLOCK_SCHEMA`, `packages/ui-sdk/src/tool-contracts/blocks.ts:698-701`).
#155 asked where those characters go, whether a shared-definition form is
reachable through the path the schema actually takes, and what a reduction
would do to D44's arithmetic. This entry is keyless: no `count_tokens` call and
no live turn was made, so every token figure below is an estimate and says so.

**The instrument.** `bun scripts/attribute-show-block-schema.ts` lists the
tools `createBrainUiMcpServer` registers over an in-memory MCP client — the
serialisation `measure-show-block.ts --tokens` prices — and splits each variant
of the `block` union into three parts that always sum to it: **prose** (every
`description`, measured as the variant's length minus its length with every
description removed), **repeated structure** (the outermost subtrees, with
descriptions removed, that also occur elsewhere in the union and are longer
than a reference to them would be; only schema positions count, so an `enum`
array or a `properties` map never does), and **irreducible** shape, which is
what the other two leave. `tests/attribute-show-block-schema.test.ts` pins the
counting rules against columns worked out by hand.

**How the token figures are estimated, and how far to trust them.** They are
characters times a rate, given as a range. The rate comes from D44's five
counted rows, each set against the characters that tool carried at D44's
commit (`2efd725e`): its description plus its input schema, both as
`JSON.stringify` writes them. D44's count also included the prefixed tool
name (23–35 characters), which the intercept absorbs.

| tool | chars (description + schema) | counted tokens | fitted | residual |
| --- | --- | --- | --- | --- |
| `show_block` | 2117 + 10,653 = 12,770 | 5270 | 5269 | 1 |
| `ask_user` | 684 + 1313 = 1997 | 756 | 778 | −22 |
| `query_activity` | 905 + 525 = 1430 | 552 | 542 | 10 |
| `request_image_mask` | 665 + 371 = 1036 | 383 | 378 | 5 |
| `get_current_location` | 768 + 246 = 1014 | 374 | 369 | 5 |

Least squares gives **tokens = 0.4168 × chars − 54.1**. The slope is the
marginal cost of one more character of tool definition, and that is what a
change to the schema moves, so it is the rate to apply to a *difference* in
characters. It is not a rate to apply to a whole tool on its own: the
intercept is not zero, and schema characters alone at 0.4168 would put
D44's `show_block` at about 4,440, not 5270, because the description is part
of what was counted. Refitting with each row left out in turn moves the slope
between **0.390 and 0.417**. The low end is the fit without `show_block`, the
only large row and the one with most of the leverage. That range is the width
of every token figure in this entry. The fit has limits beyond its five rows:
the API renders a tool in its own format rather than as this JSON, so a
character is only a proxy, and applying an average rate to a specific cut
assumes the characters removed tokenise like the average character of these
five tools. Enum values and English descriptions are the bulk of both, which
is why it is a usable estimate and not a count. The script prints this table
and these limits with every run. A two-rate fit, with prose and structure
priced separately, was tried and dropped: five rows cannot tell the two rates
apart.

**The attribution on `main` today.** The schema is 10,734 characters, 10,610 of
them the union; the tool description the model also reads is another 2,309.
The last column is the prose that restates `SHOW_BLOCK_DESCRIPTION`, classified
by hand from `--prose`. It is 21 descriptions, among them "Three fit a phone;
four only on a wide screen", "Omit when there is no comparison", "Right-align
numbers", the `bars` tone's "class of work" sentence (word for word), the
`steps` variant legend, "Reserved for the one event still happening", "What is
coming, grouped by day", and "pre-formatted" on four value fields.

| variant | chars | prose | repeated structure | irreducible | ≈ tokens | prose that restates the description |
| --- | --- | --- | --- | --- | --- | --- |
| `comparison` | 1704 | 866 | 184 | 654 | 664–711 | 296 |
| `receipt` | 1173 | 625 | 277 | 271 | 457–489 | 100 |
| `contact` | 1108 | 523 | 197 | 388 | 432–462 | 0 |
| `trend` | 991 | 555 | 80 | 356 | 386–413 | 269 |
| `stats` | 983 | 559 | 92 | 332 | 383–410 | 148 |
| `table` | 887 | 242 | 80 | 565 | 346–370 | 37 |
| `schedule` | 838 | 280 | 80 | 478 | 327–350 | 48 |
| `quote` | 761 | 454 | 0 | 307 | 297–317 | 48 |
| `steps` | 753 | 319 | 0 | 434 | 294–314 | 186 |
| `bars` | 747 | 331 | 80 | 336 | 291–312 | 331 |
| `timeline` | 653 | 224 | 80 | 349 | 255–272 | 101 |
| **all 11** | **10,598** | **4978** | **1150** | **4470** | **≈ 4133–4420** | **1564** |

The token column is each variant's characters times the 0.390–0.417 range.
It is the marginal cost of that many characters, not a share of 5270.

Three shapes make up all the repeated structure: the `tone` enum (six sites,
80 characters each), the `valueTone` enum (five sites, 92 each) and the
`{k, v, tone}` fact row `receipt` and `contact` share (two sites, 197 each).
Among the prose, three descriptions repeat verbatim: the `valueTone` doc five
times, the `tone` doc five times and the `icon` doc three times — 1,447
characters, more than a quarter of the union's prose, spent saying the same
thing again.

The filing's figures — 11,452 characters, of which the `oneOf` was 11,319 —
do not reproduce. Listing the tools at D44's own commit (`2efd725e`, Agent SDK
0.3.278) gives 10,653, and so does `z.toJSONSchema` with `io: "input"` at every
earlier revision of `blocks.ts`; `io: "output"` gives 11,407. The calibration
above uses the figure that commit's code produces.

**Is `$defs` / `$ref` reachable? Yes, by one route.** The Agent SDK bundles its
own MCP server, whose `tools/list` handler converts a tool's Zod shape with
`toJSONSchema(schema, { target: "draft-7", io: "input" })` and nothing else.
So Zod's `reused: "ref"` — the option that would share every repeated schema
automatically — cannot be passed; it was measured anyway by calling Zod
directly, and it makes the schema **larger**, 12,929 characters against
10,734 on the same tree (12,848 against 10,653 at `2efd725e`), because it
references every reused instance down to the bare strings and wraps each
reference in `allOf`. The route that works is Zod's registry: a schema that
carries `.meta({ id })` in `globalThis.__zod_globalRegistry` is always
extracted, whatever `reused` says, and the SDK's bundled Zod reads the same
global registry as the tree's. Given ids to three shapes — `valueTone` and
`tone` each with their description folded in, and `icon` —

```ts
const valueToneField = valueTone.describe(valueToneDoc).meta({ id: "valueTone" });
const toneField = tone.describe(toneDoc).meta({ id: "tone" });
// ...each `valueTone.optional().describe(valueToneDoc)` becomes `valueToneField.optional()`,
// each `tone.optional().describe(toneDoc)` becomes `toneField.optional()`,
// and `icon` gains `.meta({ id: "icon" })`.
```

— the schema the server registers goes from 10,734 characters to **9,493**,
with a three-entry `definitions` table and thirteen
`{"allOf":[{"$ref":"#/definitions/<id>"}]}` sites. An id is metadata, not a
check, so nothing a variant accepts should move; #336 asks for the round-trip
test that proves it. The script checks this independently of Zod. It
applies the same sharing as a transform of the listed JSON, checks that
dereferencing the result gives back the original, and gets the same three
shapes at the same thirteen sites, 1,267 characters shorter. The 26
characters between the two are serialisation detail (the ids and key order),
not a different reduction. Giving the enums ids without folding their
descriptions in saves only 255, because the description then stays at every
site.

**Would the API accept it? Documented, not demonstrated.** The platform docs'
JSON Schema limits for strict tool use list `$ref` and `definitions` as
supported, and a non-strict tool is held to less than that. The Claude Code
binary the SDK ships (0.3.280) marks a tool strict only when the tool says
`strict: true`, which `show_block` does not, and nothing found in its
tool-definition path rewrites references. One trap is worth recording: the
same limits list "`allOf` with `$ref`" as unsupported under strict tool use,
and that is precisely the form Zod's draft-7 output takes. It does not apply
today; it would the day anyone makes `show_block` strict. The pi backend is a
second serialisation: it converts through `toolInputJsonSchema`
(`toolInputJsonSchema`, `packages/ui-sdk/src/tool-contracts/contract.ts:101-109`),
which uses Zod's default
draft-2020-12 target, so the same ids would put `$defs` into every schema pi
sends to its providers. And registry ids are process-global, so an id any
other schema in the process also uses collides.

**What it would do to D44: an illustration, not a bound.** The 1,241
characters come to ≈ 480–520 tokens, about a tenth of `show_block`'s 5270
and 7% of the 7335. That is far from the half at which #155 thought D44's
arithmetic might change sign. For scale, D44's always-loaded brief arm
averaged 26,694 input tokens per round-trip, so the cut is about 2% of that
average. That comparison holds only if everything else about a turn stays
the same: the same round-trips, the same output, and the same mix of cached
and uncached input. None of that is established. A turn's bill weights cache
reads, cache writes, uncached input and output differently. D44 kept its
token and dollar populations apart for exactly that reason. And a schema that
changes what the model sends can change how many round-trips a turn takes,
which could move the bill by more than 2% in either direction. So this entry
draws no conclusion about D44's 6% beyond this: a cut of this size is not
the kind D44's reasoning turned on. Dropping the 1,564 characters of
restated prose would add ≈ 610–650 tokens on the same footing. **Whether
either one moves the bill is #336's to measure.**

**Decision. Nothing ships from #155.** The reduction is real and reachable,
but a keyless spike cannot show that the API accepts the `definitions` form
on both backends, and neither the shared definitions nor the missing prose can
be shown not to move the call rate or the rate of calls that parse — the only
things D43 and D44 measured that the reader sees. A change to what the model
reads on every turn goes out with its A/B, as D44's did. #336 holds the
keyed work: price the patch with `--tokens`, send it once per backend, and A/B
it in the loaded configuration. D44's 5270 stands until that entry supersedes
it.

**Rejected.** *Zod's `reused: "ref"`:* unreachable through the SDK's path, and
a fifth larger when forced. *Sharing the `{k, v, tone}` fact row:* 197 characters
at two sites, where `receipt`'s copy carries two descriptions `contact`'s
does not, so there is nothing identical left to share once the descriptions
are counted. *Moving `blocks.ts` to plain JSON Schema to escape Zod's `allOf`
wrapper:* the SDK's `tool()` takes a Zod shape, and one source of truth for the
schema, the parser and the renderer's types is worth more than eleven
characters per reference.

<a id="2026-10-07--measured-claude-accepts-all-three-schema-forms-the-shared-and-trimmed-form-saves-1146-counted-tokens-336"></a>

## 2026-10-07 — measured: Claude accepts all three schema forms; the shared and trimmed form saves 1,146 counted tokens (#336)

**Question.** D47 identified two schema reductions but had no live provider or
behavior evidence. This measurement holds the eighteen current variants and
accepted inputs constant and compares `flat`, `shared`, and `shared-trimmed`
on **`claude-sonnet-5-5`**. It measures the Claude half; the cross-backend
shipping decision remains #563's.

**Counted definitions.** The Agent SDK's actual MCP listing, including the same
4,918-character tool description in every arm, was counted by `count_tokens`
under `CLAUDE_CODE_OAUTH_TOKEN`. The tool-search-plus-anchor floor is **616**
tokens. The flat arm is byte-identical to the production listing. The shared
forms contain three definitions and sixteen reference sites; the trimmed
form removes the same 23 descriptions pinned by the parser/listing tests.

| form | input-schema JSON characters | loaded tokens | change from flat |
| --- | ---: | ---: | ---: |
| flat | 16,702 | 8,723 | 0 |
| shared | 15,136 | 8,157 | −566 (6.5%) |
| shared-trimmed | 13,344 | 7,577 | −1,146 (13.1%) |

The full block brief costs 254 counted tokens, nine lines and 705 characters.
These are the endpoint's counts of the frozen definitions, not a claim that
every live round-trip loses exactly that many input tokens.

**Method and isolation.** Nine frozen prompts—compare-short, compare-long,
trend, contact, recommend, table, steps, quote and bars—ran three times per
form: **81 fresh turns, 27 per arm, no exclusions**. Every arm loads the bridge
server and block brief. Each form occupies each order position once across
the three repetitions. Concurrency is two; each turn has the same fourteen
model-turn limit, 180-second deadline and SDK `maxBudgetUsd: 1` threshold.
None censored a turn. The threshold is checked after generation and is not a
hard billing cap.

Bun 1.3.14, Agent SDK 0.3.283 and Claude Code 2.1.283 were used. Every raw init
reported model `claude-sonnet-5-5` and `apiKeySource: none`. The fictional
Odysseus corpus was staged outside a home directory and checkout; HOME and
config were empty, account credential files were never copied, automatic
memory was disabled, and no other subscription measurement overlapped.
The same execution hook bounded Read/Glob/Grep to the staged fixture and
denied delegation and other tools in every arm (`optionsFor`,
`scripts/measure-show-block.ts:398-466`). This permission restriction and the
one-tool MCP server remain measurement divergences from production. The
actual installed CLI denied a controlled outside Read and admitted an inside
Read under bypassPermissions; removing its hook exposed the sentinel and
failed the expected assertion. All **332** live hook verdicts were allowed
fixture reads/searches or block calls; none named an outside target.

Different-family review covered the frozen prompts, schemas, counters and
execution guard before inference. Historical corpus model authorship was
unknown, so a complementary Sonnet 5.5 review also examined all textual
fixture files and canonical facts; binary fixtures were digest-only. It
returned APPROVED. Native stdout capture preserves split UTF-8, final JSON
without a newline and error-result receipts even when a consumer throws.

**Observed behavior.** A call-rate numerator requires at least one parsed
block in a completed turn. Parse rate counts every attempted block call,
including a rejected call followed by a valid retry.

| form | completed / attempted | turns with parsed block | call rate | parsed / attempted calls | parse rate |
| --- | ---: | ---: | ---: | ---: | ---: |
| flat | 27 / 27 | 21 | 77.8% | 22 / 22 | 100% |
| shared | 27 / 27 | 21 | 77.8% | 23 / 24 | 95.8% |
| shared-trimmed | 27 / 27 | 21 | 77.8% | 22 / 22 | 100% |

The shared form's compare-long turn in repetition two first sent `block` as a
string, which failed the object parser, then sent a valid block. Every contact
and steps prompt produced no block in every arm; the other seven prompts
produced one on every repetition. Completed shared-form turns demonstrate
provider acceptance of both definitions-based request shapes. Equal observed
call rates in this small repeated prompt set do not establish behavioral
equivalence or bound regressions on other prompts.

**Usage and money.** Independently priced API equivalents sum to **$4.0214248**:
flat $1.3931550, shared $1.3425880, trimmed $1.2856818. The complementary review
adds $0.079636. These use actual modelUsage tokens and cache-write TTL counts,
not SDK fallback dollar estimates (`priceSonnet55Usage`,
`scripts/measure-sonnet55-cost.ts:28-51`), against the
[official Sonnet 5.5 rates](https://platform.claude.com/docs/en/models/sonnet-5-5/overview)
as published on 2026-10-07, when the table gave $0.20 per million cache reads;
the current rate is $0.10 (#1239). These totals are unchanged.
All scored cache writes had known TTLs. Cache state, output length and retries
also move these totals; they are diagnostics, not an isolated estimate of the
schema reduction's dollar effect or a subscription billing receipt.

All 86 captured rate-limit events reported `isUsingOverage: false`; no
additional billed overage was observed. The
[maintainer's caps](https://github.com/schlessera/brain-kit/issues/838#issuecomment-6038531493)
apply to actual additional charges. The counter is
[free to use](https://platform.claude.com/docs/en/build-with-claude/token-counting).
Historical Sonnet 5 controls remain excluded: 42 completed and two
interrupted attempts, $3.0837498 known-plus-recovered partial SDK estimates,
two missing tails and an unknown aggregate. No final provider bill is asserted
for those interruptions. Unknown SDK price provenance is tracked in #1206;
missing error-result accounting is #1191.

**Evidence and consequence.** The [sanitized per-turn artifact](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/docs/decisions/design-kit-schema-forms-2026-10-07.json)
retains all 81 cells, token columns, verified prices, rate flags, isolation
verdicts and frozen source/schema/corpus identities. Claude accepted both
reductions, and the counted saving is real. This result does not switch the
shipped flat form; #563 owns pi's acceptance and the shipping choice.

<a id="2026-10-08--d47-superseded-ship-shared-definitions-and-trimmed-prose-after-both-serializers-accept-them-563"></a>

## 2026-10-08 — D47 superseded: ship shared definitions and trimmed prose after both serializers accept them (#563)

**Decision.** Ship `shared-trimmed`: define `tone`, `valueTone` and `icon` once,
and remove the 23 field descriptions that restate the tool description. Tool
names, all eighteen variants, accepted inputs, validation and handler output
remain unchanged. The historical `flat`, `shared` and `shared-trimmed` arms now
have explicit options independent of the shipped default. Production-factory
checks cover Claude's actual MCP listing and Pi's actual bridge parameters;
removing the icon registry id fails each backend's named definitions assertion.
The accepted/refused round trips still compare all three forms.

**Evidence from both serializers.** #336's 81 fresh Sonnet 5.5 turns completed
27 per form; 21/27 turns in each form contained a parsed block. Its frozen
counted MCP listing was 8,723 / 8,157 / 7,577 tokens for flat / shared / trimmed,
a 1,146-token (13.1%) reduction for the selected form. One shared-form block
was rejected before a valid retry; trimmed parsed 22/22 attempts. These are
that measurement's model, listing, counter and SDK/CLI versions, described
above, not a current-runtime recount or a behavioral-equivalence guarantee.
D44's historical 5,270 and D47's keyless estimates remain qualified by their
original listing/version; the measured #336 table supersedes them for this
frozen listing. No new runtime or model default is selected here.

Pi separately sent the actual non-strict draft-2020-12 `$defs`/`$ref` parameters
through installed `@earendil-works/pi-coding-agent` 0.99.2 to `openai-codex` /
`gpt-6.1-sol`, using Bun 1.4.2 and the ruled existing native ChatGPT login in a
read-only memory adapter. One natural, reviewed note-approaches prompt was
used per form, with the same reviewed 31-file fictional corpus. No login,
refresh, credential-file copy, alternate key, paid fallback or automatic model
retry was performed. Empty owned homes/settings, fixture-only tool execution
and read-only source/runtime mounts bounded private-data access; the live
network namespace was shared and the selected fetch route was guarded.
Actual isolated-network server/parser/handler controls preceded inference.

| Pi form | logical turn completed | parsed comparison calls | unique physical requests | strict transport guard |
| --- | --- | ---: | ---: | --- |
| flat | yes, after local prefix rehydration | 1 | 2 | failed; historical natural upstream EOF unknown |
| shared | yes | 1 | 2 | passed, natural upstream EOF observed |
| shared-trimmed | yes | 1 | 2 | passed, natural upstream EOF observed |

**Retained failures and continuation.** The original flat request returned a
completed exact-model comparison but its observer rejected its required
media-type condition before the handler received it; the exact original
content-type was not saved and remains unknown. Its failed server session remains
unsuccessful. The preserved response was `response.text()` saved as UTF-8;
replay preserved those exact file bytes, not independently recorded HTTP-wire
response bytes. An independently reviewed local replay rehydrated that one
actual response into the real Pi parser and handler, preserving original
prompt, instructions, tools, model, call identity, arguments and handler result.
The reconstructed server/cache key differed; this was continuation of the same
logical context, not the same server session or unchanged request wire.

One native flat continuation completed, but the old observer mistook Pi's
normal consumer cancellation after `response.completed` for upstream EOF,
then failed closing an already closed controller. The completed provider/model
and parsed-handler evidence is valid; its strict transport guard remains
failed and natural upstream EOF remains unknown. After real delayed-EOF and
preterminal-cancellation controls and mutations, an ordered observer drained
independently to natural EOF before any next request or final admission.
Only the two originally remaining shared forms were then dispatched; flat
was never inferred again. Both fresh shared turns passed all request/model,
handler, usage, EOF and lifecycle guards and exited zero.

**Accounting and limits.** Six unique physical requests are retained, including
both historical flat requests exactly once: 66,266 raw input, 1,084 output and
21,248 cache-read tokens. Physical usage reconciles with each logical SDK
aggregate. Each form stayed below five requests and the total below fifteen.
No included-only limit or credit-decrease stop was observed. Actual additional
charges and invoices remain unknown; SDK dollar fields are diagnostics, not
bills. Account-identity equality across the historical stopped boundary cannot
be proved by the saved auth-selector booleans; no fingerprint is invented.
Account/quota/credit details and raw opaque headers stay in protected receipts.

This is provider request/parsed-handler acceptance for the named OpenAI route,
not a Pi call-rate, quality, cache or cost-saving experiment. Other Pi providers
were not tested. The equal first-request input count for flat/shared and the
smaller trimmed count are individual observations, not an isolated token
counter or a general saving. The small Claude sample also does not establish
equivalence on other prompts. These limits qualify the selected representation;
they do not change any accepted input or infer a new API/runtime/model adoption.

The [sanitized six-request artifact](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/pi-schema-2026-10-08/results.json)
and [executed-input hashes](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/measurements/pi-schema-2026-10-08/executed-inputs.json)
bind the exact remaining-arms admission `a46ca0ba…`, historical `3d58bf7c…`
and original prefix. They retain all failures, raw usage, schemas and accepted
handler evidence without account identities, credit balances or quota details.
Published current instrumentation is parameterized and now preserves historical
arms; literal executed source/runtime and complete private receipts remain
bound to the recorded protected manifests. No further inference was made.

