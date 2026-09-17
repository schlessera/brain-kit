# Handoff — brain-kit UI design system

Read this first, then `.plan/DECISIONS.md` (the reasoning, D1-D31) and
`.plan/PLAN.md` (the wave checklist). Everything needed to continue is on disk;
nothing important lives only in a session transcript.

## What this is

A new `packages/ui-kit`: 58 presentational React components ported from a Claude
Design system, with Storybook inside the package as the surface for iterating on
design, copy and layout. Step 2 now has root-owned stores, registries and connections;
component API/config migration and rewiring onto the kit remain ahead.

## State

| Wave | Scope | Status |
|---|---|---|
| 0 | Package, Storybook 10.6, CSF Next, tokens, lint gate | done |
| 1 | 12 primitives + Placeholder | done |
| 1b | Accessibility; a11y gate at `error`, **proven red then green** | done |
| 2 | Rows, evidence, decision surfaces (14) | done |
| 3 | In-chat blocks + conversation lifecycle (20) | done |
| 4 | Agent views, chrome, desktop nav (12 + ScreenBody) | done |
| 4b | Roving tabindex on the four composite widgets | done |
| 5 | The four assembled screens — the acceptance test | done |
| 6 | D3 in-chat tool contracts | done |
| 6b | MapView coastline geometry (D25) | done |
| 7 | Visual regression (D10) | done |
| — | Server-side map geometry for arbitrary places | done, one fixture outstanding |
| Step 2 | Rewire `ui-react`, reshape stores (D13/D15) | S1/S2/S3/S8 done; S4 caller migration and kit integration pending |

Fixtures: the Odyssey world under `packages/ui-kit/fixtures/`, 16 people, 20
places with verified real coordinates, pinned to 2026-07-12, 38 invariant tests,
plus OSM geometry for five locations under `fixtures/geo/` (**ODbL, not MIT** —
see the LICENSE in that directory).

## How to run it

```sh
bun run test            # whole suite
bun run lint            # seven gates, including leakage and root-store access
bunx tsc --noEmit       # typecheck
cd packages/ui-kit && bunx storybook dev      # the design surface
cd packages/ui-kit && bunx vitest run --project=storybook   # browser tests, fast
bun run test:browser    # BOTH browser projects, in the pinned image — what CI runs
bun run visual          # visual regression only
bun run visual:update   # rewrite the baselines, after a deliberate visual change
bun packages/ui-kit/tools/dc-parity/compare.ts              # DC parity harness
bun packages/ui-kit/tools/geo/generate.ts [id...]           # refetch map geometry
```

**Never commit a baseline from a host run.** `bun run visual:update` goes
through the container; a bare `vitest --project=visual --update` does not, and a
host-generated baseline does not merely differ — it makes the matcher retry
until the test times out, so the next failure does not even look visual.

If `tsc` or a test dies with `SIGTRAP` or exit 133 and a V8 stack, **re-run it**
— that is a known non-deterministic node JIT crash, documented in the release
skill. It is not your change.

## Traps that have already cost time

1. **`DesignSync` is main-session only.** Subagents do not get the tool. Fetch
   design files from the main session; `.plan/FETCH-PROGRESS.md` documents the
   extractor that harvests them from the transcript without hand-relaying.
2. **The leakage gate scans untracked files with no exempt directories.** Never
   write an absolute home path or a person's name into `.plan/`. Refer to people
   by role. Run `bun scripts/check-leakage.ts` before committing docs.
3. **A local `storybook build` used to turn the gate red** — the components
   manifest records absolute paths. `storybook-static` is excluded now, but do
   not deploy that directory without checking what the manifest contains.
4. **`@theme` must stay `@theme static`** or Tailwind prunes every token out of
   the published stylesheet. Asserted by a test. Grep the built CSS to verify
   anything about CSS; a green build is not evidence.
5. **The minifier collapses `::before` to `:before`.** Grep both.
6. **A story that measures geometry owes its own width** (D28) — `layout:
   "centered"` shrink-wraps the root, so `max-width` never binds.
7. **`width: 100%` on a component root is live** since wave 1 dropped the DC
   wrapper, and ~15 components declare it. Two side by side in a flex row
   overflow. This is the **wave 5 hazard** and it has already bitten once.
8. **The kit's stylesheet is mandatory** (D23). No `var(--x, #hex)` fallbacks —
   a stylesheet-less consumer renders colourless on purpose, because the
   alternative hands a light-theme consumer dark defaults.

## The map, which grew a server half this session

`MapView` is still prop-driven (D13) and fetches nothing. What it gained is
enough machinery around it that the whole thing works for anywhere, not just
the five fixture locations:

- **`@schlessera/brain-ui-sdk/server`** — `fetchCoastline` plus the pure
  geometry under it (`clipLine`, `simplify`, `closedRings`, `prepareLand`,
  `detailFor`). No mapshaper: 15 MB and 31 dependencies for two short
  algorithms was the wrong trade, and the hand-written versions were validated
  against it on real geometry first — same Overpass response, **identical
  extents to four decimal places**.
- **`GET /api/geo/coastline?bbox=w,s,e,n`** in `ui-server`, fetched once and
  cached on disk forever. The cache is not an optimisation: Overpass's usage
  policy is written for light interactive use, and one request per place ever
  is what makes using it defensible. No TTL, because coastlines do not move.
- **Detail tiers.** Shape only above 40 m/px, the road network between 8 and 40,
  every street below 8. The caller does not ask, so it cannot get it wrong.

Five things here will bite someone who does not know them:

1. **The projection must never stretch.** `px()`/`py()` used to map each axis
   across the whole box independently; the bbox is now expanded on its short
   axis until one pixel is the same distance both ways. `ONE SCALE FOR BOTH
   AXES` in `tests/mapview-projection.test.tsx` is the gate, and it exists
   because **every other test in that file renders at exactly `width`**, where
   pixels and percentages coincide and nothing compares the two axes.
2. **`spanKm` is the span across the WIDTH.** Applied to both axes it made a
   card captioned "18 km" draw forty.
3. **Overlays are percentages, never projected pixels.** The SVG scales to the
   card; absolutely-positioned HTML does not. And the pin's DOT sits on the
   coordinate — `translate(-50%,-50%)` centres the whole label row, which put
   the dot half a label away from the place it marks.
4. **Land is islands only.** Closed rings need no decision about which side is
   water; a mainland shore has to be closed against the viewport, which D25
   measured getting three of five wrong. The winding convention that makes that
   tractable was verified — **486 of 486 rings counter-clockwise** — so it is a
   contained second step now, not a research problem.
5. **`fetchCoastline` degrades to empty on any failure and that is deliberate**
   — a plainer map beats a message that will not render. It is also why the
   fixture generator must not inherit it: it wrote an empty fixture over a good
   one the first time Overpass answered 504. The generator retries with backoff
   and throws without writing; the route serves a `partial` result but never
   caches one.

**Overpass rate-limits hard.** It answered 504 for the last stretch of this
session on the canonical instance and on the kumi mirror. `OVERPASS_URL` points
the generator elsewhere; mirrors can be months behind, so the canonical instance
is the default.

## Map fixtures still outstanding

`bun packages/ui-kit/tools/geo/generate.ts vathy` — the location is declared and
the fixture is not committed, because Overpass still would not answer. Probed
again this session: the canonical instance answers one query and 504s the next,
minutes apart, on the same bbox, and all three tiers must land in one pass for
the generator to write. The kumi and private.coffee mirrors time out; osm.jp
has an expired certificate. A bare `curl` gets **406** rather than a timeout —
Overpass rejects the default user agent, so probe with the generator's own
(`brain-kit-fixtures/1.0 …`) or you will misread the outage. **Vathy is the
demo for the detail tiers**: the same verified Ithaca coordinate at 1.8 km
instead of 12, moving from the road tier to the street tier.
The world already has the pins for it — Penelope in the hall, Eumaeus' farm,
Laertes' upland farm, Argos — and OSM has 107 street ways there (confirmed by a
direct query). It needs a `vathyMap` scene and a story once the data lands.

While there: `troy` and `messina` predate `land` and carry no `land` key. The
loader treats that as "no fill", which is also the right answer for a mainland
bbox, so nothing is broken — but they are due a regeneration pass.

## Progress — 2026-09-17

The existing local Ithaca regeneration is retained. It uses the server's newer
pipeline: a 2.4-span bleed and the `roads` tier at 36 m/px. Two fixture tests
still described the old pipeline (one-span radial bounds, roads only at Troy).
They now check per-axis bleed bounds with rounding allowance and the declared
detail tier. Shape validation also covers streets and land, and the fixture
loader now includes streets in rendered paths, quieter than major roads.
Focused verification: all 23 geometry-fixture tests pass. Vathy regeneration
failed after the initial attempt and four retries; a direct probe confirmed
HTTP 504 from the canonical Overpass instance. No file was written, and the
sequential generator never reached Messina or Troy. All three remain pending.

Step 2's API/config prerequisites are implemented: `createBrainUiConfig`,
`createBrainApi(getBase, request?)`, and explicit-config backend URL helpers.
JSON requests AND ZIP uploads resolve their own base per request. The existing
application client delegates to the same factory, preserving late configuration
and multipart boundaries. Tests exercise two clients interleaved with different
backends/transports, configuration after construction, cancellation and errors.
Focused verification: all 26 API tests pass. The later root/connection work
below builds on these factories; full application isolation still awaits S4.

Both new regression checks were proved by seeding their failure: freezing the
API base at construction fails the late-configuration test; dropping streets
from `geoPaths` fails the street-layer test. Both seeds were removed.

The full suite also exposed an existing test-order dependency in
`ui-sdk/tests/rtk.test.ts`: earlier backend tests warm the process-wide probe,
so the test missed its own fake binary's version invocation. It passed alone.
The test now resets the probe before as well as after each case; production
RTK behavior is unchanged.

API/config batch verification: `bun run test` — **3088 pass / 41 skip / 0 fail** across
231 files. Build, typecheck and lint pass (lint retains two existing hook
warnings). `check-dist-types` reports all consumer surfaces clean, ignoring
third-party declaration errors as its existing policy specifies. Host Chromium
Storybook: **543 tests across 65 files pass**. API reports are regenerated, and
the new factories carry a minor changeset. No versioning or publishing was done.

Containerized visual verification is currently blocked by Docker socket
permissions; passwordless sudo is unavailable. No visual baselines were
regenerated on the host. Re-run `bun run visual` from a session with Docker
access before accepting any fixture-driven pixel changes.

## Root isolation progress — 2026-09-17

S2/S3 landed together. `createBrainUiRoot` owns all eleven vanilla Zustand
stores, config/API/transport, storage namespace, graph scene cache, activity
history/payload deduplication and polling, file-request controllers, renderer
registry and ASR registry. Hooks resolve the nearest `BrainUiProvider`; internal
imperative callers use its explicit root. The default application keeps its
existing config object, persistence keys and debug handles.

The connection factory closes over that root, including every frame handler,
delta queue, reconnect/resync marker and activity subscription. Multiple mounted
consumers hold leases on one socket per root. The last release removes listeners,
closes the client and stops polling; disposal invalidates late frames and graph
results. Delayed location responses cannot jump onto a replacement socket.
Provider-owned roots survive StrictMode effect replay and dispose on final
unmount; callers own explicitly supplied roots.

The SDK now has `createAsrClientRegistry`. Built-in renderer and ASR registration
stays synchronous on first render and targets the current root; imports remain
inert. Registration-count tests now instrument the actual registry instances.
S8's new AST gate rejects default-store statics in `ui-react/src`, including
renamed/namespace imports, bracket access, destructuring and aliasing. Existing
default-app tests may still use the statics.

Keyless tests exercise identical session IDs with interleaved delta queues,
provider pins and masks; independent file abort controllers; graph caches and
activity deduplication; persistence restoration; registry resets; activity
snapshots/poller teardown; late graph results; and two mounted trees sharing
leases within one root under StrictMode. The mounted selector uses `useShallow`.
The isolation test was proved by forcing hook reads back to the default root;
it failed as intended. A renamed import with bracket-access statics also failed
the production lint gate. Both seeds were removed.

Verification for this batch: `bun run test` — **3101 pass / 41 skip / 0 fail**
across 233 files. Build, typecheck and all seven lint gates pass; the two
pre-existing hook warnings remain. `check-dist-types` passes under its existing
policy of ignoring third-party declaration errors. API reports are regenerated.
The initial full run caught the stale reports; the recorded run is after their
regeneration. No additional visual changes or baseline updates were made in
this root-isolation batch; the earlier Docker/Overpass blockers remain.

**Still outstanding:** S4 component/helper API/config migration. Some settings,
quick-action, media/share, activity and branding consumers still use defaults.
The root API is usable for isolated state/connection tests, but is not yet a claim
that an entire `AppShell` can connect to a separate backend. The public README
states this limit. Root/SDK additions carry a minor changeset; no versioning or
publishing was done.

## Quick-action injection progress — 2026-09-17

The earlier work is committed in three groups: map fixtures (`ceb21df`), the
existing SDK RTK test's probe-cache reset (`06889f5`), and root/store/connection
isolation with its lint gate (`6b57843`). The RTK change only fixes test-order
dependence in the repository's existing backend command-rewrite integration.

S4 has advanced through quick actions. Search and capture use `useBrainApi`;
sync and briefing use the root transport and backend URL. Replacing the root
cancels search, resets results/type suggestions, and advances capture's existing
operation epoch so an old save or indexing completion cannot take over the new
panel. Each capture panel now has its own datalist ID.

The stream effects now cancel their readers on replacement/unmount, reject
late responses/chunks, and clear the Cancel controller only when they still own
it. Cancel updates the panel immediately, even if the transport ignores abort.
The sync endpoint prop is a backend-relative path; its only production caller
now passes that path and the panel resolves it against the current root.

Verification: **537 UI React tests pass**, including six new mounted tests for
capture/search root switches, current-root file opening, reader cleanup,
replacement-stream rendering and Cancel ownership. The Cancel regression was
proved by making an old completion unconditionally clear the active controller;
the test failed, and the seed was removed. Repository typecheck, the UI React
package build and all seven lint gates pass (the same two existing hook
warnings remain). This is a separate patch changeset.

S4 remains open: settings, activity, authentication, branding and media/share
helpers still need their API/config consumers migrated. Quick-action rich-text
output also uses those shared media/share renderers, so this batch is not a
claim that all nested content has finished migration. The map-generation and
containerized visual-verification blockers are unchanged.

## RTK integration restored — 2026-09-17

The maintainer clarified that brain-kit's own RTK integration is intentional:
it reduces token use inside the application's agent runtime and is separate
from the development agent's shell wrapper. Removal commit `a0aa02f` was
reverted by `b7de5c4`. Keep the SDK probe/rewrite exports, both backend bindings,
and the subprocess-environment test, including its probe-cache reset.

The removal changeset and guidance excluding this integration are withdrawn.
Quick-action migration (`6f86c62`) and the earlier UI root work remain in place.
S4's remaining API/config consumers are still the next implementation step.
Verification after restoration: **425 backend/SDK tests and 15 API-surface
checks pass**, the full package build passes, and the leakage gate is clean.

## Activity and device injection progress — 2026-09-17

S4 now covers activity lists, rollups/pricing state, run details, digests,
device/agent management and remembered tool grants. Each uses the provider's
API. Replacing roots clears old lists/detail metadata and invalidates outstanding
callbacks; repeated activity refreshes apply only the newest result. Digest
dismissals and revocations go to the displayed root. The activity refresh is now
a stable callback with complete effect dependencies, removing its lint warning.

Device creation still belongs to the root's principal store: a delayed one-time
credential remains available in its issuing root after its tab unmounts or the
provider switches, and never appears in the replacement root. Local list and
revoke callbacks have separate lifecycle guards so they cannot mutate another
root's rows or reload its page.

Verification: **543 UI React tests pass** across 40 files. Six new mounted tests
cover stale activity success/error/pricing responses, repeated refreshes,
same-ID detail metadata, digest loading/dismissal, same-ID device revocation,
one-time credentials, and grant/list responses across roots. Removing the revoke
ownership check made its regression test fail; the seed was removed.
The UI React package build, repository typecheck and all seven lint gates pass;
lint retains only the pre-existing dictation cleanup-ref warning.

S4 remains open for model/skill/pi settings, passkeys and authentication, push
registration, branding and media/share helpers. Push and passkeys require
migrating their browser-facing helpers with the components, not just replacing
an API import. UI-kit component integration (S5/S6/S7/S9) follows this migration.

## Skill and web-search injection progress — 2026-09-17

S4 now includes skill management and web-search settings. Both use the current
root's API, clear drafts and status when the root changes or the tab deactivates,
and invalidate callbacks on cleanup. Old skill lists, editor loads, saves,
installs and mutation failures cannot replace the current view or trigger a
follow-up list reload. List requests also reject superseded responses.
Web-search saves cannot clear another root's key draft or busy state; success
flash timers are cleared on cleanup.

Verification: **548 UI React tests pass** across 40 files. Five new mounted tests
exercise root replacement during skill loading/editing/saving/installing and
web-search loading/key saves, plus late mutation failures after tab reactivation.
Removing the skill-save ownership check made its regression test fail; the guard
was restored before the full suite ran.
The UI React package build, repository typecheck and all seven lint gates pass;
lint retains only the pre-existing dictation cleanup-ref warning.

S4 remains open for model catalog settings and pi account flows, passkeys and
authentication, push registration, branding and media/share helpers. Model writes
use a queue that must retain write ordering within a root; pi login polling must
never follow an old flow ID through a replacement root's API. UI-kit component
integration (S5/S6/S7/S9) still follows this migration.

## Open questions for the maintainer

- `.plan/design-feedback.md` holds defects that need the **designer**, not code:
  every hit-target expansion on a bordered element is short by its border;
  `ContactCard` cannot express severity in a fact; `neutral` means four
  different things across four components; `AgentRunCard` has a fallback that
  can never fire. §10's three unlanded key bindings need a WCAG 2.1.4 answer,
  and §11 closed with one new question: whether `Home` / `End` should join the
  role-and-keys table now that the groups are composite widgets.
- The light theme is specified with a full token contract but **not wired** —
  the tokens exist with dark values and a `[data-theme="light"]` stub.
- Whether the even 50/50 split on `ApprovalCard`'s buttons stands, or reverts to
  the content-sized render DC actually draws (155/65). One property, two nodes.

## The accessibility gate, and what it does not see

`parameters.a11y.test` is `'error'` and was proven before it was trusted: the
same seeded violation gives **503 pass / 0 fail at `'todo'`** and **497 / 6 at
`'error'`**. The first row is the finding, not the control — `'todo'` really is
silent.

Note the method, because it generalises: a first seed attempt was **discarded**
because it also failed at `'todo'` — caught by this wave's own
`findByRole({ name })` assertions rather than by axe. **A seed only proves a
gate if nothing else in the suite can see it.**

**The gate's blind spot matters more than its coverage.** axe only sees what a
story renders. `design-feedback.md` §7 records a contrast failure axe never
found — a solid button's effect chip is under 4.5:1 on every tone, and no story
renders that combination. `packages/ui-kit/tests/contrast.test.ts` exists for
exactly this: it recomputes every figure from the tokens rather than waiting for
a rendered pixel.

## Roving tabindex, done — what it left behind

`src/internal/roving.ts` holds `useRoving` and `focusSibling`. `TabBar`,
`SideRail` and `FilterRow` each own their group and hold the state; `ChoiceOption`
cannot — it is one option inside its caller's `radiogroup` — so it takes a
`tabStop` prop and `AskUserCard` drives it. The navigation now costs **two tab
presses, not ten**, and `stories/rules/Keyboard.stories.tsx` still asserts a list
of names rather than a count.

**The clause to not lose in a refactor:** the stop falls back to the FIRST
ELIGIBLE item. Without it a group with nothing selected — an unanswered
`AskUserCard`, which is its common state — is not harder to reach but completely
unreachable. Four stories exist only to hold that clause down, and all four were
proven by seeding the naive implementation. `design-feedback.md` §11 is now the
record of the fix rather than of the defect.

A real bug fell out: `FilterRow` fired `items[n]` with `n` from the DOM walk,
which only visits interactive pills, so a mixed row filtered by the wrong one.

## Wave 5, done — and what it changed about the traps above

**The component set held.** All four screens are assembly; none needed a new
component. `tests/screens-are-assembly.test.ts` now enforces that over the
source — every capitalised JSX tag imported from `src/`, every inline style
layout-only, no colour literal — so screens 2-4 inherited the rule by existing.

What assembly surfaced was **six defects in components that each passed their
own stories**, because a component's own stories put it in a container built for
it and a screen does not. Four were kit bugs and are fixed; two need the
designer. `.plan/design-feedback.md` §14.

Two of those are worth carrying forward as rules:

- **`ScreenBody` children must not shrink** (`.bk-screen-body > *`). Without it
  an over-full screen squeezes every child instead of scrolling, and it fails as
  somebody else's bug — a `FilterRow` clipping its own labels, an `ActionCard`
  eating its last line, a `margin-top: auto` that silently stops spacing.
- **A screen may not render more than it can reach.** `unreachable()` in
  `stories/_stage.tsx`. `overflow: hidden` is right for a specimen and is a trap
  on a screen: the clip looks like the end of the content.

## The trap wave 7 was built for

**Two components were visibly broken in Storybook and passed every test.**
`GraphView` rendered a 2px vertical line for a whole wave — everything inside it
is absolutely positioned, so its intrinsic width is zero and `width: 100%`
against Storybook's shrink-to-fit centred root resolved to nothing. All six of
its stories passed, and none of them *could* have failed: percentages of zero
are all zero. `LaneChart` drew one run as two, against the only argument the
component makes. Both were found by a person looking at the design surface.

`.plan/design-feedback.md` §15. The practical rule: **assertions about props,
roles, counts and computed styles cannot see a component that has vanished.**

Wave 7 now covers it — both defects were re-seeded against the finished suite
and caught in under 250ms each. Two things about it are worth knowing before
touching it:

- **A baseline only catches what its story renders**, which is the same blind
  spot the a11y gate has. Reintroducing the `GraphView` collapse did NOT fail
  `paints: graph view`, because `Default` renders in a stated-width wrapper now.
  The subject that catches it is the story that reproduces the condition, and it
  is in the set separately.
- **The subjects are curated on purpose** — the four screens, the components
  that paint, two dense cards. Snapshotting all 536 stories would produce PNGs
  nobody can review that churn on every spacing change, which is how a visual
  suite becomes a rubber stamp.

## D31: there is no backwards-compatibility burden

The maintainer is the only user and the OSS portion has never been public, so a
contract change needs no major-version discussion, no deprecation window and no
shim — **D15's "remove the shim at 1.0" is free to happen whenever convenient**,
and step 2's S10 stops being a separate step. The `CONTRACT:` prefix and the
`docs/integration-contract.md` update still stand, because they keep the
contract documented rather than protected.

What replaces the old bar, and it is not nothing: there is **one real
deployment** and it must survive a deploy. Server and client ship together; a
stale PWA must fail loudly rather than render a half-broken screen; a forced
refresh or reinstall is acceptable. Lockstep versioning and the release guards
are untouched — they guard a different hazard. Full text in `DECISIONS.md` D31.

This also settles wave 6's sequencing: with no exposure, the ordering is
engineering convenience, so **wave 6 may fix `ui-react`'s renderer registry as
part of itself** rather than waiting for step 2's S1.

## What to do next

**Step 2** — rewire `ui-react` onto `ui-kit`, reshape the stores (D13/D15). It
is the only wave-sized piece left in step 1's neighbourhood. Note what is
already done: S1's registry fix, S2's root/store factories, S3's bound connection
and S8's static-access lint gate. D31 removed S10. **Finish S4 next:** migrate
remaining model/pi settings, auth/push/media `api`, branding `uiConfig`, and
`apiBase`/`getBackendUrl` consumers to the
provider's root, including helpers that upload/share/render and their callers.
Keep the existing cancellation/epoch guards and update effect dependencies when
injecting services. Then proceed to S5/S6/S7/S9 (kit dependency, component splits,
and first end-to-end kit component). Do not describe the whole application as
safe for separate-backend embeds until S4 and its runtime tests are complete.

Three design questions are open and will move screens, and therefore baselines:
two in `design-feedback.md` §14 (a four-tile `StatTiles` row breaking 3 + 1; the
digest saying "Today · 3 items" twice) and one in §16 (pin labels colliding when
two pins are close, and clipping when long — the component cannot measure text
at render time, so every fix is a design decision).

## Wave 6, done — what the contract layer actually holds

`@schlessera/brain-ui-sdk/tool-contracts` is one declaration per tool —
`{ name, description, input, brief }`, plus `payload` when the result is meant
to be drawn. React-free and node-free, so the server builds its tool definitions
and prompt brief from the same object the browser parses payloads with.

Four things are now mechanically impossible rather than merely documented, and
each was proven by seeding the failure:

1. **A tool schema'd but never described to the model.** The prompt's tool
   paragraph is generated by walking the contract list, and the map from
   contract to `SurfaceTools` key is typed `Record<BridgeToolName, …>` — a new
   contract without a key is a `tsc` error.
2. **A payload schema drifting from the interface the handler returns.**
   `tests/tool-contracts.test-d.ts` compares them in BOTH directions;
   `satisfies z.ZodType<T>` alone only proves assignability, so an added or
   dropped optional key used to compile.
3. **A component bound to a payload it does not fit**, and a component reading
   a field the payload does not carry. Both are `tsc` errors through
   `bind(contract, Component)`.
4. **A server writing an output the browser cannot parse.**
   `tests/bridge-tools.test.ts` runs every payload tool on BOTH adapters and
   parses the real result through its contract.

Five things worth knowing before touching it:

- **`query_activity` deliberately has no payload.** Its result is untrusted text
  from past runs inside a nonce delimiter, and handing that to a component is a
  separate decision with its own threat model. It is a plain `ToolContract`, and
  `bind()` will not accept one.
- **`parseToolPayload` returns null, never throws.** A denial, a timeout, a
  browser without the capability and an older server all answer with prose, and
  the renderer falls back to the raw output. Blanking the row would hide that
  the call happened at all.
- **A bound contract registers every spelling of its name — bare, MCP-prefixed,
  and the pre-rename `mcp__brain_ui__` — globally.** The tool belongs to the
  chat UI, not to one backend. Anything backend-SCOPED beats a global renderer,
  which is why the Claude pack's own entry for the location tool had to go.
- **pi's `request_image_mask` now serialises its payload** instead of reporting
  a sentence. That moved a characterization fixture on purpose; the drift test
  says so in words.
- **The registry latch is gone in two places.** `registerBuiltinRenderers` and
  `registerAsrClients` both latched behind a module boolean that the matching
  `reset*` could not clear, so one reset un-registered them for everything that
  ran after. Idempotence now belongs to the registries — pack identity and
  provider id — and both registries can be reset and re-registered.

## The method that keeps earning its keep

Every gate added this session was proven by **seeding the bug it claims to
catch** and watching it fail. That is not ceremony — it caught three tests that
were not load-bearing, two of them mine:

- the roving-tabindex hazard stories, which all four caught only because the
  fallback clause was seeded away;
- an anisotropy test that compared two lengths for equality and passed against
  degree-space arithmetic;
- a clip-splitting test whose line had a wholly-outside segment, so a different
  branch split it and the test passed against an implementation that never split
  at a boundary at all.

And twice this session a person looking at Storybook found what the whole suite
could not — a graph rendered as a line, a lane drawn as two runs, a map being
stretched. **Assertions about props, roles, counts and computed styles cannot
see a component that has vanished or a projection that is wrong in both axes at
once.** Wave 7 covers some of that now; the habit of looking still matters.
