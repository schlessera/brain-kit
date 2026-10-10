# Design kit — Foundations

Part of the [design-kit decision record](../design-kit.md). Entries retain their
original dates and order within this subject; the index maps the complete chronology
and relationships with [other subjects](../design-kit.md#subjects).

<a id="constraints-discovered-during-research"></a>

## Constraints discovered during research

- **These documents are inside the leakage gate, and this bit us.**
  `scripts/check-leakage.ts` scans the whole tree *including untracked files*,
  and there are no exempt directories. Two ways to trip it, both observed:
  1. An absolute home-directory path — the home path contains a banned personal
     string. Use repo-relative paths everywhere.
  2. **Attributing a decision to a person by name.** Six lines in these very
     files named the maintainer directly and failed the gate on a tree that was
     otherwise clean. Fixed by attributing to the role instead. (Writing the
     note about this mistake, with the name quoted as the example, failed the
     gate a second time — the gate does not care about context.)
  **Standing rule: in any document in this repository, refer to people by role, never by
  name.** Run `bun scripts/check-leakage.ts` before committing plan docs — it is
  the same gate CI runs, and it has no exempt directories.
- **There is no bundler in this repo today.** `ui-react` builds with plain `tsc`
  plus one `@tailwindcss/cli` pass; `ui-server` serves a pre-built SPA it does
  not build. The client shell (index.html, mount point, Vite/PWA build, service
  worker) lives in the deployment, not in this repo. Storybook/Vite would be the
  first bundler in this tree — nothing to reuse, but also nothing to fight.
- **The tool-renderer seam already exists** in `ui-sdk/src/client/renderers.ts`
  (`ToolRenderer`, `RendererPack`, `registerToolRenderers`, `resolveToolRenderer`,
  `resetToolRenderers`). `resetToolRenderers()` is exactly the hook a Storybook
  decorator needs. Per the no-new-seams rule, build on it rather than inventing
  a parallel registry.
- **`ui-sdk/src/protocol.ts` (`PROTOCOL_REV = 3`) is the fixture contract**, with
  `schemas.ts` as its zod mirror and a `.test-d.ts` pinning type-schema equality.
  Storybook fixtures must be typed against these, not hand-rolled shapes. Note
  ui-react's `ToolCall` is a superset of the SDK's `ToolCallView` — author
  fixtures as the richer `ToolCall`.
- **`BRAIN_UI_SYSTEM_PROMPT_APPEND`** in `ui-sdk/src/server/system-prompt.ts` is
  today the only thing describing UI capabilities to a model. Any new in-chat
  component (D3) has to be described there as well as schema'd.
- **Tailwind v4, CSS-only config — no `tailwind.config.js` exists.**
  `ui-react/src/styles.css` is four lines: `@import "tailwindcss" source(none);`
  `@source "./";` `@import "./theme.css";`. `ui-kit` must follow the same idiom.
- **The app is dark-only today.** No `.dark` class, no `prefers-color-scheme`,
  no `[data-theme]`; `use-graph-theme.ts` says so outright. Tokens are amber
  primary `#e09f3e`, teal accent `#5bb5a2`, near-black surfaces. Whether the new
  design introduces a light mode is an open question for the design file — if it
  does, that is a token-architecture change, not a Storybook toggle.
- **No fonts are bundled** — no `@font-face`, no Google import. The deployment
  shell loads DM Serif Text / Plus Jakarta Sans / JetBrains Mono. Storybook has
  no shell, so it must load them itself in `preview-head.html`.
- **`--radius` is defined but never used**, and there is no spacing scale. The
  house idiom is Tailwind defaults plus arbitrary values (`text-[11px]`,
  `font-[family-name:var(--font-mono)]`). A real token set is something `ui-kit`
  gets to introduce.
- **All 11 zustand stores are plain module singletons — there is no context
  provider anywhere.** A Storybook decorator cannot inject a mock store; it has
  to `setState()` on the real one, which `render-smoke.test.tsx` already does.
  Two further module singletons stories must set: `uiConfig` (via
  `configureBrainUi()`) and `apiBase()`. This is the strongest argument for
  `ui-kit` components being prop-driven and store-free.
- **Several store-free components still `fetch` on mount** (`AddPanel`,
  `SkillsTab`, `PasskeyTab`, `WebSearchSection`, `LoginScreen`, `PushToggle`),
  so their stories need request mocking (MSW) rather than just props.
- **There is no router dependency.** Navigation is `useUIStore.activeView` (the
  shell switches; the package only exports pages), a `useHashRoutes()` hook
  two-way syncing `#/files/<path>` / `#/graph` / `#/activity/<runId>`, and
  `subagentStack` for a `fixed inset-0` drill-in overlay.

<a id="2026-09-15--mandate-widened-maintainer"></a>

## 2026-09-15 — mandate widened (maintainer)

**D5 — Cross-package refactors are in scope when they buy architecture.**

Changing `ui-react`, `ui-sdk`, `ui-server` and friends is allowed, not merely
tolerated, where there is a real reason — reshaping the state stores is named
explicitly. The goal is a better end state: easier to maintain, easier to
extend, more testable, more consistent. This is not licence for drive-by
rewrites; every cross-package change needs a stated reason and lands with its
own tests.

Interaction with D4: D4 still bounds which *components and screens* get built —
only what the design shows. D5 bounds the *plumbing underneath* them, which may
now be reshaped as far as the architecture goals justify.

Consequences this unlocks:

- The 11 module-singleton zustand stores can be reshaped into an injectable
  form (explicit store instances behind a provider, or a store-free `ui-kit`
  with `ui-react` holding the singleton adapters). Either way stories,
  tests, and a second embedder stop fighting global mutable state.
- `uiConfig` and `apiBase()` singletons are in scope for the same treatment.
- The `ToolRenderer` registry can gain the shape it needs for D3 in-chat
  components rather than a bolt-on beside it.
- Components that `fetch` on mount can have the I/O lifted out, which removes
  the MSW requirement from most stories.

Unchanged and still binding: the `docs/integration-contract.md` contract
(CLI `--json`, MCP tool names/schemas, `schema_version`, frontmatter) — touching
it means a `CONTRACT:` commit and a major-version discussion. The
`ui-sdk` wire protocol (`PROTOCOL_REV`) is a compatibility surface too: bumping
it is allowed under D5 but must be deliberate and versioned, never incidental.

<a id="2026-09-15--what-no-new-seams-actually-forbids-asked-clarified"></a>

## 2026-09-15 — what "no new seams" actually forbids (asked; clarified)

The rule's sources are `AGENTS.md` ("Hard rules"), `ROADMAP.md` bind #2, and
`docs/extending/README.md`. Read together they are narrower than the slogan.

**A "seam" in this repo is a specific, named mechanism**, defined verbatim in
`docs/extending/README.md`:

> A typed interface in a core package → config accepts a built-in name (string)
> OR a passed-in implementation (value) → optionally shared as an npm package.

That is a *public pluggability surface for third parties*. The rule is an
anti-over-abstraction rule about what outsiders can swap, and the not-pluggable
list is about product identity (SQLite + FTS5 + sqlite-vec, markdown + git as
source of truth, the frontmatter model).

**It therefore does not bind internal structure.** A `BrainUiProvider`, store
factories, a container/presentational split, and injecting `api`/config as
values are not seams under this definition: nothing lands in `brain.config.ts`,
nothing resolves from a registry, nothing is advertised for third-party
implementation, nothing goes in `docs/extending/`. Refactoring for testability
is not the thing the rule was written to stop.

**Where it does bite**: introducing something like a `DataSource` interface that
config accepts and third parties implement. The state proposal refused exactly
that and was right to.

**Two facts that further widen the latitude here:**

1. `ToolRenderer` is *already* a sanctioned seam — `docs/extending/README.md`
   lists it among the four `@schlessera/brain-ui-sdk` seams, with its resolution
   order documented (backend-scoped name → global name → scored predicate →
   generic fallback). The D3 in-chat component work therefore **extends an
   existing seam rather than adding one**. Green light, not a rule collision.
2. `ROADMAP.md` bind #7: extension interfaces are `@experimental` until 1.0, and
   `docs/extending/README.md` repeats it. Pre-1.0, reshaping a seam is a
   CHANGELOG entry, not a major-version fight.

**And the rule cuts both ways.** Its own strongest evidence is `SiteAdapter`:
without a seam that was actually load-bearing, `module-jobs` grew a *second*
scraper with its own site registry and its own browser client, and implemented
one site twice. The rule's real target is speculative abstraction, and it argues
just as hard *for* an interface that is carrying real weight.

**Corrected 2026-09-25.** `SiteAdapter` carries less weight than this says. No
production adapter implements it: `module-jobs`' ten boards implement that
module's own `ScraperAdapter` ([verified pre-migration declaration](https://github.com/schlessera/brain-kit/blob/7a7bd9caff1453abaceddc98826b652f2ca955cb/packages/module-jobs/src/types.ts#L147-L170)) and do not run through
`runAdapters`. The seam is exported and documented, not yet load-bearing.

**2026-09-30 — Implementation context.** The 2026-09-25 correction above
records the pre-migration split. Under #344's adoption ruling, all ten boards
now implement the shared seam and production calls its runner; see the
[adoption decision](../site-adapter-adoption.md). The second-implementation bar
and the rule against speculative seams remain binding.

**D14 — the test we apply from here.** Not "is this new?" but: does this
interface exist so a *third party* can substitute an implementation? If yes it
is a seam, needs the second-implementation-within-a-year bar, and belongs in
`docs/extending/`. If it exists so *our own* code can be assembled, tested, or
rendered in two places, it is internal structure and the rule is silent on it.
`ROADMAP.md` says reopening a bind needs a reason that did not exist when it was
made. We are not reopening bind #2 — we are reading its scope correctly.

<a id="2026-09-16--d31-there-is-no-backwards-compatibility-burden-maintainer"></a>

## 2026-09-16 — D31: there is no backwards-compatibility burden (maintainer)

Asked before starting wave 6, because `AGENTS.md` attaches "a major-version
discussion" to any change to the compatibility contract and that is not a call
to make alone. The answer removes the question rather than answering it:

> "Do not be bothered with backwards compatibility — I personally am the only
> user right now, the OSS portion has never been made public so far. The only
> thing that is important is that my personal implementation I run on
> [the maintainer's host] (using the brain-ui implementation) does not break
> between deployments and remains usable to me on my phone via the PWA (a
> forced refresh or reinstallation is okay)."

**What this changes.** The `CONTRACT:` commit prefix and the
`docs/integration-contract.md` update still stand — they are how the contract
stays *documented*, which is worth having whether or not anyone is depending on
it. What does not stand is the veto: a contract change no longer needs a
major-version discussion, no longer needs a deprecation window, and no longer
needs a shim. **D15's "the shim is removed at 1.0" is now free to happen
whenever it is convenient**, and step 2's S10 stops being a separate step.

**What it does not change.** There is exactly one real deployment and it must
keep working across a deploy. So the bar is not "no breaking changes", it is:

1. **Server and client ship together.** A protocol change is fine; a protocol
   change that leaves a running server talking to a stale client is not. Both
   halves land in one release.
2. **A stale PWA must fail LOUDLY, not subtly.** A forced refresh or a
   reinstall is acceptable; a phone that renders a half-broken screen because
   its cached bundle predates the change is not. If a change can strand a
   cached client, it needs a version check that says so.
3. **Nothing about lockstep versioning changes.** All `@schlessera/brain-*`
   packages still version together, and the release guards in
   `tests/release-manifest.test.ts` still apply — those exist to stop a package
   shipping pinned to a version nobody published, which is a different hazard
   entirely and is not about compatibility.

This also settles the sequencing question wave 6 was blocked on. `PLAN.md` put
D3's tool contracts in step 1 and `DECISIONS.md` sequenced them as S9, after the
`ui-react` rewire, because `bind(contract, Component)` lives in `ui-react` and
S1 fixes that package's renderer registry first. With no compatibility burden
the ordering is a matter of engineering convenience rather than of exposure, so
**wave 6 may fix the registry as part of itself** instead of waiting for S1.
