# Decisions — the design kit and the chat surface

Why `packages/ui-kit`, `packages/ui-react` and the chat surface are shaped the
way they are. D1 through D50, dated, with the alternatives that were rejected
and the measurements that decided them.

**Append-only. Supersede an entry; do not rewrite one.** An entry that turned
out to be wrong is more useful with its correction underneath it than deleted —
several below were superseded exactly that way, and the pair is the record.

This is a decision log, not a status file. What is *open* lives in the issue
tracker; see [`docs/process/github.md`](../process/github.md). The hard rules
every change must respect are in [`AGENTS.md`](../../AGENTS.md), and the
decisions that bind the project as a whole are in
[`ROADMAP.md`](../../ROADMAP.md) under "What binds future work" — this file does
not restate either, because a second copy of a rule is a copy that drifts.

One trap worth knowing before you edit this file: **it is inside the leakage
gate.** `scripts/check-leakage.ts` scans the whole tree, untracked files
included, and there are no exempt directories. Absolute home-directory paths and
decisions attributed to a person by name both trip it. Use repo-relative paths,
and attribute to "the maintainer".

## Subjects

- [foundations](design-kit/foundations.md).
- [storybook accessibility](design-kit/storybook-accessibility.md).
- [state architecture](design-kit/state-architecture.md).
- [fixtures](design-kit/fixtures.md).
- [components and interactions](design-kit/components-and-interactions.md).
- [tokens and styles](design-kit/tokens-and-styles.md).
- [maps](design-kit/maps.md).
- [navigation](design-kit/navigation.md).
- [answer blocks](design-kit/answer-blocks.md).
- [show block brief](design-kit/show-block-brief.md).
- [tool loading](design-kit/tool-loading.md).
- [show block schema](design-kit/show-block-schema.md).
- [backend measurements](design-kit/backend-measurements.md).
- [links](design-kit/links.md).
- [follow ups](design-kit/follow-ups.md).
- [sessions and drafts](design-kit/sessions-and-drafts.md).
- [loading](design-kit/loading.md).
- [offline continuity](design-kit/offline-continuity.md).
- [overlays](design-kit/overlays.md).

## Cross-subject relationships

These links join original rulings and their later amendments; the dated entries
remain the authority for what each relationship means.

| Later entry | Related earlier ruling |
| --- | --- |
| [D20](design-kit/components-and-interactions.md#d20--supersedes-d17-port-the-interaction-states-do-not-defer-them) | [D17](design-kit/storybook-accessibility.md#2026-09-15--viewport-and-the-accessibility-gap-maintainer) |
| [D22](design-kit/components-and-interactions.md#d22--amends-d16-desktop-comes-into-the-kit) | [D16](design-kit/storybook-accessibility.md#2026-09-15--viewport-and-the-accessibility-gap-maintainer) |
| [D52](design-kit/sessions-and-drafts.md#2026-10-06--d52-sessions-is-a-destination-work-left-running-is-tracked-until-seen-and-every-session-keeps-its-own-draft-943) | [D37](design-kit/navigation.md#2026-09-19--d37-five-destinations-everywhere-and-the-desktop-is-drawn) and [D22](design-kit/components-and-interactions.md#d22--amends-d16-desktop-comes-into-the-kit) |
| [D48](design-kit/links.md#2026-09-28--d48-a-model-authored-link-shows-its-destination-and-brain-never-opens-it-43) and [D49](design-kit/links.md#2026-09-28--d49-a-prose-link-goes-through-d48s-classifier-on-every-markdown-surface-and-mailto-stays-live-551) | [D41](design-kit/answer-blocks.md#2026-09-21--d41-the-answer-blocks-reach-the-model-through-one-tool-show_block) and [D46](design-kit/components-and-interactions.md#2026-09-24--d46-a-shared-answer-draws-its-blocks-in-a-print-theme-46) |
| [D55](design-kit/components-and-interactions.md#2026-10-09--d55-native-icon-and-text-actions-1379) | [D34](design-kit/tokens-and-styles.md#2026-09-18--d34-hit-targets-are-specified-as-reach-past-the-paint-and-the-paint-carries-no-border) and [D52](design-kit/sessions-and-drafts.md#2026-10-06--d52-sessions-is-a-destination-work-left-running-is-tracked-until-seen-and-every-session-keeps-its-own-draft-943) |

## Original section map

Presentation-only split from `9adc62e70b4f5eac9b5e3ef779552cd1858a6bd2`.
Every original heading below points to its unchanged section. The introductory
policy stays here; rules, examples, amendments and evidence move with their sections.
Original fragment identities remain available at this entry point.

<a id="constraints-discovered-during-research"></a>

- [Constraints discovered during research](design-kit/foundations.md#constraints-discovered-during-research) (original line 24).

<a id="2026-09-15--mandate-widened-maintainer"></a>

- [2026-09-15 — mandate widened (maintainer)](design-kit/foundations.md#2026-09-15--mandate-widened-maintainer) (original line 86).

<a id="2026-09-15--storybook-stack-decisions"></a>

- [2026-09-15 — Storybook stack decisions](design-kit/storybook-accessibility.md#2026-09-15--storybook-stack-decisions) (original line 119).

<a id="2026-09-15--state-architecture-proposal-pending-independent-review"></a>

- [2026-09-15 — state architecture (proposal, pending independent review)](design-kit/state-architecture.md#2026-09-15--state-architecture-proposal-pending-independent-review) (original line 203).

<a id="two-findings-that-change-the-d3-design"></a>

- [Two findings that change the D3 design](design-kit/state-architecture.md#two-findings-that-change-the-d3-design) (original line 241).

<a id="a-real-bug-found-on-the-way"></a>

- [A real bug found on the way](design-kit/state-architecture.md#a-real-bug-found-on-the-way) (original line 256).

<a id="sequencing--10-steps-each-leaving-the-tree-green"></a>

- [Sequencing — 10 steps, each leaving the tree green](design-kit/state-architecture.md#sequencing--10-steps-each-leaving-the-tree-green) (original line 264).

<a id="2026-09-15--what-no-new-seams-actually-forbids-asked-clarified"></a>

- [2026-09-15 — what "no new seams" actually forbids (asked; clarified)](design-kit/foundations.md#2026-09-15--what-no-new-seams-actually-forbids-asked-clarified) (original line 276).

<a id="2026-09-15--independent-verification-of-d13-gpt-6-astra-read-only"></a>

- [2026-09-15 — independent verification of D13 (gpt-6-astra, read-only)](design-kit/state-architecture.md#2026-09-15--independent-verification-of-d13-gpt-6-astra-read-only) (original line 339).

<a id="corrections-that-change-the-plan"></a>

- [Corrections that change the plan](design-kit/state-architecture.md#corrections-that-change-the-plan) (original line 354).

<a id="status"></a>

- [Status](design-kit/state-architecture.md#status) (original line 453).

<a id="2026-09-15--d15-the-default-root-shim-is-a-type-design-bug-not-a-migration-aid"></a>

- [2026-09-15 — D15: the default-root shim is a type-design bug, not a migration aid](design-kit/state-architecture.md#2026-09-15--d15-the-default-root-shim-is-a-type-design-bug-not-a-migration-aid) (original line 459).

<a id="the-reframe"></a>

- [The reframe](design-kit/state-architecture.md#the-reframe) (original line 471).

<a id="what-the-statics-become"></a>

- [What the statics become](design-kit/state-architecture.md#what-the-statics-become) (original line 488).

<a id="consequence-for-sequencing"></a>

- [Consequence for sequencing](design-kit/state-architecture.md#consequence-for-sequencing) (original line 504).

<a id="the-general-rule-this-sets"></a>

- [The general rule this sets](design-kit/state-architecture.md#the-general-rule-this-sets) (original line 511).

<a id="2026-09-15--viewport-and-the-accessibility-gap-maintainer"></a>

- [2026-09-15 — viewport and the accessibility gap (maintainer)](design-kit/storybook-accessibility.md#2026-09-15--viewport-and-the-accessibility-gap-maintainer) (original line 518).

<a id="2026-09-15--fixture-data-must-be-wholly-artificial-maintainer"></a>

- [2026-09-15 — fixture data must be wholly artificial (maintainer)](design-kit/fixtures.md#2026-09-15--fixture-data-must-be-wholly-artificial-maintainer) (original line 565).

<a id="the-design-drop-already-ships-real-brands"></a>

- [The design drop already ships real brands](design-kit/fixtures.md#the-design-drop-already-ships-real-brands) (original line 574).

<a id="the-leakage-gate-constrains-vocabulary-not-names"></a>

- [The leakage gate constrains VOCABULARY, not names](design-kit/fixtures.md#the-leakage-gate-constrains-vocabulary-not-names) (original line 584).

<a id="the-corpus-cost-model-is-the-opposite-of-what-we-assumed"></a>

- [The corpus cost model is the opposite of what we assumed](design-kit/fixtures.md#the-corpus-cost-model-is-the-opposite-of-what-we-assumed) (original line 615).

<a id="2026-09-15--d19-the-fixture-world-is-the-odyssey-maintainers-choice"></a>

- [2026-09-15 — D19: the fixture world is the Odyssey (maintainer's choice)](design-kit/fixtures.md#2026-09-15--d19-the-fixture-world-is-the-odyssey-maintainers-choice) (original line 651).

<a id="why-it-beats-every-researched-option"></a>

- [Why it beats every researched option](design-kit/fixtures.md#why-it-beats-every-researched-option) (original line 657).

<a id="gate-check--run-before-adopting-per-the-standing-rule"></a>

- [Gate check — run before adopting, per the standing rule](design-kit/fixtures.md#gate-check--run-before-adopting-per-the-standing-rule) (original line 681).

<a id="the-tone-rule"></a>

- [The tone rule](design-kit/fixtures.md#the-tone-rule) (original line 694).

<a id="2026-09-15--the-design-drop-gained-interaction-states-light-theme-and-desktop"></a>

- [2026-09-15 — the design drop gained interaction states, light theme and desktop](design-kit/components-and-interactions.md#2026-09-15--the-design-drop-gained-interaction-states-light-theme-and-desktop) (original line 735).

<a id="d20--supersedes-d17-port-the-interaction-states-do-not-defer-them"></a>

- [D20 — supersedes D17: port the interaction states, do not defer them](design-kit/components-and-interactions.md#d20--supersedes-d17-port-the-interaction-states-do-not-defer-them) (original line 752).

<a id="d21--revives-d9-the-two-theme-test-matrix-is-real-again"></a>

- [D21 — revives D9: the two-theme test matrix is real again](design-kit/components-and-interactions.md#d21--revives-d9-the-two-theme-test-matrix-is-real-again) (original line 798).

<a id="d22--amends-d16-desktop-comes-into-the-kit"></a>

- [D22 — amends D16: desktop comes into the kit](design-kit/components-and-interactions.md#d22--amends-d16-desktop-comes-into-the-kit) (original line 820).

<a id="also-noted"></a>

- [Also noted](design-kit/components-and-interactions.md#also-noted) (original line 858).

<a id="2026-09-15--d23-the-kits-stylesheet-is-mandatory-not-optional"></a>

- [2026-09-15 — D23: the kit's stylesheet is mandatory, not optional](design-kit/tokens-and-styles.md#2026-09-15--d23-the-kits-stylesheet-is-mandatory-not-optional) (original line 869).

<a id="the-alpha-ramps-are-three-sets-not-one"></a>

- [The alpha ramps are three sets, not one](design-kit/tokens-and-styles.md#the-alpha-ramps-are-three-sets-not-one) (original line 894).

<a id="open-relative-colour-syntax-is-outside-the-packages-baseline"></a>

- [Open: relative colour syntax is outside the package's baseline](design-kit/tokens-and-styles.md#open-relative-colour-syntax-is-outside-the-packages-baseline) (original line 901).

<a id="naming-rule-established"></a>

- [Naming rule established](design-kit/tokens-and-styles.md#naming-rule-established) (original line 919).

<a id="d24--buttondisabled-is-ported-but-incomplete"></a>

- [D24 — Button.disabled is ported but INCOMPLETE](design-kit/tokens-and-styles.md#d24--buttondisabled-is-ported-but-incomplete) (original line 926).

<a id="2026-09-15--d24-is-superseded-buttondisabled-is-complete"></a>

- [2026-09-15 — D24 is superseded: Button.disabled is complete](design-kit/components-and-interactions.md#2026-09-15--d24-is-superseded-buttondisabled-is-complete) (original line 940).

<a id="2026-09-15--wave-1-closed"></a>

- [2026-09-15 — Wave 1 closed](design-kit/components-and-interactions.md#2026-09-15--wave-1-closed) (original line 959).

<a id="2026-09-15--d25-mapview-gets-real-coastline-geometry-not-tiles"></a>

- [2026-09-15 — D25: MapView gets real coastline geometry, not tiles](design-kit/maps.md#2026-09-15--d25-mapview-gets-real-coastline-geometry-not-tiles) (original line 1002).

<a id="natural-earth-is-out--measured-not-assumed"></a>

- [Natural Earth is out — measured, not assumed](design-kit/maps.md#natural-earth-is-out--measured-not-assumed) (original line 1017).

<a id="osm-coastline-simplified--measured"></a>

- [OSM coastline, simplified — measured](design-kit/maps.md#osm-coastline-simplified--measured) (original line 1036).

<a id="ship-stroke-only-first-fill-is-a-real-trap"></a>

- [Ship stroke-only first; fill is a real trap](design-kit/maps.md#ship-stroke-only-first-fill-is-a-real-trap) (original line 1060).

<a id="licensing--the-distinction-that-decided-this"></a>

- [Licensing — the distinction that decided this](design-kit/maps.md#licensing--the-distinction-that-decided-this) (original line 1074).

<a id="what-the-shipped-component-does"></a>

- [What the shipped component does](design-kit/maps.md#what-the-shipped-component-does) (original line 1089).

<a id="the-rule-narrowed-rather-than-overturned"></a>

- [The rule, narrowed rather than overturned](design-kit/maps.md#the-rule-narrowed-rather-than-overturned) (original line 1096).

<a id="d25-addendum--natural-earths-coarser-scales-and-where-geometry-runs-out"></a>

- [D25 addendum — Natural Earth's coarser scales, and where geometry runs out](design-kit/maps.md#d25-addendum--natural-earths-coarser-scales-and-where-geometry-runs-out) (original line 1121).

<a id="2026-09-15--the-two-button-overflow-corrected-cause-and-a-wave-5-hazard"></a>

- [2026-09-15 — the two-button overflow: corrected cause, and a wave-5 hazard](design-kit/components-and-interactions.md#2026-09-15--the-two-button-overflow-corrected-cause-and-a-wave-5-hazard) (original line 1145).

<a id="the-real-lesson--a-wave-5-hazard-not-a-button-bug"></a>

- [The real lesson — a wave 5 hazard, not a Button bug](design-kit/components-and-interactions.md#the-real-lesson--a-wave-5-hazard-not-a-button-bug) (original line 1171).

<a id="the-fix"></a>

- [The fix](design-kit/components-and-interactions.md#the-fix) (original line 1183).

<a id="open-design-question--the-even-split-diverges-from-dc-on-purpose"></a>

- [Open design question — the even split diverges from DC on purpose](design-kit/components-and-interactions.md#open-design-question--the-even-split-diverges-from-dc-on-purpose) (original line 1191).

<a id="the-test"></a>

- [The test](design-kit/components-and-interactions.md#the-test) (original line 1205).

<a id="2026-09-15--wave-3-closed-46-components"></a>

- [2026-09-15 — Wave 3 closed; 46 components](design-kit/components-and-interactions.md#2026-09-15--wave-3-closed-46-components) (original line 1219).

<a id="the-designs-hit-target-numbers-are-wrong--measured"></a>

- [The design's hit-target numbers are wrong — measured](design-kit/components-and-interactions.md#the-designs-hit-target-numbers-are-wrong--measured) (original line 1225).

<a id="mapview-is-numerically-verified"></a>

- [MapView is numerically verified](design-kit/components-and-interactions.md#mapview-is-numerically-verified) (original line 1239).

<a id="d26--brand-replacement-stays-scoped-to-actual-contamination"></a>

- [D26 — brand replacement stays scoped to actual contamination](design-kit/components-and-interactions.md#d26--brand-replacement-stays-scoped-to-actual-contamination) (original line 1248).

<a id="a-real-design-gap-surfaced-by-narrowing-types"></a>

- [A real design gap, surfaced by narrowing types](design-kit/components-and-interactions.md#a-real-design-gap-surfaced-by-narrowing-types) (original line 1266).

<a id="two-harness-findings-worth-keeping"></a>

- [Two harness findings worth keeping](design-kit/components-and-interactions.md#two-harness-findings-worth-keeping) (original line 1275).

<a id="2026-09-15--d27-disclosure-becomes-optionally-controlled-maintainer"></a>

- [2026-09-15 — D27: Disclosure becomes optionally controlled (maintainer)](design-kit/components-and-interactions.md#2026-09-15--d27-disclosure-becomes-optionally-controlled-maintainer) (original line 1284).

<a id="why-the-designs-behaviour-is-not-enough"></a>

- [Why the design's behaviour is not enough](design-kit/components-and-interactions.md#why-the-designs-behaviour-is-not-enough) (original line 1293).

<a id="the-shape-which-is-what-keeps-this-safe"></a>

- [The shape, which is what keeps this safe](design-kit/components-and-interactions.md#the-shape-which-is-what-keeps-this-safe) (original line 1308).

<a id="verification"></a>

- [Verification](design-kit/components-and-interactions.md#verification) (original line 1328).

<a id="the-general-rule"></a>

- [The general rule](design-kit/components-and-interactions.md#the-general-rule) (original line 1336).

<a id="2026-09-15--wave-4-closed-59-components"></a>

- [2026-09-15 — Wave 4 closed; 59 components](design-kit/components-and-interactions.md#2026-09-15--wave-4-closed-59-components) (original line 1344).

<a id="d27--the-negative-margin-hit-target-is-exact-the-pseudo-element-one-is-not"></a>

- [D27 — the negative-margin hit target is exact; the pseudo-element one is not](design-kit/components-and-interactions.md#d27--the-negative-margin-hit-target-is-exact-the-pseudo-element-one-is-not) (original line 1354).

<a id="d28--stagewidth-is-a-cap-not-a-width"></a>

- [D28 — stageWidth is a cap, not a width](design-kit/components-and-interactions.md#d28--stagewidth-is-a-cap-not-a-width) (original line 1380).

<a id="composer-is-net-new-work-and-it-is-finished"></a>

- [Composer is net-new work, and it is finished](design-kit/components-and-interactions.md#composer-is-net-new-work-and-it-is-finished) (original line 1403).

<a id="screenbody-is-the-one-addition-and-it-earns-its-place"></a>

- [ScreenBody is the one addition, and it earns its place](design-kit/components-and-interactions.md#screenbody-is-the-one-addition-and-it-earns-its-place) (original line 1415).

<a id="agentruncard-takes-agent-not-name"></a>

- [AgentRunCard takes agent, not name](design-kit/components-and-interactions.md#agentruncard-takes-agent-not-name) (original line 1423).

<a id="d29--sharpens-d26-demo-world-versus-developer-facing-default-maintainer"></a>

- [D29 — sharpens D26: demo world versus developer-facing default (maintainer)](design-kit/components-and-interactions.md#d29--sharpens-d26-demo-world-versus-developer-facing-default-maintainer) (original line 1431).

<a id="the-third-interaction-class-is-one-declaration"></a>

- [The third interaction class is one declaration](design-kit/components-and-interactions.md#the-third-interaction-class-is-one-declaration) (original line 1461).

<a id="lanechart-is-where-tokenisation-broke-the-source"></a>

- [LaneChart is where tokenisation broke the source](design-kit/components-and-interactions.md#lanechart-is-where-tokenisation-broke-the-source) (original line 1475).

<a id="the-preflight-box-sizing-exception-is-a-pattern-not-a-series-of-one-offs"></a>

- [The preflight box-sizing exception is a pattern, not a series of one-offs](design-kit/components-and-interactions.md#the-preflight-box-sizing-exception-is-a-pattern-not-a-series-of-one-offs) (original line 1486).

<a id="browser-windowjsx-was-not-ported"></a>

- [browser-window.jsx was not ported](design-kit/components-and-interactions.md#browser-windowjsx-was-not-ported) (original line 1494).

<a id="2026-09-15--d30-data-props-defaults-are-editor-seeds-not-component-defaults"></a>

- [2026-09-15 — D30: data-props defaults are editor seeds, not component defaults](design-kit/components-and-interactions.md#2026-09-15--d30-data-props-defaults-are-editor-seeds-not-component-defaults) (original line 1501).

<a id="the-one-genuine-defect-which-goes-back-to-the-designer"></a>

- [The one genuine defect, which goes back to the designer](design-kit/components-and-interactions.md#the-one-genuine-defect-which-goes-back-to-the-designer) (original line 1537).

<a id="2026-09-15--d17-is-closed-the-accessibility-gate-is-real"></a>

- [2026-09-15 — D17 is closed: the accessibility gate is real](design-kit/storybook-accessibility.md#2026-09-15--d17-is-closed-the-accessibility-gate-is-real) (original line 1552).

<a id="what-the-gate-now-enforces"></a>

- [What the gate now enforces](design-kit/storybook-accessibility.md#what-the-gate-now-enforces) (original line 1578).

<a id="what-remains-a-documented-gap"></a>

- [What remains a documented gap](design-kit/storybook-accessibility.md#what-remains-a-documented-gap) (original line 1588).

<a id="two-divergences-from-the-source-both-recorded"></a>

- [Two divergences from the source, both recorded](design-kit/storybook-accessibility.md#two-divergences-from-the-source-both-recorded) (original line 1616).

<a id="three-findings-that-generalise-past-this-wave"></a>

- [Three findings that generalise past this wave](design-kit/storybook-accessibility.md#three-findings-that-generalise-past-this-wave) (original line 1627).

<a id="bk-controlhover-and-bk-rowhover-are-no-longer-symmetrical"></a>

- [.bk-control:hover and .bk-row:hover are no longer symmetrical](design-kit/storybook-accessibility.md#bk-controlhover-and-bk-rowhover-are-no-longer-symmetrical) (original line 1648).

<a id="2026-09-16--d31-there-is-no-backwards-compatibility-burden-maintainer"></a>

- [2026-09-16 — D31: there is no backwards-compatibility burden (maintainer)](design-kit/foundations.md#2026-09-16--d31-there-is-no-backwards-compatibility-burden-maintainer) (original line 1660).

<a id="2026-09-16--four-decisions-wave-6-made-while-building-the-contract-layer"></a>

- [2026-09-16 — four decisions wave 6 made while building the contract layer](design-kit/components-and-interactions.md#2026-09-16--four-decisions-wave-6-made-while-building-the-contract-layer) (original line 1705).

<a id="2026-09-18--d32-the-light-theme-is-light-dark-per-token-switched-by-color-scheme-under-data-theme"></a>

- [2026-09-18 — D32: the light theme is light-dark() per token, switched by color-scheme under \[data-theme\]](design-kit/tokens-and-styles.md#2026-09-18--d32-the-light-theme-is-light-dark-per-token-switched-by-color-scheme-under-data-theme) (original line 1742).

<a id="2026-09-18--d33-neutral-is-the-grey-accent-and-nothing-else-on-fill-is-what-sits-on-a-fill"></a>

- [2026-09-18 — D33: neutral is the grey accent and nothing else; on-fill is what sits on a fill](design-kit/tokens-and-styles.md#2026-09-18--d33-neutral-is-the-grey-accent-and-nothing-else-on-fill-is-what-sits-on-a-fill) (original line 1797).

<a id="2026-09-18--d34-hit-targets-are-specified-as-reach-past-the-paint-and-the-paint-carries-no-border"></a>

- [2026-09-18 — D34: hit targets are specified as reach past the paint, and the paint carries no border](design-kit/tokens-and-styles.md#2026-09-18--d34-hit-targets-are-specified-as-reach-past-the-paint-and-the-paint-carries-no-border) (original line 1819).

<a id="2026-09-18--d35-the-dark-floor-is-9a96a1-and-the-paper-palette-is-stated-three-times-per-hue"></a>

- [2026-09-18 — D35: the dark floor is #9a96a1, and the paper palette is stated three times per hue](design-kit/tokens-and-styles.md#2026-09-18--d35-the-dark-floor-is-9a96a1-and-the-paper-palette-is-stated-three-times-per-hue) (original line 1839).

<a id="2026-09-18--d36-single-key-shortcuts-are-focus-scoped-a-resolved-decision-hands-focus-to-the-next-card-or-the-empty-heading"></a>

- [2026-09-18 — D36: single-key shortcuts are focus-scoped; a resolved decision hands focus to the next card or the empty heading](design-kit/components-and-interactions.md#2026-09-18--d36-single-key-shortcuts-are-focus-scoped-a-resolved-decision-hands-focus-to-the-next-card-or-the-empty-heading) (original line 1859).

<a id="d36-addendum--printed-keys-follow-the-pointer-so-a-keyboard-only-tablet-goes-without-them-maintainer-2026-09-22"></a>

- [D36 addendum — printed keys follow the pointer, so a keyboard-only tablet goes without them (maintainer, 2026-09-22)](design-kit/components-and-interactions.md#d36-addendum--printed-keys-follow-the-pointer-so-a-keyboard-only-tablet-goes-without-them-maintainer-2026-09-22) (original line 1876).

<a id="2026-09-19--d37-five-destinations-everywhere-and-the-desktop-is-drawn"></a>

- [2026-09-19 — D37: five destinations everywhere, and the desktop is drawn](design-kit/navigation.md#2026-09-19--d37-five-destinations-everywhere-and-the-desktop-is-drawn) (original line 1921).

<a id="2026-09-19--d38-the-sixth-drops-rulings"></a>

- [2026-09-19 — D38: the sixth drop's rulings](design-kit/navigation.md#2026-09-19--d38-the-sixth-drops-rulings) (original line 1965).

<a id="2026-09-19--d39-the-app-draws-no-colour-of-its-own--theme-inline-over---bk--ink-and-fill-named-apart"></a>

- [2026-09-19 — D39: the app draws no colour of its own — @theme inline over --bk-*, ink and fill named apart](design-kit/tokens-and-styles.md#2026-09-19--d39-the-app-draws-no-colour-of-its-own--theme-inline-over---bk--ink-and-fill-named-apart) (original line 1997).

<a id="2026-09-19--d40-the-seventh-drops-rulings--canvas-palettes-are-tokens-the-diff-and-the-checkbox-are-the-kits"></a>

- [2026-09-19 — D40: the seventh drop's rulings — canvas palettes are tokens, the diff and the checkbox are the kit's](design-kit/tokens-and-styles.md#2026-09-19--d40-the-seventh-drops-rulings--canvas-palettes-are-tokens-the-diff-and-the-checkbox-are-the-kits) (original line 2071).

<a id="2026-09-21--d41-the-answer-blocks-reach-the-model-through-one-tool-show_block"></a>

- [2026-09-21 — D41: the answer blocks reach the model through one tool, show_block](design-kit/answer-blocks.md#2026-09-21--d41-the-answer-blocks-reach-the-model-through-one-tool-show_block) (original line 2116).

<a id="2026-09-21--d42-the-surface-classifies-what-the-model-typed-once-per-answer-through-jev"></a>

- [2026-09-21 — D42: the surface classifies what the model typed, once per answer, through Jev](design-kit/answer-blocks.md#2026-09-21--d42-the-surface-classifies-what-the-model-typed-once-per-answer-through-jev) (original line 2208).

<a id="2026-09-22--d43-the-show_block-brief-stays-because-it-is-the-tools-only-discovery-path"></a>

- [2026-09-22 — D43: the show_block brief stays, because it is the tool's only discovery path](design-kit/show-block-brief.md#2026-09-22--d43-the-show_block-brief-stays-because-it-is-the-tools-only-discovery-path) (original line 2357).

<a id="2026-09-22--d44-the-bridge-tools-are-always-loaded-not-deferred-behind-tool-search"></a>

- [2026-09-22 — D44: the bridge tools are always loaded, not deferred behind tool search](design-kit/tool-loading.md#2026-09-22--d44-the-bridge-tools-are-always-loaded-not-deferred-behind-tool-search) (original line 2698).

<a id="2026-09-22--d45-the-pass-routes-to-contact-trend-stays-the-tools-because-its-payload-is-numbers"></a>

- [2026-09-22 — D45: the pass routes to contact; trend stays the tool's, because its payload is numbers](design-kit/answer-blocks.md#2026-09-22--d45-the-pass-routes-to-contact-trend-stays-the-tools-because-its-payload-is-numbers) (original line 3098).

<a id="2026-09-22--measured-pi-draws-the-block-so-the-net-never-gets-cast"></a>

- [2026-09-22 — measured: pi draws the block, so the net never gets cast](design-kit/answer-blocks.md#2026-09-22--measured-pi-draws-the-block-so-the-net-never-gets-cast) (original line 3237).

<a id="2026-09-22--the-composer-follows-soft-wrap"></a>

- [2026-09-22 — the composer follows soft wrap](design-kit/components-and-interactions.md#2026-09-22--the-composer-follows-soft-wrap) (original line 3437).

<a id="2026-09-24--d46-a-shared-answer-draws-its-blocks-in-a-print-theme-46"></a>

- [2026-09-24 — D46: a shared answer draws its blocks, in a print theme (#46)](design-kit/components-and-interactions.md#2026-09-24--d46-a-shared-answer-draws-its-blocks-in-a-print-theme-46) (original line 3476).

<a id="2026-09-25--d47-show_blocks-schema-can-lose-a-tenth-through-definitions-not-half-and-nothing-ships-until-a-keyed-run-says-the-api-and-the-model-accept-it"></a>

- [2026-09-25 — D47: show_block's schema can lose a tenth through definitions, not half, and nothing ships until a keyed run says the API and the model accept it](design-kit/show-block-schema.md#2026-09-25--d47-show_blocks-schema-can-lose-a-tenth-through-definitions-not-half-and-nothing-ships-until-a-keyed-run-says-the-api-and-the-model-accept-it) (original line 3584).

<a id="2026-10-07--measured-claude-accepts-all-three-schema-forms-the-shared-and-trimmed-form-saves-1146-counted-tokens-336"></a>

- [2026-10-07 — measured: Claude accepts all three schema forms; the shared and trimmed form saves 1,146 counted tokens (#336)](design-kit/show-block-schema.md#2026-10-07--measured-claude-accepts-all-three-schema-forms-the-shared-and-trimmed-form-saves-1146-counted-tokens-336) (original line 3773).

<a id="2026-10-08--d47-superseded-ship-shared-definitions-and-trimmed-prose-after-both-serializers-accept-them-563"></a>

- [2026-10-08 — D47 superseded: ship shared definitions and trimmed prose after both serializers accept them (#563)](design-kit/show-block-schema.md#2026-10-08--d47-superseded-ship-shared-definitions-and-trimmed-prose-after-both-serializers-accept-them-563) (original line 3875).

<a id="2026-09-25--measured-the-claude-backend-at-server-level-beside-pi-137"></a>

- [2026-09-25 — measured: the Claude backend at server level, beside pi (#137)](design-kit/backend-measurements.md#2026-09-25--measured-the-claude-backend-at-server-level-beside-pi-137) (original line 3964).

<a id="2026-09-25--measured-eager-brain-tools-change-how-the-claude-backend-reads-the-brain-no-observed-gain-on-contact-or-quote-358"></a>

- [2026-09-25 — measured: eager brain tools change how the Claude backend reads the brain; no observed gain on contact or quote (#358)](design-kit/backend-measurements.md#2026-09-25--measured-eager-brain-tools-change-how-the-claude-backend-reads-the-brain-no-observed-gain-on-contact-or-quote-358) (original line 4149).

<a id="2026-09-28--d48-a-model-authored-link-shows-its-destination-and-brain-never-opens-it-43"></a>

- [2026-09-28 — D48: a model-authored link shows its destination, and Brain never opens it (#43)](design-kit/links.md#2026-09-28--d48-a-model-authored-link-shows-its-destination-and-brain-never-opens-it-43) (original line 4262).

<a id="2026-09-28--d49-a-prose-link-goes-through-d48s-classifier-on-every-markdown-surface-and-mailto-stays-live-551"></a>

- [2026-09-28 — D49: a prose link goes through D48's classifier on every markdown surface, and mailto: stays live (#551)](design-kit/links.md#2026-09-28--d49-a-prose-link-goes-through-d48s-classifier-on-every-markdown-surface-and-mailto-stays-live-551) (original line 4390).

<a id="2026-09-28--the-map-block-the-model-names-places-the-surface-draws-them-44"></a>

- [2026-09-28 — the map block: the model names places, the surface draws them (#44)](design-kit/maps.md#2026-09-28--the-map-block-the-model-names-places-the-surface-draws-them-44) (original line 4529).

<a id="2026-09-28--d50-the-model-may-offer-two-follow-ups-drawn-under-the-answer-that-fill-the-composer-and-never-send-40"></a>

- [2026-09-28 — D50: the model may offer two follow-ups, drawn under the answer, that fill the composer and never send (#40)](design-kit/follow-ups.md#2026-09-28--d50-the-model-may-offer-two-follow-ups-drawn-under-the-answer-that-fill-the-composer-and-never-send-40) (original line 4546).

<a id="d50-measurement-instruments-description-arms-and-item-accounting-550"></a>

- [D50 measurement instruments: description arms and item accounting (#550)](design-kit/follow-ups.md#d50-measurement-instruments-description-arms-and-item-accounting-550) (original line 4641).

<a id="d50-sonnet-55-measurement-and-verdict-550-2026-10-07"></a>

- [D50 Sonnet 5.5 measurement and verdict (#550, 2026-10-07)](design-kit/follow-ups.md#d50-sonnet-55-measurement-and-verdict-550-2026-10-07) (original line 4716).

<a id="2026-09-30--d51-recoverable-failures-stay-in-their-turn-and-outward-diagnostics-require-review-576"></a>

- [2026-09-30 — D51: recoverable failures stay in their turn, and outward diagnostics require review (#576)](design-kit/components-and-interactions.md#2026-09-30--d51-recoverable-failures-stay-in-their-turn-and-outward-diagnostics-require-review-576) (original line 4752).

<a id="2026-10-06--d52-sessions-is-a-destination-work-left-running-is-tracked-until-seen-and-every-session-keeps-its-own-draft-943"></a>

- [2026-10-06 — D52: Sessions is a destination, work left running is tracked until seen, and every session keeps its own draft (#943)](design-kit/sessions-and-drafts.md#2026-10-06--d52-sessions-is-a-destination-work-left-running-is-tracked-until-seen-and-every-session-keeps-its-own-draft-943) (original line 4825).

<a id="1-destinations-acts-and-the-palette-amends-d37-1"></a>

- [1. Destinations, acts and the palette (amends D37 §1)](design-kit/sessions-and-drafts.md#1-destinations-acts-and-the-palette-amends-d37-1) (original line 4856).

<a id="2-the-activation-contract"></a>

- [2. The activation contract](design-kit/sessions-and-drafts.md#2-the-activation-contract) (original line 4904).

<a id="3-the-shared-row-above-the-composer-amends-d22"></a>

- [3. The shared row above the composer (amends D22)](design-kit/sessions-and-drafts.md#3-the-shared-row-above-the-composer-amends-d22) (original line 4998).

<a id="4-trackers-under-recovery-a"></a>

- [4. Trackers under Recovery A](design-kit/sessions-and-drafts.md#4-trackers-under-recovery-a) (original line 5097).

<a id="5-per-session-drafts-stored-on-the-host-storage-c"></a>

- [5. Per-session drafts, stored on the host (storage C)](design-kit/sessions-and-drafts.md#5-per-session-drafts-stored-on-the-host-storage-c) (original line 5287).

<a id="6-host-contracts-the-implementations-add"></a>

- [6. Host contracts the implementations add](design-kit/sessions-and-drafts.md#6-host-contracts-the-implementations-add) (original line 5508).

<a id="7-what-the-kit-gains"></a>

- [7. What the kit gains](design-kit/sessions-and-drafts.md#7-what-the-kit-gains) (original line 5617).

<a id="8-what-carries-over-from-the-supplied-designs"></a>

- [8. What carries over from the supplied designs](design-kit/sessions-and-drafts.md#8-what-carries-over-from-the-supplied-designs) (original line 5647).

<a id="rejected"></a>

- [Rejected](design-kit/sessions-and-drafts.md#rejected) (original line 5806).

<a id="verification-the-implementations-owe"></a>

- [Verification the implementations owe](design-kit/sessions-and-drafts.md#verification-the-implementations-owe) (original line 5827).

<a id="d52-addendum--what-n3-means-for-each-destination-maintainer-2026-10-06"></a>

- [D52 addendum — what N3 means for each destination (maintainer, 2026-10-06)](design-kit/sessions-and-drafts.md#d52-addendum--what-n3-means-for-each-destination-maintainer-2026-10-06) (original line 5874).

<a id="2026-10-07--d53-loading-is-ghost-text-1116"></a>

- [2026-10-07 — D53: loading is ghost text (#1116)](design-kit/loading.md#2026-10-07--d53-loading-is-ghost-text-1116) (original line 5940).

<a id="d53-addendum--one-compositor-band-per-frame-1126-2026-10-07"></a>

- [D53 addendum — one compositor band per frame (#1126, 2026-10-07)](design-kit/loading.md#d53-addendum--one-compositor-band-per-frame-1126-2026-10-07) (original line 6009).

<a id="2026-10-07--sent-tracks-use-attachmentrow-1143"></a>

- [2026-10-07 — Sent tracks use AttachmentRow (#1143)](design-kit/components-and-interactions.md#2026-10-07--sent-tracks-use-attachmentrow-1143) (original line 6076).

<a id="2026-10-07--code-fences-compose-codeblock-1142"></a>

- [2026-10-07 — Code fences compose CodeBlock (#1142)](design-kit/components-and-interactions.md#2026-10-07--code-fences-compose-codeblock-1142) (original line 6094).

<a id="2026-10-07--recorded-subagents-use-state-rings-1145"></a>

- [2026-10-07 — Recorded subagents use state rings (#1145)](design-kit/components-and-interactions.md#2026-10-07--recorded-subagents-use-state-rings-1145) (original line 6116).

<a id="2026-10-08--offline-continuity-and-committed-recording-boundaries-1023"></a>

- [2026-10-08 — Offline continuity and committed recording boundaries (#1023)](design-kit/offline-continuity.md#2026-10-08--offline-continuity-and-committed-recording-boundaries-1023) (original line 6151).

<a id="preserve-work-through-transport-loss"></a>

- [Preserve work through transport loss](design-kit/offline-continuity.md#preserve-work-through-transport-loss) (original line 6163).

<a id="recording-review-and-retention"></a>

- [Recording, review and retention](design-kit/offline-continuity.md#recording-review-and-retention) (original line 6200).

<a id="warm-use-cached-cold-capture-and-uncached-launch"></a>

- [Warm use, cached cold capture and uncached launch](design-kit/offline-continuity.md#warm-use-cached-cold-capture-and-uncached-launch) (original line 6239).

<a id="desktop-browser-measurements-and-their-limits"></a>

- [Desktop browser measurements and their limits](design-kit/offline-continuity.md#desktop-browser-measurements-and-their-limits) (original line 6263).

<a id="unmeasured-cells-and-detectable-storage-loss"></a>

- [Unmeasured cells and detectable storage loss](design-kit/offline-continuity.md#unmeasured-cells-and-detectable-storage-loss) (original line 6339).

<a id="2026-10-07--streaminganswer-is-the-turns-waiting-status-1144"></a>

- [2026-10-07 — StreamingAnswer is the turn's waiting status (#1144)](design-kit/loading.md#2026-10-07--streaminganswer-is-the-turns-waiting-status-1144) (original line 6384).

<a id="2026-10-09--d54-one-overlay-primitive-1378"></a>

- [2026-10-09 — D54: one overlay primitive (#1378)](design-kit/overlays.md#2026-10-09--d54-one-overlay-primitive-1378) (original line 6408).

<a id="d54-addendum--bounded-swipe-dismissal-for-sheets-1420-maintainer-2026-10-10"></a>

- [D54 addendum — bounded swipe dismissal for sheets (#1420, maintainer, 2026-10-10)](design-kit/overlays.md#d54-addendum--bounded-swipe-dismissal-for-sheets-1420-maintainer-2026-10-10) (original line 6487).

<a id="2026-10-09--d55-native-icon-and-text-actions-1379"></a>

- [2026-10-09 — D55: native icon and text actions (#1379)](design-kit/components-and-interactions.md#2026-10-09--d55-native-icon-and-text-actions-1379) (original line 6545).
