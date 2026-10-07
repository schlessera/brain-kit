# Turn surface routing: keyless preparation

This investigation supports [#587](https://github.com/schlessera/brain-kit/issues/587)
and its parent [#365](https://github.com/schlessera/brain-kit/issues/365).
Source was inspected on 2026-10-04 at
`91995dcf1bbf0dbbc3aa7b0f3b2fda6a07c63e6a`. The committed
[mechanics output](../scripts/fixtures/turn-surface-mechanics.json) comes from
the installed Agent SDK 0.3.283 and bundled Claude Code 2.1.283. Neither
Claude nor Jev ran. D44's historical token counts remain historical. The
refreshed inventory includes the current strict suggestion schemas and the
current direct-link scratch guidance in the prompt; two
independent commands reproduce its complete JSON byte-for-byte.

## Reproduction and scope

```sh
bun install --frozen-lockfile
bun scripts/measure-turn-surface-keyless.ts > mechanics.json
bun run test tests/turn-surface-routing.test.ts
```

The command creates disposable fictional brains outside the checkout,
connects to real MCP servers and supplies scripted responses through the
existing Jev client's injected fetch. Ambient credentials are ignored. Its
only subprocess is the core stdio MCP server with an explicit keyless
environment and isolated home. Provider requests, SDK queries and
`count_tokens` are absent. The command accepts no flags.

The preparation is bounded to eight bridge tools, eight core tools, three
fictional project skills and six scripted cases across four arms. Core tool
registration and default core skill discovery are inventoried separately;
the four-arm controls route the bridge server and fixture project skills.
Production package code, public exports, dependencies, permission policy,
skill descriptions and defaults are unchanged.

## Actual input boundaries

| Input | Source and offline observation | Boundary still requiring runtime measurement |
| --- | --- | --- |
| Bridge tools | The actual `createClaudeSdkTurn` entry lists eight tools when every host handler is present, all with `anthropic/alwaysLoad: true`. | The CLI's emitted API definitions, tool-search discovery and input tokens. |
| Core MCP | The actual stdio server lists eight core schemas and owner-specific server instructions. No modules are enabled in this fixture. | Project MCP configuration, enabled module tools, startup and CLI deferral policy. |
| Skill sources | Default discovery finds 16 shipped core skills plus three local fixtures; module and local overrides remain configuration-dependent. | Which installed skills the representative brain actually emits and lists. |
| Project skills | Real discovery and the Claude emitter expose three fixture `SKILL.md` files through `.claude/skills`; their contents are recorded. | The CLI's synthesized skill listing, manual-only policy and actual skill loads. |
| Append | The actual turn builder supplies its preset prompt append and `settingSources: ["project"]`. | The preset's full native prompt, project instructions and cache segmentation. |
| Built-in tools | The turn declares its allowlist, disallowed tools and permission callbacks. | Native CLI tool definitions and their per-request token cost. |

The assembly entry is `createClaudeSdkTurn`
(`packages/ui-backend-claude/src/sdk-options.ts:55-215`); eager bridge
registration is `createBrainUiMcpServer`
(`packages/ui-backend-claude/src/ask-user-tool.ts:93-140`). Skill discovery
is `discoverSkills` (`packages/core/src/lib/skills/discover.ts:43-81`), and
project emission is `claudeEmitter`
(`packages/core/src/lib/skills/emitters/claude.ts:16-52`).
The probe connects the returned production server instance through
`connectSurface` (`scripts/turn-surface-routing.ts:19-31`), rather than
asserting the factory alone. Core inventory starts its real source entry
through `connectBrainSurface` (`scripts/turn-surface-fixture.ts:112-128`).
Inventory uses a separate production turn instance; returned turns retain
their fresh MCP transport. Fallback tests connect and inspect the actual
returned entry, so the inventory cannot occupy that transport unnoticed.

The JSON records serialization bytes. These include metadata and an offline
inventory of sources; they are neither an API request nor token accounting.
The native preset, built-ins, CLI-generated skill listing and cache boundaries
are explicitly unobserved. A live breakdown must count each named input
against the actual representative runtime, including server instructions,
without silently treating absent observations as zero.

## Private router and comparison controls

`routePreparedTurn` (`scripts/turn-surface-routing.ts:111-150`) is an
unregistered research helper. Routing is disabled unless `enabled` is true.
It consumes an already assembled turn; it does not start the SDK. The
existing `createJevClient`
(`packages/ui-server/src/classification/jev-client.ts:94-209`) retains its
HTTP deadline, retry and circuit breaker. A separate assembly deadline
preserves the baseline even when an injected transport ignores cancellation.
An overdue answer is discarded. Attachment streams preserve the full turn
with `unsupported_input`; this bounded preparation classifies text requests.

One request contains separate tool and skill Choice questions, absolute
need gates and per-candidate fit Nouls. State contains the latest request and
at most 1000 characters of the previous assistant's tail. Wide descriptions
are bounded to 300 characters. This small control roster uses exhaustive
fit questions; it does not implement or measure a top-three shortlist for a
large catalogue. The test confidence setting is 0.6; a selection uses the
minimum of Choice confidence and its fit Noul. A sufficiently confident
"none needed" yields an empty selection. These settings are mechanics
inputs, not calibrated thresholds or an adopted routing policy.

Off, no key, open breaker, timeout, malformed response, unknown choice and
low confidence return the same assembled turn object. Tests compare the
serialized boundary and actual nonempty MCP schemas, retain callback,
environment and authority references, and compare project skill bytes.
They cover normal, no-grant and autonomous requests. Successful selection
also preserves capability withholding and the exact autonomous allowlist.

| Arm | Bridge definitions at the MCP boundary | Fixture project skill entries |
| --- | --- | --- |
| Baseline | Eight eager tools. | All three. |
| Hint | Same server and definitions; hints append to the existing system append. | All three. |
| Load-set | Eight callable tools; the selected tool alone carries eager metadata. | All three; the SDK exposes no per-skill deferral control here. |
| Hard-prune diagnostic | Only the selected bridge tool is exposed, or none. | Only selected fixture skills retain sources and emitted entries. |

The relay uses public MCP request handlers and forwards execution to the
original server. Selected schemas remain identical. The load-set control
calls a valid missed `ask_user` request and observes its original host
handler executing. The hard-prune control rejects that tool as absent.
Actual CLI ToolSearch and cache behavior remain unmeasured; MCP reachability
does not prove the model will search. Skill pruning occurs only in a
disposable fixture before any hypothetical CLI startup. Skills in the
load-set arm remain fully discoverable; no invented skill-search facility is
claimed.

The six frozen cases contain correct and deliberately wrong tool/skill
choices, a missed tool, and prose-only requests. Each arm gets the same
requests. In the missed-quote control, the required tool remains callable
in baseline, hint and load-set, and is absent in hard-prune. Deliberately
wrong and needless skill suggestions remain visible in the scripted output.
These are controlled inputs, not measured wrong-load or tool-use rates.

`scoreCalls` (`scripts/turn-surface-routing.ts:166-180`) parses bridge calls
against the shipping contracts, excludes subagent calls and excludes
incomplete turns. Its controls contain a valid call, an invalid call, a
delegated call and an incomplete turn. The output reserves live input/cache
tokens, first-frame latency, Jev cost and run-to-run spread as `null`.

## Empirical protocol boundary

The six-case matrix is a mechanics control set. A representative live
comparison needs reviewed frozen prompts covering each needed tool, actual
emitted skills and prose-only turns, alongside their expected valid arguments
and permissible fixture effects. Freeze the brain configuration, instructions,
skill contents, runtime and model; state repetitions and the maximum total
attempt count before dispatch. Maintain a shared spend ledger across Claude,
Jev, retries, failed turns and counting calls, with a ceiling that stops
dispatch before further work is admitted.

Compare the current baseline and all three shapes on those same inputs.
Record main-agent input, cache-read and cache-write usage at every model
round-trip, with message identifiers to avoid counting repeated frames twice.
Retain aggregate SDK billing separately because it can include auxiliary
or subagent work. Record Jev response usage and outcome at its transport
boundary; the existing classifier result exposes answers and duration, not
provider usage. Include failed and timed-out work in spending, and exclude
incomplete turns from behavior rates. Score tool arguments through contracts
and actual skill loads through observed skill invocations, separating wrong
from needless loads. State the numerator and denominator for every needed
tool, and repetitions and spread for every latency and rate comparison.

Measure first model-frame latency from turn admission. The private assembly
timer proves a fallback boundary, not that bound on first-frame latency or
overlap with SDK process spawn. Verify startup overlap and project skill
discovery in the real SDK before making a latency claim. Changed eager
tool sets and hint placement require observed cache accounting; an unchanged
serialized prefix alone is insufficient. Include the hard-prune false-negative
diagnostic without treating it as a production proposal.

The upstream [skill suggestion recipe](https://docs.typesafe.ai/cookbooks/skill_suggestion.md),
[function calling recipe](https://docs.typesafe.ai/cookbooks/function_calling.md)
and [intent-routing pattern](https://docs.typesafe.ai/patterns/intent-routing.md)
were checked on 2026-10-04. The skill recipe keeps the complete roster and
adds a hint after two requests, including an absolute shortlist-fit check;
this private one-request control is not a replication of its results. D42
and D44 continue to bind the production fallback and eager bridge behavior.

Live inference, counting and calibration require the issue's explicit
provider/account/model and credential-access authorization, a maximum
combined spend and approval of the frozen comparison protocol. All original
acceptance criteria remain on #587. The eventual decision record must cite
the measured four-arm table and justify its shape and thresholds; this
investigation makes no adoption decision and supplies no empirical "no".
