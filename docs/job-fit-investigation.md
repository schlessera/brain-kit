# Semantic job fit: source discovery and keyless controls

This investigation supports [#847](https://github.com/schlessera/brain-kit/issues/847)
under [#838](https://github.com/schlessera/brain-kit/issues/838). Source was
inspected on 2026-10-02 at `5c56366e4c6918b1ed3e7a6934c2f8bb5700b224`.
The private harness demonstrates deterministic routing with scripted answers.
It provides no measured model-quality, cost-saving or adoption result.

## Existing behavior and evidence

| Capability | Actual behavior | Boundary for evaluation |
| --- | --- | --- |
| Keyword groups | Best matching tier, optional title boost, capped by group weight | Negated or historical keywords can still match; paraphrases can miss. |
| Location | Word-boundary excluded markers zero this dimension; preferred markers award its weight | An excluded location does not zero the whole production score. Contradictory prose needs separate assessment. |
| Compensation | Uses the maximum annual salary against the benchmark, half points at 80%, and 30% points for unknown compensation | Partial points do not establish a known salary or a guaranteed minimum. |
| Excluded titles | Zero every breakdown dimension and total | Semantic preferences must preserve this configured exclusion. |
| Aggregation | Sums deterministic dimension points | Code owns normalization, weights and arithmetic. |
| Research skill | Reads criteria and identity, researches company/posting, assesses fit and explains it | Atomic judgments do not replace research, explanation, expertise matching, CV work or the file lifecycle. |
| JEV client | Choice and Noul with response validation and bounded failure outcomes | Production Score transport is absent. |

These observations come from `groupScore`
(`packages/module-jobs/src/score.ts:230-242`), `locationScore`
(`packages/module-jobs/src/score.ts:244-250`), `compensationScore`
(`packages/module-jobs/src/score.ts:252-263`), `scoreJob`
(`packages/module-jobs/src/score.ts:277-318`), `## Actions`
(`packages/module-jobs/skills/research-opportunity/SKILL.md:32-110`), and
`JevQuestion` (`packages/core/src/lib/jev.ts:70-77`).

The scorer combines title, description, tags and location. Company and
`remote_type` are available metadata but are not independent semantic fit
judgments. Saved scoring in `settings/jobs.json` takes precedence over legacy
criteria frontmatter (`loadScoringConfig`,
`packages/module-jobs/src/score.ts:184-202`). Evaluation must freeze the actual
resolved configuration, rather than assuming prose criteria are the scorer's
only input.

Ingest converts annual amounts to EUR cents using configured rates; hourly
parsing annualizes in code. The stored currency label retains source provenance,
so it must not be used to convert the normalized amount again (`convertSalary`,
`packages/module-jobs/src/scrape.ts:479-493`). Shipped fallback rates are not a
claim about current exchange rates. The keyless tests exercise real hourly
parsing and in-memory ingest with explicit rates before scoring.

The binding boundary is unchanged: cheap deterministic scoring remains useful;
semantic augmentation must be opt-in, code owns mechanical decisions, and
probabilistic output grants no permission. See [the roadmap's binding decisions](../ROADMAP.md#what-binds-future-work),
[deterministic sync](decisions/deterministic-sync.md),
[D42's progressive enhancement](decisions/design-kit.md), and
[the not-pluggable list](extending/README.md).

## Private comparison controls

`scripts/evals/job-fit/` is an unregistered root evaluation harness. It copies
the complete posting, parsed metadata, explicit criteria, identity and resolved
configuration. A hash identifies the copied input for inspection; it is not a
production fingerprint or write authorization. Two atomic Choice questions ask
whether passage planning is a responsibility and whether mandatory relocation
triggers the explicit dealbreaker. Neither asks the model to calculate salary.

The candidate evidence extractor recognizes one top-level paragraph line for
each of `Passage work:`, `Residence:` and `Autonomy:`. It retains exact raw
offsets, rejects duplicate markers and ignores code-fence/blockquote examples.
This deliberately narrow grammar misses ordinary unmarked prose. The
`unsupported-prose` control demonstrates that miss. A span is candidate evidence,
not proof that a well-formed semantic answer is correct.

The private criteria require a guaranteed minimum annual salary of EUR 150000.
Code checks both normalized bounds, safe integer validity and the minimum.
Unknown, partial or invalid bounds remain unresolved. This is a separate
experimental criterion; the production compensation dimension still scores
the maximum. A role with a low minimum and high maximum can therefore retain
full baseline compensation points while being excluded from the private view.

Configured excluded titles retain the production all-zero score. Configured
literal location exclusions also veto the private candidate view. This latter
veto is a conservative experimental policy, stronger than the production
location dimension, and requires review before any adoption. The states
`candidate`, `review` and `excluded` are private comparison results. They are
not production queue states, automatic dismissals, applications or file writes.
The runner prints JSON and exposes no writer.

Semantic acceptance is disabled when the gate is null and sends no request.
The scripted controls use one-hot answers and `CONTROL_GATE = 1` solely to
exercise routing. No live confidence threshold has been selected or borrowed
from sync or another domain. No key, timeout, transport failure, invalid answer
or insufficient confidence preserves semantic acceptance: the numeric baseline
remains available, and unresolved critical dimensions stay in review. Missing
optional preference evidence preserves the baseline preference points; unknown
does not become a measured zero.

Tests pass nonempty answers through the actual Choice client and its validators
(`readAnswer`, `packages/core/src/lib/jev.ts:150-171`; `readResponse`,
`packages/core/src/lib/jev.ts:184-200`). Extra response fields cannot supply
salary facts or permission. A valid but wrong answer can still misrank a role.
The scripted malicious-posting controls demonstrate isolation of arithmetic and
authority fields, not measured prompt-injection resistance.

## Ordinal Score boundary

The upstream [Score documentation](https://docs.typesafe.ai/primitives/score)
and [API specification](https://docs.typesafe.ai/api.md), checked on 2026-10-02,
describe ordered levels, an expected position on those levels, probabilities
and a legend. Confidence describes concentration separately from that position;
it does not establish factual correctness. The private sketch uses three
descriptive autonomy levels and normalizes the position by the highest index
before applying the existing code-owned weight. It never treats confidence as
preference value.

`readOrdinal` validates finite bounds, every requested numbered probability and
exact string legend, unit probability sum and consistency with the weighted
mean. Its `1e-6` tolerance is a conservative fixture choice, not a verified
vendor rounding guarantee. Nonempty fixtures cover fractional positions,
missing/extra probability keys, invalid legends and distinct confidence. The
sketch supports string levels only and sends no Score request. Production
transport/schema changes should follow a measured need and actual response
receipts, including vendor rounding, structured-level handling and complete
multi-question validation.

## Reproducible offline evidence

From the repository root:

```sh
bun scripts/evals/job-fit/run.ts
bun run test tests/job-fit-eval.test.ts
```

The draft set contains 18 fictional Odysseus-world postings: three tuning cases
and 15 held-out cases whose companies and job families do not overlap tuning.
They share criteria, identity and much of the marker template. They have not
received independent label review and are not a representative, fully
template-disjoint evaluation set. Cases include paraphrases, misleading and
historical keywords, negation, missing/partial compensation, contradictory
location, configured exclusions, malicious instructions and unsupported prose.

| Control | Keyword total | Scripted hybrid total | Private result |
| --- | ---: | ---: | --- |
| Literal passage work | 100 | 100 | candidate |
| Negated passage work | 80 | 40 | excluded |
| Mandatory relocation | 100 | 100 | excluded |
| Paraphrased passage work | 40 | 100 | candidate |
| Unknown compensation | 93 | 93 | review |
| Low minimum, high maximum | 100 | 100 | excluded |
| Contradictory residence | 100 | 100 | excluded |
| Mixed autonomy | 100 | 90 | candidate |
| Unsupported unmarked prose | 40 | 40 | review |

All 18 scripted routing outcomes match their authored controls. This is not
measured semantic accuracy. The runner leaves live confusion, dealbreaker misses,
ranking agreement, unknown calibration, review effort, cost and latency null,
and reports adoption as unmeasured. Fixture SHA-256:
`c1e3f1c8883faaebcd158c5474ca3186866028595ad144f54365ca590459cbb3`.
That hash covers the fixture array; a live evaluation must additionally freeze
complete inputs, configuration, criteria, identity, requests and versions.

The tests observe real response parsing, deterministic scoring, private ranking,
source preservation and in-memory ingest. Separately disabling the dealbreaker
guard makes the named ranking assertion return `["relocation"]` instead of `[]`.
Separately disabling the unknown-salary guard returns `["missing-salary"]`
instead of `[]`. Both mutations load normally and fail on the intended ranking
assertion; both are restored. There is no file-write safety claim to infer from
these report-only controls.

## Recommendation and measurement boundary

Prepare a bounded, explicitly authorized report-only comparison before deciding
whether to adopt semantic augmentation. Missing measurements support neither
adoption nor a measured rejection. The existing keyword baseline already uses
zero inference; savings must be measured against the actual agent workflow,
including fallback research and review effort.

Before a live run, record provider, model, account/access and total spending
authorization on #847. Independently review criteria labels, expand the holdout
and separate reusable templates as well as company/job family. Define adoption
and critical-miss gates before tuning, calibrate on tuning only, then freeze the
holdout. Compare keyword-only, the current complete agent assessment and the
hybrid on identical complete inputs, with unknown and malformed responses
included. Record per-criterion confusion, dealbreaker misses, ranking agreement,
unknown calibration, reviewer time, fallback rates, all inference and generation
costs, cache behavior, latency, throughput and repeat/state-size effects under
#838's protocol. Verify current model availability and pricing at run time.

If measured evidence supports adoption, the minimal follow-up is an explicit
opt-in semantic assessment alongside keyword scoring, retaining deterministic
salary/weight logic, evidence and unknowns, and research/explanation ownership.
Assess settings, queue, CLI/JSON, MCP and frontmatter impact before implementing
it; the current preparation changes none of those surfaces. Do not introduce a
new provider seam, replace research, enable default scoring or auto-apply results
on the strength of the scripted controls.
