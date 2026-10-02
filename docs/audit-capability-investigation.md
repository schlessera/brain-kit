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

Core detection is in `audit` (`packages/core/src/lib/auditor.ts:626-1008`).
Module checks contribute arbitrary categories and a failed check yields
`module-hygiene` (`auditWithModules`,
`packages/core/src/lib/auditor.ts:1019-1043`). These are detection callbacks,
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
categories regardless of instructions in their messages. Its own-property type
guard avoids the already tracked production membership defect in #854 without
claiming that defect is fixed in production.

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
`packages/core/src/lib/auditor.ts:610-616`), and preserve `--fix` as suggestions
unless an explicit behavior/contract change is approved. Future availability
metadata must name the handler, affected scope, required input, current premise,
preview and actual post-check separately from authorization and successful repair.
Unsupported, missing, invalid and no-op cases stay manual/unavailable. Reindex
after authoritative Markdown changes, then rerun the finding's actual check;
partial repair or a failed check never becomes success.

Reuse `candidateFromAudit` (`packages/core/src/lib/hygiene.ts:113-157`) and
`hygieneId` (`packages/core/src/lib/hygiene.ts:97-100`) without inventing another
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
