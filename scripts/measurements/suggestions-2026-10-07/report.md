# Sonnet 5.5 suggestions comparison — 2026-10-07

Keep the shipped description and variant. The small comparison shows a benefit on Pi and no demonstrated benefit on the two Claude paths. It does not justify changing the runtime filter, brief or schema.

All 108 scored turns completed: six prompts × two description arms × three repetitions × three instruments. The schema, brief and always-loaded bridge tools were held fixed. Only the `suggestions:` description line was removed in the no-rule arm. [results.json](results.json) contains every sanitized transcript, accepted rendering payload and item judgment; [methods.md](methods.md) describes admission, isolation and billing.

| Instrument | Answer turns, rule | Answer turns, no-rule | Question controls, each arm | Actual question endings, each arm |
| --- | ---: | ---: | ---: | ---: |
| Agent SDK / Claude subscription | 0/9 | 0/9 | 0/9 | 0/9 |
| Claude server / subscription | 0/9 | 0/9 | 0/9 | 0/9 |
| Pi server / Anthropic API key | 2/9 (22.2%) | 0/9 | 0/9 | 0/9 |

These are accepted suggestions-call frequencies, not frequencies of any structured block. Other accepted comparison blocks appeared in all three instruments. No scored turn was excluded. The question controls emitted no suggestion items, so they do not establish that the client actively suppressed an emitted row.

Pi’s rule arm emitted four items in two answers. Empty normalized labels, duplicates, repeated prompts and generic filler each dropped 0/4 (0%). All other arms emitted zero items: their drop shares and quality denominators are null, not a perfect score.

Every kept item was reviewed against both answer prose and accepted rendered blocks:

| Item | Judgment |
| --- | --- |
| Design a workflow that combines all three | Concrete and grounded in the journal/topic/project comparison; weaker because the answer already outlined that workflow. |
| How is my brain currently organized? | An actionable diagnostic applying the comparison to the current organization. |
| Draft a weekly review routine for distilling journals into topic notes | Expands the displayed trade-off that journal/project captures need regular distillation. |
| Suggest a folder and linking structure for this brain | Expands the displayed organization and linkability choice. |

The second answer rendered its comparison without prose. Its accepted comparison payload is retained alongside the labels; judging only text would lose the grounding. All four items survived the actual client predicates.

The subscription-authenticated token-count endpoint measured **107 additional input tokens for the description line** and **377 for the variant**, against the same tool name. Counts are endpoint estimates, not invoice-exact future input counts. Keyless JSON arithmetic is 336 description characters, 866 flat-schema characters and 709 after D47’s definitions transform; D47’s calibrated ranges are respectively 131–140, 338–361 and 276–296 tokens. Neither live arm removed the variant.

All scored calls served canonical `claude-sonnet-5-5`. SDK 0.3.283 used its bundled Claude CLI 2.1.283; the server and successful review used native CLI 2.1.292. The older bundled CLI supplied fallback price/context metadata, so its USD field was not used as the pricing authority. Pi used coding-agent 0.99.2. Exact versions and model selectors are recorded per receipt.

The 73 successful native invocations (review plus 72 scored subscription turns) report inactive overage and **$3.4887788 API-price equivalent**, derived from final all-model token usage. Pi’s 91 finalized physical API requests have a **$0.789003 standard/global usage-price estimate**, with explicit requested/served tier and geography and cache TTL breakdown. Neither number is an invoice receipt. The authorized additional-charge cap is $15; each new physical API request required a conservative reservation of at most $5.28 plus known accumulated charges. Historical Sonnet 5 failed-review usage and Pi’s rejected OAuth 400 billing remain unknown and separate. Two server loader failures were proven before native start.

The fixed rule-then-no-rule order allows cache/time confounding. Each answer-arm denominator contains only three prompts repeated three times. Backend tool rosters, Claude CLI versions and Pi’s billing route differ. Public source/runtime and owned scratch remain accessible within private-data isolation; retrospective outside-corpus detection does not prove absence of every possible contamination. The original 31 fixture files were reset from frozen bytes per turn. SDK brain MCP tools were not registered; its Glob/Grep/Read tools and bridge were callable. Server fixtures additionally passed real CLI and MCP list/read controls.

The comparison supports keeping the current feature for its observed Pi value at a measured input cost. It does not establish a general uplift, causal suppression, statistical significance or a benefit on Claude. Reproduction source and exact executed provenance are retained separately; see [README.md](README.md), [provenance.json](provenance.json) and [review-receipt.json](review-receipt.json).
