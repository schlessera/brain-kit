# Audit suggestions and executable repair capabilities

Investigation for [#841](https://github.com/schlessera/brain-kit/issues/841),
under [#838](https://github.com/schlessera/brain-kit/issues/838)'s protocol.
Source discovery used main `44be3840f9fb74ea3ce62ebd6f65696aee745863` on
2026-10-02. The private controls make no paid requests and change no shipped
audit command, skill, severity or JSON contract.

## The current boundary

`audit --fix` sends severity, path, finding message and existing suggestion to
one completion; it supplies neither document contents nor configured taxonomy.
The returned array's paths, membership, booleans and replacements are not
validated against findings or available handlers (`suggestFixes`,
`packages/core/src/cli/commands/audit.ts:26-67`). Missing provider, invalid JSON
and completion exceptions fall back to the existing suggestions with
`canAutoFix: false`. A parsed empty array can omit every finding; a parsed
replacement or `canAutoFix` claim establishes no executable repair.

The command prints suggestions and never applies them (`auditCommand`,
`packages/core/src/cli/commands/audit.ts:70-125`). Its real indexed-file control
accepts an invented `../outside.md` replacement from a scripted provider while
leaving all document bytes and the ordinary audit report unchanged. The prompt
contains the unresolved target but omits the source body's identifying text.
This proves the parser/context boundary, not a vendor's observed failure rate.

Ordinary audit detection is separate from validation. Malformed/missing YAML,
invalid status/relevance and missing required fields are validation findings;
the indexed audit does not provide a generic frontmatter repair operation.
The audit skill orchestrates edits and review; it does not create CLI handlers
for every row in its disposition table. Its index-lag, type-mismatch and
tag-noise instructions must not become evidence of an implemented repair API.

## Category-to-handler inventory

Core detection is in `audit` (`packages/core/src/lib/auditor.ts:657-1039`).
Module checks contribute arbitrary categories and a failed check yields
`module-hygiene` (`auditWithModules`,
`packages/core/src/lib/auditor.ts:1051-1079`). These are detection callbacks,
not registered repair callbacks.

| Finding | Existing bounded operation | Required reading and disposition |
| --- | --- | --- |
| `index-stale`, valid opted-in generated registry | `planRegistry` + `applyRegistry`, exposed through `brain registry` | Complete index and child frontmatter; valid registry spec, contained paths, configured types, current bytes. A stale generated region has a deterministic replacement. |
| `index-stale`, invalid spec or unreadable/malformed child | No repair for the invalid premise | Read the spec/error and relevant child. Fixing the premise is manual; the same category does not establish availability. |
| `index-lag`, ordinary prose/table without an opted-in generated region | No general handler | Read index and details. Updating a hand-authored summary can require judgment; do not substitute a generated registry. |
| `tag-noise`, corpus-level singleton summary | No handler guaranteed to clear this finding | Read the tag report and affected frontmatter. `brain tags --apply` can migrate configured aliases/eligible variants, but a successful alias migration can leave singleton noise. |
| `type-mismatch` | No general move/type-selection handler attached to audit | Read runtime taxonomy, source, possible destinations and links. Multiple homes or changing the type is a judgment; never choose the first prefix as permission to move. |
| `staleness`, `stale-draft`, `review-overdue` | No automatic truth/review handler | Read complete document and review policy. Advancing dates or changing status does not establish that review happened. |
| `propagation` | No generic derivative regeneration handler | Read canonical source, derivative and its generation provenance. Regeneration needs the actual domain workflow. |
| `broken-link`, `orphan` | No general link/alias/content handler | Read target resolution, aliases and surrounding content. Rename, missing target, historical link and deletion are different outcomes. |
| `todo`, `verify` | No automatic marker resolution | Read source and evidence. Remain informational; markers and declared unverified status are not permission to remove themselves. |
| `budget`, `past-date` | No mechanical semantic repair | Read canonical policy and document. Condensing, archiving, rescheduling or raising a budget needs a decision. |
| `fact-drift` | No automatic fact replacement | Read canonical facts, restatement and historical exceptions. A disagreement can correctly describe the past. |
| `duplicate-title`, `repeated-text` | No generic rename/extraction handler | Read all implicated documents and links. Equal text/title alone does not establish the right edit. |
| `module-hygiene`, arbitrary module category | No generic audit repair registration | Read the actual module check and its error/content. A detection callback and a similarly named module command are not a bounded repair binding. |
| Validation-only malformed frontmatter, tag formatting, unknown types/fields | No generic default-filling handler | Read the complete raw file and configured taxonomy. An inferred default or YAML rewrite can lose facts/comments or choose a false status. |

The actual registry writer checks the index's current raw bytes before writing
and leaves stale plans untouched (`applyRegistry`,
`packages/core/src/lib/index-registry.ts:288-317`). It writes generated regions;
it does not validate every semantic field or implement a cross-file transaction.
Planning parses complete child metadata (`planRegistry`,
`packages/core/src/lib/index-registry.ts:210-262`).

Tag migration is real code (`applyTagChanges`,
`packages/core/src/lib/tags-apply.ts:436-500`): configured alias chains and
eligible variant groups determine the plan; raw tag entries are changed while
other bytes, including `updated`, remain. The CLI opens its index before writes,
then reindexes and accepts only the exact rewritten bytes. Literal configured
aliases are distinct from guessing semantic aliases, which #844 evaluates.
The available bulk operation and its affected scope must be shown separately
from an assertion that a particular audit finding will disappear.

## Keyless evidence

Run with a frozen dependency install and Bun 1.3.14:

```sh
bun run test tests/audit-capability-eval.test.ts
bun scripts/evals/audit-capabilities/run.ts
```

Fourteen draft Odysseus cases, using `2026-07-12`, cover valid/invalid registries,
malformed YAML, unconfigured/prototype types, custom module findings, malformed
tags, broken links, unsafe/missing paths, ordinary index lag and corpus summaries.
Three tuning cases and eleven held-out cases use separate document groups;
the held-out generated index uses a different title, body and YAML representation.
These handwritten goldens still require independent review before live tuning.

The private prototype reuses existing hygiene identity/evidence functions and
reports handler availability separately from execution authorization. Only a
valid, nonempty registry plan can be selected. It retains built-in suggestions,
uses conservative containment and metadata checks, and rejects unsupported
categories regardless of instructions in their messages. The production
own-property taxonomy membership defect tracked in #854 was fixed by #976.
The private source-validity gate remains conservative: configured membership
alone does not establish that every registry child's metadata is valid.

Real execution controls show a generated registry rewrite producing parseable
bytes, preserving prose/TODO content, clearing `index-stale` after reindex, and
becoming a no-op on repeat. An actual tag command migrates the configured
`seafaring` alias to `voyage` with every other byte unchanged; the corpus
`tag-noise` finding remains. An actual module hygiene callback produces a
finding without acquiring a repair handler. Providerless `audit --fix` returns
one manual suggestion per finding and ordinary audit totals remain unchanged.

Two separately restored mutations reached actual writer assertions:

| Mutation | Intended failure |
| --- | --- |
| Remove the category-to-handler eligibility gate | An unsupported TODO invoked the real registry writer: expected `written: []`, received `rituals/_index.md`. |
| Remove independent fixture authorization | The nonempty eligible registry wrote despite authorization being false: expected `written: []`, received `rituals/_index.md`. |

The fourteen capability expectations pass; two draft cases expose the registry
handler. Those counts are control coverage, not representative suggestion
accuracy, vendor false-auto-fix rates or measured savings. The report leaves
live quality, no-op/invalid rates, calls/tokens saved, cost and latency null.
The wrapper is private evaluation code, not a production authorization boundary;
it adds no shared lock, child-snapshot transaction, Action resolution or recovery
mechanism. Existing race windows require assessment before any shipping writer.

## Follow-up shape and evaluation gates

Recommendation: derive mechanical availability from actual concrete handlers and
validated plans. A finding message, an LLM boolean and an available helper each
grant no authority. Do not use JEV to decide whether code exists. A separately
authorized LLM may explain a substantive finding after complete relevant source
content is read; its text remains a suggestion and cannot dispatch an operation.
No measured classifier adoption/rejection or performance decision follows from
these controls.

Preserve ordinary audit severities, grouped marker counts and must-fix versus
informational totals (`auditTotals`,
`packages/core/src/lib/auditor.ts:641-647`), and preserve `--fix` as suggestions
unless an explicit behavior/contract change is approved. Future availability
metadata must name the handler, affected scope, required input, current premise,
preview and actual post-check separately from authorization and successful repair.
Unsupported, missing, invalid and no-op cases stay manual/unavailable. Reindex
after authoritative Markdown changes, then rerun the finding's actual check;
partial repair or a failed check never becomes success.

Reuse `candidateFromAudit` (`packages/core/src/lib/hygiene.ts:332-376`) and
`hygieneId` (`packages/core/src/lib/hygiene.ts:172-175`) without inventing another
identity or disposition store. The [hygiene-review policy](decisions/hygiene-review.md)
binds #597's canonical equivalence, severity/known-urgency ordering and relevant
evidence invalidation. This investigation chooses no mappings, review controls
or dismissal semantics for that epic. #396's Markdown reconciliation remains
authoritative. Handler discovery here does not implement #597's Actions workflow.

Before live comparison, record provider/account/model access and a total spend
ceiling on #841, as #838 explicitly requires. Independently review goldens, freeze
task gates/prompts and compare current suggestions, providerless suggestions and
the capability-backed candidate over the same complete fixture brains. Keep the
current path's message-only prompt visible as its actual context limit; any
full-content completion variant is a separate arm. Review suggestion correctness,
coverage and alignment to real effects, unsupported auto-fix claims, malformed
outputs, no-op/invalid effects and retained bytes. Zero unsupported/destructive
dispatch is an adoption gate, not a confidence threshold. Include all request,
retry, fallback and explanation work, model/runtime/fixture/prompt identities,
tokens/cache, billed/effective cost, repetitions, p50/p95, throughput and observed
spread. Missing measurements stay unresolved.

The measured go/no-go should specify the smallest accepted deterministic CLI
scope and any explanation experiment. File accepted handler/suggestion work under
#838 and keep review UI/dispositions in #597; semantic tag aliases remain #844,
and broader mechanical hygiene discovery remains #842. Assess public CLI/JSON,
MCP and frontmatter impact under the [integration contract](integration-contract.md)
before implementation, with the required contract ruling, documentation and
changeset. Add no generic repair seam and transfer no D42/sync thresholds here.

## Complete-brain measurement protocol

The expanded private benchmark stages 26 authored brains: six tuning and twenty
held-out, with disjoint entity sets and unique representation labels. These
labels do not prove structural independence. Complete independently authored
preview and effect maps cover nine valid registry premises, including one
preview-only case whose independent authorization is false. The other cases
exercise malformed metadata, invalid/prototype types, configured and
module-owned taxonomy, stale and current generated regions, tag aliases,
unresolved links, quoted/negated markers, absent sources, failed module checks,
escaped module configuration and a larger handwritten index. No additional
domain repair handler is fabricated to improve coverage.

`benchmark.ts` indexes each whole brain and executes the real audit command.
Its input record separates actual audit detections from validation rules:
an unparseable child can also make a link unresolved, scalar tags are reported
as missing required metadata by validation and corpus noise by audit, and the
current marker scanner includes a TODO inside a fenced example. The candidate
uses the shipped hygiene identity primitives, including the canonical
equivalence/evidence policy delivered for #597 by #1024. Its registry handler
reads the actual plan and validates source premises; it explains why an invalid
premise needs review instead of repeating an unconditional regeneration claim.

Two repetitions compare unchanged message-only `audit --fix`, actual
providerless `audit --fix`, and the providerless capability-backed registry
candidate on separate identical brains. Only the last arm invokes an existing
writer, and only in independently authorized disposable fixtures. Current
completion replacement strings are retained as untrusted proposals and are
never executed. An in-memory full-file projection is a secondary diagnostic,
not evidence that the current command writes files. Full-content explanation
is not silently added to the current arm.

Natural suggestion correctness requires source-aware annotations for every
answer under the frozen category rubric. The analysis verifies complete
three-arm/repetition coverage, exact output hashes and physical-call accounting;
it does not infer semantic correctness from matching words. Coverage,
repairability claims, unsupported auto-fix claims, actual authorized writes,
preview/effect bytes, parseability, finding post-checks and repeat no-ops remain
separate measurements. Ordinary audit totals and the suggestion-only public
command remain unchanged.

The runtime freeze covers the core sources and complete installed transitive
dependency closure, subscription guard/review helper closure, private runtime
sources, exact Bun executable and actual native Claude executable verified
against its installed SDK manifest. The bounded complementary review retains
native stdout before SDK parsing, raw usage/cache TTLs, overage flags and child
drain evidence. Actual direct API attempts are recorded before dispatch, use
canonical `claude-sonnet-5-5` with explicit `standard_only` and `global`
selectors, and preserve requested/returned rate metadata. Official raw usage
pricing is independent of SDK dollar totals; unknown consumption stops further
admissions. Subscription API-price equivalents are separate diagnostics from
the authorized $15 actual-additional-charge allowance, and no usage estimate
is presented as a supplied invoice. JEV does not decide whether code exists.

The expanded controls use Bun 1.4.2. The actual audit command reads its real
clock; the measured detection date is frozen explicitly, while authorized
fixture writer effects use the fictional `2026-07-12` date. Neither becomes a
new CLI clock contract. Input review precedes dispatch and the source-aware
output review precedes any measured recommendation; keyless controls alone
establish neither live suggestion quality nor production adoption.


## Resumed measurement controls

The resumed protocol uses the actual UTC detection day `2026-10-09` and Bun
1.4.2 while preserving the installed SDK 0.3.283 / native CLI 2.1.283 baseline.
The fictional writer date remains `2026-07-12`. The earlier whole-input review
failed at the native context limit; it supplied no semantic approval. Its missing
final invoice remains unknown.

Eight lossless review packets partition all 26 complete cases and every direct
behavioral source file: four complete-source subsets and four disjoint complete
case subsets, each with the complete canonical fictional-world documents, common
protocol, rubric and verification hashes.
The 150,000-byte envelope is an operational bound, not proof of native context
fit. No source file or authored case is truncated. Scored admission rebuilds
every payload from disk and requires all eight native approvals on the same
source, detected-input, prompt and verification hashes, complete raw usage,
inactive reported overage, successful native result and actual child close.
The private reviewer forcibly terminates an owned child that misses its drain
window and records that outcome as failure rather than approval.

The effect observer records all recursive source members with binary bytes,
symlink targets, file types, modes and nanosecond modification times. It excludes
only regular root SQLite cache files. Each actual arm is checked before execution,
after execution and after ordinary detection; candidate execution also records
both sides of its repeated writer. Any unexpected byte, member or metadata
change stops admission immediately. Failure snapshots remain in the observation
receipt. The current arm still emits suggestions only and never executes its
untrusted replacement strings.

A lost physical usage receipt stops subsequent provider attempts. Known raw-usage
cost subtotals remain separate from a null aggregate and the count of unknown
attempts; missing token counts also remain null. Token arithmetic is an
independent standard-price diagnostic, never a subscription invoice. Actual
additional billed charges and shared reservations remain in the coordinator's
protected ledger. Fresh complementary semantic approval and the full comparison
are still required before a measured recommendation.

The actual-current API instrument reserves the full supported 1M input context
and its unchanged 2,000-token output ceiling before each physical attempt,
including shipped retries. At the coordinator's conservative $8/$20 per million
upper rates, that holds $8.04 independently of serialized request bytes. Only one
request may be in flight. Complete canonical input/cache counters within 1M and
output within the actual limit settle a conservative debit; missing,
contradictory, over-bound or failed receipts retain the hold and stop the next
transport. Raw requests, responses, usage and reservation/debit fields remain in
the physical receipt. Diagnostic price intervals are separate from that debit,
and invoice fields remain null. The supplied remaining allocation includes
earlier providers and attempts under the unchanged actual-charge caps.

The scored entry takes a separate coordinator policy-map file after its output,
combined-review, detected-input and verification arguments. It requires exactly
the eight packet keys and validates their existing paid-policy schema against
the exact source, runtime, proof and rebuilt prompts before replay. Receipt
metadata cannot supply this expected authority. Completed policies may have
expired since issuance: the original validator still checks their literal
grant and recorded admission time. Loading the map consumes no new grant,
creates no allocation and supplies no semantic approval or provider dispatch.

The resumed real-command parser controls also preserve an important distinction:
`[null]` throws inside the shipped suggestion-normalization catch and triggers
whole-batch manual fallback; string/number array entries become empty normalized
objects. Neither makes the shipped command crash. The task-local instrument
retains the unchanged returned completion text and records a source-backed parser
diagnostic, including fallback reason and non-object raw entries, beside its
physical receipt. Invalid model proposals and fallback work remain quality
observations with their full cost, rather than collector success claims or
unaccounted attempts. These diagnostics do not validate or repair the shipped
suggestion parser.


The eight-packet review collector binds literal native stdin, stdout and stderr
and each physical request/SSE/error response in a protected hash manifest.
Admission independently reparses prompt, initialization, account and effective
settings, model, terminal counters, cache/rate events, natural EOF and actual
child/relay close. Metadata-only approvals and scripted offline responses cannot
approve inputs. This artifact binding is not cryptographic attestation against
a dishonest artifact owner or an invoice. SDK 0.3.283 / CLI 2.1.283 remain the
experimental runtime; their Sonnet 5.5 fallback price/context metadata is retained
and independent token-derived prices stay separate.

The native connectivity HEAD is answered only at the exact local `/api/hello`
route, retained separately and never forwarded or counted as inference. Actual
auxiliary Messages requests remain subject to complete accounting. Paid extra
usage requires the coordinator's explicit policy bound to the literal packet,
source/input/protocol/runtime and verification proof. Every physical dispatch
reserves conservative input/output charges first; failed or unknown usage keeps
the reservation and refuses further dispatch. The native included-limit status may stay `rejected` while its paid overage
status is `allowed`; that exact active case requires the root policy. A genuine
paid rejection, HTTP/native error or unknown usage remains a veto. Missing invoices remain null. The diagnostic SDK dollar cutoff is an
operational limit and does not establish the maintainer's actual charge cap.
Real detection-day checks apply before dispatch and after drain; the fictional
writer date and existing benchmark semantics remain unchanged.
Entry-point wiring controls declare the frozen test clock and restore the real
clock in teardown. A different-day control preserves the live refusal gate;
actual keyless/native proof continues to record real UTC, independently of that
synthetic wiring clock.

Offline byte-format and native transport controls also exercise the explicitly
recognized SDK/native 293 pair when present in CI. Their receipts identify the
actual pair and cannot approve the preserved 283 live instrument. Unknown pairs
are refused rather than skipped or accepted as future-compatible.

The coordinator mints a single-use paid grant for each exact packet from its
shared remaining balance, including earlier native and Jev activity. The
collector atomically creates a protected nonce marker before prompt release or
physical forwarding. Failure leaves that grant consumed; replay compares the
literal marker, copied bytes, hashes and captured dispatch time. Conservative
input/output rates cover known Standard tier (including `auto`) and absent,
global or US-only geography. Unknown modifiers and missing receipts retain
the reservation and refuse the next request. The observed native response
`inference_geo: not_available` remains unavailable geography; the same upper
bound covers documented global/US pricing without claiming global execution.
No observed usage debit is an
invoice, and no packet carries an independent $15 allowance.
