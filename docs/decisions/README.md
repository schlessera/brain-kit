# Decisions

Why things are the way they are. One file per body of work, each carrying the
alternatives that were rejected and the measurements that decided between them.

A decision record is not a status file. Nothing here says what is done or what
is next — that is the issue tracker's job, and
[`docs/process/github.md`](../process/github.md) says how it does it. These
files answer a different question: *if I am about to change this, what did
somebody already learn the hard way?*

| Record | What it decides |
| --- | --- |
| [example-corpus.md](example-corpus.md) | Odysseus as the sole example world across core, CLI, docs and presentation; separate technical representations and historical evidence. |
| [design-kit.md](design-kit.md) | The design kit and the chat surface: D1–D50, dated. Component API, tokens, the light theme, the accessibility gate, the in-chat tool contracts, the classification pass, how the bridge tools reach the model, what a model-authored link may show, the follow-ups a model may offer. |
| [public-website.md](public-website.md) | Why the product site uses static Astro, canonical Markdown with stable routes and separately authorized repository-controlled GitHub Pages publication. |
| [feature-captures.md](feature-captures.md) | Why public feature assets use curated real sources, explicit crops and font/build provenance, with separate runtime evidence for behavior claims. |
| [hardening.md](hardening.md) | The 2026-09-06 layer review's fixes: the origin policy, the sessions epoch, subprocess environment filtering, the shared bridge tools, self-describing backends, and why they shipped in that order. |
| [container-privilege.md](https://github.com/schlessera/brain-hosting-template/blob/main/docs/decisions/container-privilege.md) (in brain-hosting-template) | How the server and the agent are separated in the deployment container, and the two measurements that decided it. Supersedes hardening.md's decision 8. Moved to the hosting template, which builds the container (#303). |
| [session-principals.md](session-principals.md) | Why a session carries a named, revocable identity instead of one global cookie epoch. |
| [async-collaboration.md](async-collaboration.md) | Why Queue and Actions form one complete autonomous v1: containment before enabling, operational/content ownership, reservations, deterministic resolution and the existing Actions destination. |
| [hygiene-review.md](hygiene-review.md) | Why async hygiene review orders eligible findings by severity/known urgency, merges equivalent source reports and invalidates dispositions only on relevant evidence changes. |
| [agent-observability.md](agent-observability.md) | Runs, spans, the Activity surface, the failure inbox and the digest. |
| [cost-tracking.md](cost-tracking.md) | List price versus effective cost, and why unknown cost is never rendered as zero. |
| [design-feedback.md](design-feedback.md) | The design defects building the kit found, the measurement behind each, and the ruling that settled it. Cited by section number from `packages/ui-kit` source. |
| [geo-operations.md](geo-operations.md) | Why one independent concrete geo library owns shared operations, with strict travel compatibility and explicit recovered-track evidence. |
| [map-geometry.md](map-geometry.md) | Why `MapView` draws committed OpenStreetMap geometry rather than fetching tiles, and how the `map` block draws places the model names on the same geometry. |
| [voice-permission.md](voice-permission.md) | What a tool approval is in a spoken conversation: the voice tool posture, why voice may refuse but never grant, and what that shares with the restricted execution profile. |
| [backend-authoring-toolkit.md](backend-authoring-toolkit.md) | The supported permission toolkit, reachable types, internal policy inventory and migration under the Q1/Q2 rulings. |
| [confirm-patterns.md](confirm-patterns.md) | Why a nonempty confirmation-pattern list with no valid regex rejects backend initialization, while explicit empty lists and mixed valid/invalid lists retain their meaning. |
| [claude-code-runtime.md](claude-code-runtime.md) | Which Claude Code binary the Claude backend runs (the one the Agent SDK ships, pinned by the lockfile), why the server records the version that ran, and how the behaviours measured against one version are re-checked when it moves. |
| [runtime-requirements.md](runtime-requirements.md) | Why package ranges and package/host runtime minimums compose, which loaded/executed identities are checked, how unknown versions and overrides behave, and why compatibility stays separate from measurement. |
| [reranker-activation.md](reranker-activation.md) | Why model judgment requires persistent opt-in across search entry points, why credentials and modes cannot enable it, and why the measured Jev provider and seam remain available. |
| [gemini-agent-contract.md](gemini-agent-contract.md) | Why Gemini's instruction file embeds the single installed contract instead of restating natively discovered skills, and how migration preserves user text and refuses ambiguous markers. |
| [graph-ranking-signal.md](graph-ranking-signal.md) | Why the link graph does not move search results: a boost on the current-focus document's neighbours, measured on the keyless goldens, rewards structural hubs and leaves the class it was meant for unchanged. |
| [deterministic-sync.md](deterministic-sync.md) | Why `brain sync` runs without an agent: a pull that finishes pending merge state first (#328), deterministic merge strategies built from verbatim blocks, Jev for two fixed-answer judgments under D42's rules with an order-consistency check, keep-both as the unjudged default, and what stays with the agent. |
| [http-api-boundary.md](http-api-boundary.md) | Why independent HTTP APIs and supported SDK dependencies have explicit contracts while paired UI transports remain internal. |
| [contract-versioning.md](contract-versioning.md) | How a change to the integration contract is versioned before 1.0: additive ships in a minor, breaking needs a ruling first, and the wire protocol is a machine contract now. |
| [embedding-eligibility.md](embedding-eligibility.md) | Why a type can retain keyword search while opting out of chunk contexts and vectors, how ordinary indexing reconciles policy changes, and why coverage counts eligible chunks. |
| [embedding-metadata.md](embedding-metadata.md) | Why type, status, tags and dates stay outside chunk embedding prefixes, preserving text-based vector reuse while metadata uses filters, keyword retrieval and ranking. |
| [stats-trends.md](stats-trends.md) | Why recorded corpus trends use one core-owned verdict, calendar windows, paired medians, conservative provenance and uncalibrated initial thresholds. |
| [backend-conformance.md](backend-conformance.md) | Why restricted-turn handling is mandatory for conforming backends, when safe rejection is valid, and how shared permission and descriptor tests prove it. |
| [exclusion-rules.md](exclusion-rules.md) | Why trailing-slash exact-file exclusions are rejected, and why directory checks apply only directory and segment rules even for programmatic callers. |
| [module-mcp-tools.md](module-mcp-tools.md) | Why a module may contribute namespaced MCP tools under the same compatibility policy as core's: how they are declared, named, validated and registered, why the tool set is fixed per server process (and what that means for a dormant module), who owes what compatibility, and why `jobs_review` is the first. |
| [module-instruction-ownership.md](module-instruction-ownership.md) | Why module instructions come from validated contributions with explicit region ownership, and why legacy mixed sections require migration before a toggle changes files. |
| [site-adapter-adoption.md](site-adapter-adoption.md) | Why all ten job boards use the evolved shared SiteAdapter and runner, with evidence-derived outcomes and domain metadata kept in jobs. |
| [scraping-politeness.md](scraping-politeness.md) | What a scraper does when a site's robots.txt and its API's capabilities disagree: robots.txt wins by intent as well as by letter, and only a written yes from the site overrides it. |
| [jobs-board-defaults.md](jobs-board-defaults.md) | Why jobs derives curated defaults and settings choices from one board policy, with explicit brain config and per-module JSON selections taking precedence. |
| [audit-markers.md](audit-markers.md) | Why `brain audit` reports TODO and VERIFY markers as one informational finding per document and kind, what `verification: unverified` means (and why there is no `verified`), why must-fix is errors plus warnings, and why broken links reuse the indexer's resolution. |
| [document-render.md](document-render.md) | How `brain render` makes a document worth sending: one stylesheet, component classes as the contract, kinds as recipes with skeletons, full documents injected into rather than nested, a footer in CSS margin boxes, a lint on every render, a linear HTML tokenizer, and why chrome-headless-shell is opt-in. |
| [index-query-api.md](index-query-api.md) | Why supported content-index results replace direct SQL only after reader migration and real-index compatibility coverage. |
| [document-renderer-adapter.md](document-renderer-adapter.md) | Why core's DocumentRenderer is an internal adapter for its one optional Puppeteer dependency rather than a public renderer seam, with public rendering behavior and the Puppeteer API unaffected. |
| [renderer-budgets.md](renderer-budgets.md) | Why queue waiting, browser acquisition and rendering have separate deadlines, the cold-start measurements behind their defaults, and who owns late resources and shutdown. |
| [travel-module.md](travel-module.md) | Why travel owns journeys, trips and places, canonical visit identity and unknown values, and the explicit lossless speaking configuration migration. |
| [frontmatter-parsing.md](frontmatter-parsing.md) | Why every frontmatter parse goes through one cache-free helper, copied into each package that parses, with a lint gate instead of a convention. |

## Writing one

Write a decision record when a choice **binds future work** — when a later
change that does not know about it would be wrong. Not for every design
discussion, and not for anything the code already says clearly.

What makes these useful is the part most records leave out:

- **The alternatives, and why each lost.** A record that only states what was
  chosen cannot stop the rejected option being proposed again next year.
- **The measurement.** Several decisions here exist because something was
  measured rather than argued: 486 of 486 coastline rings wound the same way; an
  accessibility gate giving 503 pass / 0 fail at `'todo'` and 497 / 6 at
  `'error'`; five comparison prompts producing zero tool calls after the prompt
  was rewritten twice, and the 108-turn A/B that found the tool had been
  invisible to the model in one of the two arms all along. Those numbers are
  the record — including when a later one corrects an earlier one.
- **The corrections.** When a decision turns out to be wrong, the entry is
  superseded in place with the correction underneath it. The pair is more useful
  than either half: the container privilege record (now in brain-hosting-template)
  exists because `hardening.md`'s decision 8 was written before the spike ran.

Keep them append-only. Supersede an entry; do not rewrite one.

These files are inside the leakage gate, like the whole tree. Repo-relative
paths, and attribute a ruling to "the maintainer" rather than by name.

## Marking historical context and superseded decisions

Put a dated note beside the passage whose present tense has become historical.
A note at the top of a long record is easy to miss when a reader follows a
section link. Preserve the original passage, its measurements and its citations.

Each note names the affected passage, says what changed, and links to the
replacement guidance or implementation. Distinguish two cases:

- **Implementation context:** the code evolved or a planned fix landed, while
  the decision still binds. Say which claim describes the old implementation;
  do not call the decision superseded. The static-store audit in
  [design-kit.md](design-kit.md#corrections-that-change-the-plan) is an example.
- **Superseded decision:** a later ruling reverses the choice. Name the reversed
  decision and link to the replacement ruling. Hardening's
  [decision 3](hardening.md#key-technical-decisions) now points to the
  [principal decision](session-principals.md#key-technical-decisions).

For removed or changed code, verify the original evidence in git history and
link to its full commit SHA and actual line range. Link the replacement
separately. Do not move an old citation to unrelated current code; even the
original line number may have drifted before the recorded snapshot. A new
implementation note might look like this:

```md
> **2026-09-30 — Implementation context (the composer audit below).** The
> [historical call](https://github.com/schlessera/brain-kit/blob/06889f5622a8cf26c4f4961f541fa993e998c2f4/packages/ui-react/src/components/chat/composer.tsx#L205)
> used a static store. [Root isolation](https://github.com/schlessera/brain-kit/commit/6b57843a471fc48ca3aa446f168aaf624b50b221)
> replaced it. The isolation decision still binds.
```

A supersession note instead says which decision was reversed and where its
replacement binds. These are local reading aids, not status fields or progress
logs. When the record lives in another public repository, make the correction
there or link a concrete counterpart issue; do not copy it back into this tree.
Keep any necessary citation exception narrow and explained. A note or immutable
link does not exempt the rest of the record from the citation checks below.
The checker reads line fragments in links too: a commit-pinned historical
permalink needs its own exact exception, verified against that commit's source.

## Citing code

A `path:line` citation goes stale silently. When a PR inserts lines above cited
code, the pointer comes to name the neighbouring code, and a reader who follows
it is told something confidently wrong. So name what you point at, and let the
range follow it:

```md
(`enforcementHook`, `packages/ui-backend-claude/src/permission-hooks.ts:104-127`)
```

- **The anchor** is the code span immediately before the citation, joined to it
  by a comma. It is text from the **first line** of the cited range: a
  declaration's name, a `case "tool_denial"`, a distinctive comment phrase. The
  range starts on that line. Pick text that appears few times in the file,
  because it is what the next reader searches for when the number is wrong.
- **A list** of ranges in one citation needs every element to start on its
  anchor. When the elements share no text, split the list into separate
  anchored citations. A citation that is only a colon and a line number
  continues the file cited before it.
- **A shortened path** (`permission-hooks.ts`) is fine when exactly one file in
  the tree ends with it, or when the record names that file in full somewhere.
  Otherwise write the full path.
- **Verify a range by its anchor, not by arithmetic.** Arithmetic is what
  produced the drift.

**A PR that moves lines under a citation owns that citation.** That includes
citations in source comments and in other records, not only the record the PR
is editing, and it applies even when everything the PR changed is correct.
Before merging a change to a file, look for what cites it:

```sh
git grep -n 'permission-hooks.ts:' -- docs packages
```

`tests/decision-citations.test.ts` fails when a citation in this directory no
longer starts on its anchor, names no anchor, or names a file it cannot find.
`bun scripts/check-citations.ts` prints the same report on its own, including
where each drifted anchor now is. What it does **not** check:

- **The end of a range.** A range that grows or shrinks around its first line
  still passes.
- **Citations outside `docs/decisions/`**, including source comments and other
  docs. They follow the same convention, and the grep above is the check.
- **Citations inside fenced code blocks**, which are examples and command
  output, not pointers.
- **A line named in words** ("line 12 of `auth.ts`"), or a second line number
  in plain text after a citation. Write each line as its own citation.
- **Citations into another repository.** `[brain-hosting-template] path:line`
  or `[brain-template] path:line`: the public repositories of the project,
  which this tree cannot read, so the citation is accepted and not verified.
  A citation of any other repository fails, and no exception can excuse it:
  a public record never cites a repository outside the open-source project.
- **Citations it cannot resolve.** A dependency's installed source, a
  quotation, and code the record describes as it was before the change it
  decided. Each of these is listed in `CITATION_EXCEPTIONS` in
  `scripts/check-citations.ts` with its reason. An unlisted one fails the
  test, and so does an entry that no longer matches a citation.

When a later change removes or reverses the code a record describes, do not
re-point the citation at code the record never described. List it as an
exception, saying what happened to the code.

Pair that exception with the local dated note and verified historical link
described above, so the reader can see what the old citation meant.
