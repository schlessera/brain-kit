# Exact-span research extraction: source inventory and keyless controls

This investigation prepares [#849](https://github.com/schlessera/brain-kit/issues/849)
under [#838](https://github.com/schlessera/brain-kit/issues/838). Source was
inspected at `b6f7d2e5f21d73ffd8975e8fd777e3b0747fdbd1` on 2026-10-02.
It records a private experiment, not an adopted extraction helper. No live
model comparison, measured savings or per-field adoption decision exists.

## Existing behavior and the parser boundary

Conference research asks an agent to find CFP details, dates, requirements
and notification timelines (`## Actions`,
`packages/module-speaking/skills/conference-research/SKILL.md:15-51`). These
are interview/research instructions, not a deterministic extractor. New
submission asks for bios and generates abstracts; its later note distinguishes
characters from words (`## Actions`,
`packages/module-speaking/skills/new-submission/SKILL.md:19-63`; `## Notes`,
`packages/module-speaking/skills/new-submission/SKILL.md:84-92`). Neither skill
defines Unicode counting units or executes an outline-sum validator.

Job research asks an agent to extract role, location, responsibilities and
compensation before creating Markdown (`## Actions`,
`packages/module-jobs/skills/research-opportunity/SKILL.md:32-93`). Existing
scrapers already parse structured pages. The shared JSON-LD extractor returns
parsed documents and errors, without raw-value offsets (`extractJsonLd`,
`packages/scrape/src/parse/jsonld.ts:67-90`); enrichment selects a populated
description from that structure (`postingDescription`,
`packages/module-jobs/src/enrich.ts:145-151`). A new free-text selector must
not replace these board parsers or imply their per-board outcome audit is done.
[#32](https://github.com/schlessera/brain-kit/issues/32) retains that audit.
Any accepted board/HTML parser work stays coordinated there and in the existing
scraping package, rather than adding a second parser seam.

Jobs already has a numeric range parser (`parseSalaryRange`,
`packages/module-jobs/src/salary.ts:70-84`). It reads the first two numbers,
removes comma grouping and annualizes hourly figures using 2,080 hours/year.
The experiment calls that actual function after a stricter grammar check, then
checks its arithmetic against integer minor units. The private output retains
exact safe-integer `minMinor`/`maxMinor` alongside display numbers; more than two
decimal places and unsafe annualized totals remain unresolved.
The annualization is the existing comparison assumption, not a promised annual
income. It performs no exchange-rate conversion. The parser alone does not
settle which amount is salary, currency country, period, decimal convention
or whether a range runs backward.

Core's existing JEV client supports Choice and Noul, validates answer membership
and distributions, and preserves missing-key/error/timeout outcomes
(`createJevClient`, `packages/core/src/lib/jev.ts:248-338`). The experiment uses
its actual response parser with an in-memory transport. No SDK, dependency,
production transport or exported package interface is added.

## Formats and semantics

| Evidence | Private candidate/normalization boundary | Evidence needing fallback or clarification |
| --- | --- | --- |
| HTML / Markdown | Find raw text and attribute spans without changing source; retain occurrence offsets. | Entity decoding, DOM visibility, scripts, structured-value escapes and text split across tags need a raw-source mapping. The experiment does not execute HTML. |
| Dates / ranges | ISO calendar dates and ISO wall times; English full month names; compare event endpoints in code. Numeric slash/dot dates are found but unresolved. | Locale, omitted year, relative/recurring dates, quoted editions, superseded or cancelled announcements require semantic review. One relative-date fixture has no candidate. |
| Timezones | Normalize only explicit Z/UTC or numeric offsets, validating real days, clocks and offsets. Date-only evidence retains an unknown instant. | Missing zone, abbreviations, IANA zones with DST ambiguity, unknown `-00:00` and invalid offsets remain unresolved. No current locale or UTC default. |
| Money | Exact currency/range/period span; ISO codes, EUR/GBP symbols, US grouping/decimal; actual salary parser for annual/hourly arithmetic. | Bare dollar symbols, continental decimals, single amounts, missing periods, monthly rates and reversed/mixed-currency ranges are unresolved. No currency inference or conversion. |
| URLs / contacts | HTTP(S) URL and email spans copied verbatim, including repeated occurrences. Credential-bearing URLs are rejected. | Relative links, HTML entities, phone numbers, person names, role/company identity and contact relationships are outside the prototype grammar. No network navigation. |
| Bio / outline | Explicit UTF-16/code-point/grapheme unit and nonnegative safe-integer limit; positive integral-second durations and an exact outline total. | Bare “characters,” words, range/approximate slots or unspecified break policy need clarification before validation. |

Offsets are half-open UTF-16 indices into the unchanged JavaScript source
string. They are neither byte offsets nor rendered-text offsets. The source
SHA and frozen candidate list bind a response to that snapshot; changing even
same-length non-candidate context invalidates it.

For this lab, `utf16` counts JavaScript code units, `codepoints` counts string
iteration, and `graphemes` uses `Intl.Segmenter("en", { granularity:
"grapheme" })`. No Unicode normalization, trimming or replacement changes the
counted bio. Ill-formed strings and unknown units fail validation. The Unicode
control has 15 UTF-16 units, 10 code points and 3 graphemes. Grapheme boundaries
depend on the runtime's Unicode/ICU data; freeze that runtime for comparison.
The [ECMAScript internationalization specification](https://tc39.es/ecma402/#segmenter-objects)
defines Segmenter's granularity modes. These trial semantics do not establish
how a particular CFP website counts its form input; verify that form separately.

Outline segments convert minutes/hours to seconds using integer decimal
arithmetic in code, so a large fractional value cannot pass by rounding. Every segment must
be positive and exactly representable as integral seconds, and the sum must
equal the requested slot. A 25-minute outline fails a 30-minute slot as surely
as a 31-minute one. This is a private exact-total trial rule, not a new speaking
frontmatter semantic. Explicit breaks must be represented as segments if they
consume the slot; an unknown break policy needs clarification.

## Candidate, role and value stages

The [TypeSafe pre-parsed extraction cookbook](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook)
describes finding spans in code, selecting a role and copying the chosen span.
This lab preserves duplicates as separate occurrences instead of deduplicating
text. The [Choice documentation](https://docs.typesafe.ai/primitives/choice)
defines option membership and the 255-option limit. Each role has `none` and
`unclear`, leaving at most 253 candidate occurrences. Overflow refuses the
whole request instead of silently dropping later spans.

One request carries seven CFP or three job role questions. `none` represents
explicit absence; `unclear` represents unsupported or ambiguous evidence.
The lab confidence floor is 0.9 solely as a conservative control, with no
calibration claim. [Confidence](https://docs.typesafe.ai/confidence) describes
distribution concentration, not semantic correctness. The documented
[model limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13) support
keeping calendar checks, counting and arithmetic in code. No vendor latency,
pricing or cookbook example is treated as a measurement of this workflow.

Private `conferenceResearch`, `jobResearch` and `submissionReview` consumers
exercise selection → exact copying → normalization → validation. They are
report-only experiment functions, not executions of the current agent skills.
The weak lexical comparator uses same-line keywords and abstains on multiple
matches; it is also not the current agent path. Repeated old/current values,
HTML structure, semantic revisions and irrelevant state expose its limitations.

Exact provenance cannot prove that the model chose the correct semantic role.
A control deliberately selects the injection-only date and produces a selected
report field with valid provenance. Only the authored abstention response
avoids that semantic error. The experiment has no file writer, deadline mutation,
permission decision or automatic adoption path; it makes no write-safety claim.
Low confidence, none/unclear, missing key, malformed/missing answers, failure,
timeout and candidate misses retain raw evidence for agent fallback/clarification.

## Reproducible offline evidence

```sh
bun scripts/evals/candidate-extraction/run.ts
bun run test tests/candidate-extraction-eval.test.ts packages/module-jobs/tests/jobs-salary.test.ts packages/core/tests/jev-client.test.ts
```

The committed `scripts/evals/candidate-extraction/keyless-report.json` captures
one local run. It records fixture/schema/prototype SHA-256 hashes, runtime,
five repeats, 120 observations and the timing scope. The runner emits full
field values and spans and throws on any authored expectation mismatch.

Twenty-four fictional sources have two tuning and 22 draft held-out cases,
separated by entity and template identifiers. Expected values/spans are authored
independently of prototype output, but this author wrote the fixtures and code:
an independent reviewer has not accepted them. Small sources still share grammar
and one persona, so this is not proof of generalization or independent templates
in the statistical sense. Freeze reviewed sources and expand formatting/entity
diversity before live tuning.

Candidate recall is measured independently of role selection: 41 of 42 authored
target spans are found among 219 over-found candidates. The missed relative date
is explicit. Invalid numeric dates, timezone evidence and money formats count
as found candidates even when normalization correctly refuses them.

| Field | Candidate targets found / expected | Scripted selected / absent / unresolved |
| --- | --- | --- |
| CFP deadline | 11 / 12 | 6 / 1 / 9 |
| Event start | 3 / 3 | 2 / 0 / 14 |
| Event end | 3 / 3 | 2 / 0 / 14 |
| Bio limit | 4 / 4 | 3 / 0 / 13 |
| Talk duration | 3 / 3 | 3 / 0 / 13 |
| CFP URL | 2 / 2 | 2 / 1 / 13 |
| Contact email | 5 / 5 | 5 / 1 / 18 |
| Salary | 7 / 7 | 3 / 1 / 4 |
| Application URL | 3 / 3 | 2 / 1 / 5 |

Every scripted selected value has an exact source span. These counts are
controls, not role precision, final-field precision or absent-field error rates
from a model. Lexical status/value matches include many mutual abstentions and
do not establish semantic accuracy or correct occurrence selection. All live
quality, fallback, cost and latency metrics remain `null`. Zero network model
calls is a property of this runner, not a measured cost saving versus an agent.
Its local timings include request preparation, the in-memory transport/real
parser and consumer normalization; exclude golden assertions and the lexical
comparator; and must not be quoted as live end-to-end latency.

Five restored runtime mutations fail on the intended assertions: stale source
provenance becomes selected; a missing timezone defaults to UTC and becomes
selected; UTF-16 counting returns 200 instead of 100 code points; bypassing the
bio limit accepts 151 with a 150 limit; and an inequality accepts a 1,500-second
outline for a 1,800-second slot. Each module loaded successfully. The provenance
control changes context without shifting any candidate coordinates, so a later
span check cannot mask the missing source-snapshot check.

## Comparative gates and remaining decision

Before tuning, freeze separately reviewed labels, exact values/occurrences,
absent versus unclear policy, supported formats, counting units and runtime.
Use the same complete input for today's agent research path, lexical/deterministic
baseline and hybrid; include fallback, generation and user clarification rather
than timing only successful selections. Freeze thresholds on tuning only.

Proposed trial gates are per-field exact selected span/value precision of 100%
on held-out controls, zero invented absent fields or injection-derived accepted
roles, and at least 95% candidate recall and resolved supported-field coverage.
Report denominators and uncertainty: passing this small authored set alone is
insufficient. A wrong deadline, currency, recipient, write target, permission
decision or content loss vetoes unattended adoption. Date-only values must never
be promoted to timestamp evidence. Require at least a 10% end-to-end effective
cost reduction with no p95 latency regression versus today's complete path
before claiming efficiency. Review/freeze these proposed gates before live work;
they are not maintainer approval for production changes.

Every role in the table has **unresolved go/no-go**. Unsupported relative dates,
ambiguous zones and numeric formats require fallback under the trial design;
these engineering limits do not constitute a measured rejection of JEV.
Calls/tokens/cache/retries/fallback/generation and billed/effective cost, p50/p95,
throughput, repetitions/spread, model/state-size and warm/cold effects still need
the #838 comparison protocol, with current model availability/pricing verified
at execution time. Score is not needed to select exact spans.

No production shared helper is recommended now. CFP/job research justify sharing
the private candidate/selection mechanics for the comparison, while calendars,
salary periods and submission constraints remain domain-local. If the measured
results support both concrete consumers, scope only the proven formats and source
mapping as a bounded helper follow-up under #838, coordinate scraping with #32,
and assess CLI/JSON, MCP, config/frontmatter and contract/changeset requirements.
Otherwise retain domain-local code. No generic extraction plugin seam follows
from this preparation. Roadmap rules, D42–D44 and deterministic-sync remain binding.

The standing evaluation ruling supplies the exact Sonnet 5.5 and Jev 1.13.0
models and additional-charge ceilings. Each execution still requires verified
included availability, complete physical accounting, independently reviewed
inputs and the unchanged comparison criteria. This private evaluation changes
no production contract.

## Natural source and full-task comparison

The separate workload holds 24 complete sources, ten tuning and fourteen
held-out, with distinct entity groups, prose templates and occurrence labels.
They share the established fictional world, field vocabulary and grammar;
group separation does not establish generalization to other populations.
Legacy exact parser controls remain a separate regression set. Neither corpus
has independent semantic approval merely because an authored selection passes.

Candidate recall, semantic role/occurrence correctness, parser support and
complete task outputs use different denominators. Selecting the right date at
the wrong repeated occurrence is a role error even when normalization produces
the same date. An exact role whose syntax exceeds the helper grammar requires
fallback. Monthly pay retains its monthly period; the dated notice's next
Saturday uses its stated reference date; an announced HTML application href
decodes its entity while retaining the raw source occurrence. Correct helper
abstention does not complete these broader tasks. Missing timezone, currency or
counting-unit evidence still requires clarification rather than invention.

A selected value whose gold is `none` or `unclear` is counted as an invention,
the critical error class for injection text, quoted old notices and unrelated
dates; absent-field errors are its explicit-none subset. The keyless collector
summarises these counts per field and arm next to the gold label balance. That
balance is skewed towards omitted-evidence `unclear` labels: deadline has eight
supported spans, salary five, and every other field one to three, against ten
or more `unclear` labels. Role correctness therefore mostly rewards abstention,
and the per-field precision-1/recall-0.95 gate cannot be decided for most
fields on 24 cases. The lexical comparator already shows the failure mode the
classifier arm must beat: it selects the guest-comment date in
`tune-instruction` and the footer support address in `held-footer`.

Calibration requires complete unique tuning field observations. Each field
requires both finite confidence and selected probability above its own frozen
floor. No accepted positive or explicit-none tuning outcome produces a null
gate, which stays unresolved in research and submission consumers. Synthetic
historical 0.9 controls do not supply a calibrated live threshold. Held-out
observations cannot enter calibration.

The keyless collector runs the real Jev request/response parser around an
injected transport, preserving literal bytes before interpretation, nonzero
output usage, unknown cache and invoice fields, failures and physical attempts.
Missing model or usage evidence stops another attempt. Those controls do not
measure the complete installed conference-research or research-opportunity
workflow. The prospective three-arm comparison retains their full source,
criteria, identity, downstream outputs, fallback and generation costs at three
repetitions and state sizes 1, 32 and 128. The implicit native-auto auxiliary
transport documented in #1275 must be accounted for before a complete current
baseline can be admitted; a permission-mode override is not baseline evidence.

The executable source samples use the Odysseus world at reference date
`2026-07-12`: assemblies, harbour work and estate roles. The future calendar
values deliberately exercise leap days, timezone folds and conflicting editions;
they are hypothetical validation inputs rather than additions to the canonical
voyage chronology. A fresh keyless report supersedes the earlier draft's Alex
Example and invented-company samples; it does not rename any live measurement.

## Disk and native control boundaries

Neutral complete brains contain the unmodified notice and context, both module
skill trees, disk config with custom assembly/address and opportunity paths,
criteria, identity, bio, prior proposals and owner prose/binary sentinels.
Labels, splits and expected outputs remain outside model inputs. Real CLI config,
index and jobs pipeline controls run against these brains. Local module wrappers
resolve owned source; they do not establish npm installation behavior. Every
eventual arm must receive the same complete input and effective settings.

The installed SDK/native fixture runs in separate user, PID and network
namespaces with read-only source/runtime, empty scratch homes and a scripted
loopback endpoint. It executes an exact source Read, refuses an outside Read and
an owner-file Write, then reports. Separate no-tools and scripted review controls
establish parser/roster behavior, never semantic approval. Full observations
include every member, binary bytes, modes, mtimes and symlink text. Raw stdout
survives SDK errors. Physical request/response bodies and final provider output
deltas remain distinct from provisional assistant counters and reconcile to
native all-model usage. Child close and stdout finish are required. These are
request/fetch-body bytes, not HTTP wire framing or compression captures.

The explicit default fixture policy is not the core's implicit native-auto
route. Its auxiliary accounting remains blocked by #1275; an override or scripted
response is not current-agent performance. No live entry, credential adapter,
deadline/contact writer, calibrated threshold or production helper is introduced.
Invoice amounts remain unknown; scripted usage is a format control. The private
review validator reparses complete prompt/native/auth/runtime/physical evidence
and rejects offline or flag-only APPROVED claims. The original repeated full
three-arm comparison and guarded complementary review remain required.

Runtime closure includes all owned workspaces/dependencies, files/directories,
modes, timestamps, content, symlink text and owned resolved target identity/bytes.
External physical hardlinks and links leaving the owned root are rejected.
Complete semantic code and each whole source/role/task/brain checkpoint are
included in protected review sidecars; hashes alone never replace inspection.
Packet size does not establish context capacity. Pricing ambiguity remains a
separate diagnostic follow-up in #1239; no historic rate is silently changed.
