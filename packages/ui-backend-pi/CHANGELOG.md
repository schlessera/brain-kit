# @schlessera/brain-backend-pi

## 0.39.0

### Minor Changes

- f5a8f81: The model can offer up to two follow-ups under its answer (#40). `show_block` gains a thirteenth kind, `suggestions`: `label?` and `items[1..2]{label, icon?}`, each label one line of 4-80 characters. That is the data of the kit's `SuggestionChips` without `tone`, and a type test holds the two together in both directions. Both backends offer it through the tool description; the per-turn brief is unchanged.

  `@schlessera/brain-ui-react` draws the turn's last valid call as the answer's closing row, a row of chips after the text and share menu, never where the call was made. A chip puts its words in the composer, below any draft, and never sends: no message, no answer to a pending question, no approval. The row is gone once the reader sends anything. It is not drawn while the turn runs, while a question in the turn is unanswered, when the answer ends in a question, while voice holds the composer, or on a turn spoken in a voice conversation. The client also drops duplicates, a restatement of the reader's own question, and generic filler. The decision reads only the transcript and current state, so a replayed session draws what the live one did. Shares and prints leave suggestions out, and the welcome chips are unchanged.

- ba23fcc: Search can order results by relevance judgment. A new `Reranker` seam (`defineReranker`, `RerankCandidate`, `Ranked`, and `runRerankerContract` in `@schlessera/brain/testing`) has one built-in, `jev`: one TypeSafe System One Choice over the candidates per search, with each candidate's title, type, tags, summary, matched excerpt and lifecycle fields (status, relevance, updated) as evidence. It is the default rerank mode when `TYPESAFE_API_KEY` is set; without the key, search keeps the `heuristic` ordering. Measured with `brain eval` on a 1,133-document brain, hybrid hit@1 went from 0.407 (heuristic) and 0.556 (none) to 0.741 on 27 hand-written queries.

  `rerank` accepts `none | heuristic | jev` on `brain search`, `brain eval`, the MCP `brain_search` tool and `BRAIN_RERANK_MODE`. `heuristic` and `none` keep their meaning. The MCP input's default of `heuristic` is gone: an omitted `rerank` now follows the brain's `reranker.provider`. `jev` does not apply the lifecycle multipliers after its order. Applied there, they undid most of its gain.

  A new `reranker` config block sets `provider`, `model` (pinned to `jev-1.13.0`), `apiKeyEnv`, `exclude` (paths never sent, which keep their retrieval rank), `timeoutMs`, `depth` and an opt-in `skipMargin`. A reranker that fails, times out, or returns anything but a permutation leaves the retrieval order and says so in `warnings`. `brain search --rerank-dry-run` prints the outbound request and sends nothing. `brain eval` records `meta.reranker` and refuses a `--rerank jev` it cannot run. `brain doctor` gains a `reranker` check. `TYPESAFE_API_KEY` is forwarded to brain subprocesses and cron jobs.

  The helpers a search fanning out over several sources needs to rerank the union are exported: `partitionForRerank`, `mergeWithheld`, `assertPermutation`, `buildPathMatcher`, `candidateKey`, `selectReranker` and `rerankSetup`.

### Patch Changes

- e5d3cc0: A replayed user message no longer shows the notes pi adds about the images it resized, converted or dropped (`[Image: original 4032x3024, displayed at …]`) as if the user had typed them (#549). The history reader removes a trailing run of those notes after a blank line, so the replayed text is the text that was sent, which is also what the host matches a message's source on.
- Updated dependencies [f5a8f81]
- Updated dependencies [0c19962]
- Updated dependencies [ba23fcc]
- Updated dependencies [cf94a81]
- Updated dependencies [e5d3cc0]
- Updated dependencies [b8c355d]
- Updated dependencies [9342cd2]
  - @schlessera/brain-ui-sdk@0.39.0
  - @schlessera/brain@0.39.0

## 0.38.0

### Minor Changes

- 54b21fe: Search's recency boost now follows your own document types. A type spec takes an optional `halfLifeDays`; without it, a type decays over its `staleDays`, else 365 days. The built-in half-life table named types from one particular taxonomy, so in most brains every type fell through to 365 days. It is gone: only the four core types carry a default half-life (`context` 30, `note` 60, `index` 365, `identity` 1095). A brain whose types matched the old table, such as `project` (180 days) or `expertise` (730), sets `halfLifeDays` on them to keep that decay. `SearchDeps` and `RerankerConfig` take an optional `taxonomy`, and `brain search`, the MCP server, `brain context`, `brain process` and the pi backend pass the brain's.
- 0c47609: The pi backend's `brain_graph` now also returns `nodes`: the `path`, `title`, `type`, `summary` and `updated` of every document its edges touch, as the MCP tool does. A pi agent no longer has to read each neighbour to learn what it is. `BrainAccess.graph()` now resolves to `{ edges, nodes }` instead of the bare edge list, and its reads come from one snapshot.

  `brain_graph` and `brain_list` in the pi backend no longer cut their JSON mid-string at 30,000 characters, which left text that did not parse and a graph that lost nodes. They keep that budget, and cut by structure instead. A graph keeps its first edges in walk order, with the nodes of their endpoints, and adds `truncated: true` and `omitted_edges`. A listing drops whole rows and adds `truncated: true` and `omitted`. The JSON always parses, and every returned edge has its endpoint nodes.

- faba978: The pi backend's `brain_read` takes the same optional `section` and `max_tokens` as the MCP tool and `brain read`, so a pi agent can read one section of a long document, or get its outline, instead of the whole file. Called with only a path, it returns what it did before. `@schlessera/brain` now exports the shared reader, `readDocumentPart`, together with `SectionNotFoundError` and `ReadPartOptions`.
- 3b71a3a: The pi backend's `brain_search` tool takes the same date inputs as the MCP tool: `updated_since`, `updated_before`, `deadline_from` and `deadline_to` (inclusive `YYYY-MM-DD`), `sort` (`score`, `updated` or `deadline`) and `upcoming` (deadline from today, sorted by deadline). An invalid date or sort is a tool error. `@schlessera/brain` now exports `isIsoDate` and `SEARCH_SORTS`.
- 806d061: Archiving through `brain_update` (MCP and the pi backend) now applies the same relevance rule as `brain archive`: setting `status: "archived"` turns a `primary` or missing relevance into `historical`, and the result's `changes` lists `"relevance"`. The rule reads the effective relevance, so a `primary` passed in the same call is demoted too, and an explicit `secondary` or `historical` (in the document or in the call) stays. Before, a status edit left the document claiming `primary`, and `brain validate` then warned about a state the product had written. The rule is exported from `@schlessera/brain` as `relevanceOnArchive`. The conference-aftermath skill now archives with `brain archive` instead of setting `status: archived` by hand.

### Patch Changes

- 548561f: Archiving a document and `brain_update` (over MCP and in the pi backend) now change only the frontmatter keys they set. Every other byte is kept: YAML comments, quoting, key order, flow or block sequences, blank lines, and the body. Before, the whole frontmatter block was re-serialized, so a one-field change dropped comments and restyled lists. A value in a form the new editor does not rewrite (a multi-line flow sequence, a multi-line plain scalar, a flow map, keys indented under the fence), or an edit that would not read back exactly as asked, types included, falls back to the old serializer. Block scalars (`summary: |`) and quoted keys are edited in place, comment and blank lines inside a value are kept, line endings are kept, and a date-like list entry is quoted so it stays a string. A quoted key spelled with escapes (`"sta\u0074us"`) also falls back. `@schlessera/brain` exports the editor as `editFrontmatter` and `updateDocument`.
- acd47da: The pi backend's `brain_context` tool now assembles its hits with core's assembler, the same one `brain context` uses. The pool of hits is sized from the budget, a hit that does not fit is skipped instead of ending the block, and each hit gets core's one-line header. Snippets no longer carry `>>>`/`<<<` highlight markers or open sections of their own. Identity and current focus stay out, since the pi session already loads them. Search warnings still lead the block, but only in whatever budget the block leaves. `@schlessera/brain` now exports `assembleContext`, `estimateTokens` and the `AssembleOptions` type. `AssembleOptions` takes a `warnings` array that collects the search's warnings.
- 2727668: The README no longer describes one particular deployment's container when it explains installing pi's optional packages on boot.
- Updated dependencies [1751c05]
- Updated dependencies [ee55f82]
- Updated dependencies [6757475]
- Updated dependencies [e2325b2]
- Updated dependencies [8c1daaa]
- Updated dependencies [3c2b20e]
- Updated dependencies [3bcb130]
- Updated dependencies [8c6a3f5]
- Updated dependencies [9ce7d84]
- Updated dependencies [61d2869]
- Updated dependencies [93e12bd]
- Updated dependencies [8c97273]
- Updated dependencies [60e9fbd]
- Updated dependencies [bad7650]
- Updated dependencies [0268bf1]
- Updated dependencies [7668c7c]
- Updated dependencies [aec3dd8]
- Updated dependencies [3c1310c]
- Updated dependencies [a57da97]
- Updated dependencies [25e4911]
- Updated dependencies [00391fd]
- Updated dependencies [c7aed00]
- Updated dependencies [2ed2d21]
- Updated dependencies [a9094fb]
- Updated dependencies [a554aa7]
- Updated dependencies [e499c82]
- Updated dependencies [e89de6e]
- Updated dependencies [968d151]
- Updated dependencies [1c30db2]
- Updated dependencies [995ed30]
- Updated dependencies [d176c64]
- Updated dependencies [5bef3b7]
- Updated dependencies [ff9ebc2]
- Updated dependencies [6b30469]
- Updated dependencies [5d9a179]
- Updated dependencies [55fe04c]
- Updated dependencies [a59b3b1]
- Updated dependencies [548561f]
- Updated dependencies [2fac781]
- Updated dependencies [48377ab]
- Updated dependencies [6f9ab3b]
- Updated dependencies [82f6b55]
- Updated dependencies [54b21fe]
- Updated dependencies [5b9daa4]
- Updated dependencies [2d59201]
- Updated dependencies [8e5229a]
- Updated dependencies [1d29fcd]
- Updated dependencies [dd5e87f]
- Updated dependencies [d1ad02b]
- Updated dependencies [2b02102]
- Updated dependencies [97baef6]
- Updated dependencies [f82fc83]
- Updated dependencies [9c53741]
- Updated dependencies [8e84ba8]
- Updated dependencies [d4b62d3]
- Updated dependencies [94fd8c9]
- Updated dependencies [acd47da]
- Updated dependencies [faba978]
- Updated dependencies [3b71a3a]
- Updated dependencies [70a5502]
- Updated dependencies [b5bf884]
- Updated dependencies [2d985ba]
- Updated dependencies [ff023f6]
- Updated dependencies [18c4495]
- Updated dependencies [d350daa]
- Updated dependencies [e4b5251]
- Updated dependencies [51ad062]
- Updated dependencies [7e5e363]
- Updated dependencies [bc10acc]
- Updated dependencies [2025590]
- Updated dependencies [4224247]
- Updated dependencies [5b8e614]
- Updated dependencies [cc5b868]
- Updated dependencies [cb19184]
- Updated dependencies [48c4000]
- Updated dependencies [7c513fb]
- Updated dependencies [02b3d13]
- Updated dependencies [2cb91e2]
- Updated dependencies [4cdb0c3]
- Updated dependencies [806d061]
- Updated dependencies [532347f]
- Updated dependencies [02b2c85]
- Updated dependencies [803a496]
  - @schlessera/brain@0.38.0
  - @schlessera/brain-ui-sdk@0.38.0

## 0.37.0

### Minor Changes

- 907e8bc: Archiving a document through `brain_update` now raises an approval card.

  Archiving is confirmed because it is a visibility change: an archived document
  drops out of search, briefings and context assembly, so a silent archive shows
  up later as holes in output nobody can account for. Two paths to it stopped for
  approval — `brain_archive` is off the default allowlist, `brain archive` matches
  a confirm pattern — and a third did not. `brain_update` takes the same `status`
  field and is auto-allowed, so `status: "archived"` made a document invisible to
  every later search with no card, no confirmation and no record.

  `decideToolPermission` now raises a per-use confirmation for a document update
  that sets `status: "archived"`, and both backends pass it their spelling of the
  tool (`updateToolName`). It is deliberately a per-use confirmation, never a
  grantable tool approval: a remembered "always allow" would reopen the hole for
  good.

  Nothing else changes. An update with no `status`, or with `"active"` or
  `"draft"`, runs unprompted exactly as before — this is not a card on every
  document edit. `brain_update`'s MCP input schema, output shape and name are
  untouched.

- 6ae12e7: A destructive-command approval card now says what the command will do.

  - Added: each default confirm pattern carries an `effect` phrase ("delete a directory and everything inside it"). A `command` approval's reason is that phrase, and both approval cards show it.
  - Changed: `DEFAULT_CONFIRM_BASH_PATTERNS` entries are `{ pattern, effect }`. `confirmBashPatterns` and `compileConfirmPatterns` accept that form or a bare regex source; a bare source keeps the old generic sentence.
  - Changed: `BRAIN_UI_CONFIRM_BASH` accepts the object form too. A non-empty list with no entry of a usable shape now means the defaults rather than "no confirmation". A list whose patterns are all invalid regexes still compiles to none (#251).

- 4ed02fb: An approval that comes back with an edited input is re-checked before it runs, on both backends.

  - Added: `checkEditedApproval` in `@schlessera/brain-ui-sdk/server`.
  - Changed (pi): an edit that needs a confirmation the card did not show (another confirm pattern, another archived document) is refused instead of applied.
  - Changed (Claude): an edited confirmation that passes the re-check is applied instead of refused, as `updatedInput` with no `permissionDecision`. `canUseTool` re-checks edits too, and the rtk rewrite leaves a confirmed command alone.

- 7b6b2b0: An approval that edits a confirmed shell command into a different command that still needs confirmation is now refused.

  - Changed: `checkEditedApproval` identifies a shell confirmation by the command text as well as the pattern. `brain archive a.md` can no longer be approved as `brain archive b.md`, and a narrower command (`rm -rf notes` → `rm -rf notes/old`) must be re-issued and confirmed as it is. An edit that needs no confirmation of its own is still applied.
  - Changed: an edited input carrying an own `__proto__` key is refused on both backends, instead of being merged into the tool arguments.
  - Changed: `requestToolPermission` hands back an approval's edited input as one plain JSON snapshot, so what is checked is what runs; an edit that is not a plain object or will not serialize is denied.

- ecc93b9: A turn can declare `enforceAllowedTools`, and a tool its allowlist leaves out
  is then no longer re-admitted without a decision.

  Several things used to re-admit it, which is the point rather than the number.
  The Claude backend's input-rewrite hooks answered `permissionDecision: "allow"`
  so their `updatedInput` would apply, which makes the runtime skip `canUseTool`
  entirely — an rtk-rewritten shell command ran in a turn whose allowlist had no
  `Bash` in it, with no card and no record. The ws host answered from its
  remembered "always allow" grants before any card existed, so a grant given
  under a wide posture was honoured under a narrow one. And the runtime admits
  some calls on its own before the callback is reached at all — by the shape of a
  shell command, by the tool being a built-in, or because a hook declared in the
  project settings said so.

  Under the declaration the rewrites still rewrite — `updatedInput` applies
  without a decision attached, so the rewrite was never what the grant was for —
  a PreToolUse hook answers "ask" for every off-list tool, which overrides the
  runtime's own auto-approval, and the host neither answers from nor adds to its
  grant store for a tool outside the turn's allowlist. Backends mark such
  requests `outsideEnforcedAllowlist` so the host does not have to guess, and it
  records both halves of the refusal — a grant it declines to apply, and an
  "always allow" it declines to keep. A turn
  that declares nothing is unchanged, and existing grants keep working on the
  postures that can honour them.

- 54eea05: `BRAIN_UI_EXEC_WRAPPER`: an absolute path to an executable that agent and brain
  CLI subprocesses are launched through, as `<wrapper> <program> <args…>`. It lets
  a host run those children as another user without the packages knowing how. The
  wrapper is an argv[0], never a command line — no shell parses it, so a value
  full of metacharacters is a filename rather than a command. A wrapped child
  leads its own process group and an abort signals the group, because a uid drop
  otherwise makes `kill(2)` fail with EPERM and leaves an aborted turn running.

  Every brain CLI launch is covered too, not only the agent's tool spawns — and
  scheduled cron jobs with them: the CLI imports the repository's
  `brain.config.ts`, so a search executes repository code exactly as a tool call
  does. When a wrapper is configured the program is resolved to an absolute path,
  because a wrapper execs its target directly and because `PATH` must not get to
  choose which `bash` runs.

  `BRAIN_UI_EXEC_KILLER` is the companion seam. `kill(2)` matches uids and group
  membership grants no exception, so once a wrapper has dropped privileges the
  server can signal nothing at all; a host that drops uid supplies an authorised
  helper, invoked as `<killer> <pgid> <TERM|KILL|INT>`. With neither configured,
  and with a wrapper that has not changed uid, the group signal is used directly.
  A cancellation that fails entirely is reported rather than swallowed.

  Unset — which is every existing deployment — every spawn is exactly what it was.

- 97837c1: A turn that declares `noGrantSurface` without `enforceAllowedTools` is now refused.

  - Added: `assertTurnPosture(req)` in `@schlessera/brain-ui-sdk/server`.
  - Changed: both backends' `startTurn` reject that request with a `BackendRequestError` before anything is emitted. A turn declaring both, `enforceAllowedTools` alone, or neither is unchanged.

- 1de4d6c: A turn can declare `noGrantSurface`, and a permission request it cannot put to
  anyone is then denied instead of parked. `enforceAllowedTools` removed the ways
  a tool got admitted without a decision; what it left was the decision itself —
  an off-posture tool raises an approval card, and in a turn nobody is looking at
  (a spoken one, an unattended one) that is a card nobody can answer, held until
  the turn budget expires.

  Under the declaration both backends refuse the request where it is raised, with
  a message that names the tool and is written to be read aloud, and report it on
  the activity side channel so the record shows a denied span rather than a call
  that errored. Both request kinds are covered, including the confirm-pattern
  `command` request a destructive shell command raises for an allowlisted `Bash`
  — on the Claude backend that one never reaches `canUseTool` at all. The mask
  editor, which opens a window and then blocks on a region someone has to paint,
  is withheld from such a turn rather than offered and blocked on.

  The `ask` the Claude backend's enforcement hook answers is unchanged: it is
  what beats the runtime's own shortcuts, and this changes the decision it
  forces, not the ask. A turn that declares nothing is unchanged, and so is one
  that declares only `enforceAllowedTools`.

- 3031422: The pi SDK (`@earendil-works/pi-coding-agent`, `pi-agent-core`, `pi-ai`) moves
  from 0.84.4 to 0.87.1, so `openai-codex` profiles for `gpt-6-sol` and
  `gpt-6-luna` (and `gpt-6-astra`) now resolve instead of failing with
  `Unknown model`. `gpt-5.6-sol`, `gpt-5.6-luna` and `gpt-5.6-terra` still
  resolve. pi 0.86.0 dropped `gpt-5.4` and `gpt-5.4-mini` from its OpenAI Codex
  catalog, so a profile still naming either now fails with `Unknown model`.
- 4d409c0: A run's effective cost is now priced by the route its inference actually took,
  not by model id alone. The two pricing catalogs carry some of the same ids at
  different rates — OpenRouter resells models their vendors also sell directly —
  so a run that went straight to the vendor was being priced at OpenRouter's
  resale rate whenever both catalogs listed its model. On
  `deepseek/deepseek-chat`, live today, that overstates output cost by 2.1x.

  Backends now classify a profile's route (`classifyRoute`, beside
  `classifyBilling`); it is resolved once at run start, rides the root span like
  the billing mode, and selects the catalog inside the rollup. Nothing became
  async: `resolve()` is still synchronous and still never touches the network.

  Coverage does not narrow. A run whose route is unknown — everything recorded
  before this change, or a profile behind a proxy no backend recognises — prices
  exactly as it did before rather than going unpriced. A rate borrowed from the
  catalog a run did not go through still prices the run, flagged as an estimate.
  Unknown cost remains unknown and never renders as `$0`.

### Patch Changes

- 2d553e2: Reading a brain can no longer destroy its vector index. `initVecSupport` was
  both "make vectors readable on this connection" and "migrate the vector
  schema", and the migration drops every stored vector — so `brain mcp`, whose
  tools all advertise `readOnlyHint: true`, emptied `vec_chunks` on startup
  against any brain last indexed before the cosine migration. Recovering meant a
  paid `brain index --embeddings --force`.

  It is now two functions. `loadVecSupport(db)` is the read path: it loads the
  sqlite-vec extension and reports whether `vec_chunks` is there, writing nothing
  and taking no width, so a read cannot migrate whatever kind of connection it
  holds. `migrateVecSchema(db, dimensions)` is the write path, named for what it
  does, and `brain index`, `brain sync`, `brain maintain`, `brain doctor --fix`,
  the archiver and the indexer's re-embedding pass still call it.

  Two smaller fixes come with the split. Callers that are not about to re-embed
  now pass `storedVectorWidth(db, configured)` — the width the index was built
  at, from `index_metadata.embedding_dimensions` — instead of the configured
  provider's, so a provider swap no longer re-declares the table at a width the
  stored vectors are not in. And `sqlite-vec not available` is now printed only
  when the extension really failed to load; a read-only connection that could not
  write used to report it, sending readers off to reinstall a working dependency.

  The migrations themselves are now atomic. Each runs in a transaction, so a
  half-applied one — a table dropped and not rebuilt, or rebuilt and not
  refilled — can no longer leave the vector index gone, and a failure is
  reported rather than swallowed: `migrateVecSchema` used to return true having
  emptied the store. `storedVectorWidth` reads the width off `vec_chunks`' own
  declaration before believing `index_metadata`, and accepts one only as plain
  decimal within sqlite-vec's 1..8192 range.

  `initVecSupport` is gone from `@schlessera/brain`'s exports. Out-of-tree callers
  that only read vectors want `loadVecSupport`, branching on the exported
  `VecSupport`/`VecUnavailableReason` when they need the cause; callers that are
  about to embed want `migrateVecSchema`.

- Updated dependencies [7fe9bc0]
- Updated dependencies [907e8bc]
- Updated dependencies [dd8ae8a]
- Updated dependencies [0970d31]
- Updated dependencies [e77ab6f]
- Updated dependencies [b3529ac]
- Updated dependencies [5f7dbb5]
- Updated dependencies [e802456]
- Updated dependencies [6ae12e7]
- Updated dependencies [d9d4061]
- Updated dependencies [4ed02fb]
- Updated dependencies [7b6b2b0]
- Updated dependencies [ecc93b9]
- Updated dependencies [acad158]
- Updated dependencies [d33492e]
- Updated dependencies [54eea05]
- Updated dependencies [97837c1]
- Updated dependencies [1de4d6c]
- Updated dependencies [ac94af4]
- Updated dependencies [95ef35d]
- Updated dependencies [fa09aaa]
- Updated dependencies [731282f]
- Updated dependencies [2d553e2]
- Updated dependencies [08d4ed2]
- Updated dependencies [4d409c0]
- Updated dependencies [146d5a9]
- Updated dependencies [92a599d]
- Updated dependencies [fb1d784]
- Updated dependencies [4fc7f0b]
- Updated dependencies [4157941]
- Updated dependencies [0d28bae]
- Updated dependencies [f4edb02]
- Updated dependencies [09d9f4e]
- Updated dependencies [af2affb]
- Updated dependencies [f489482]
- Updated dependencies [f7b46d3]
- Updated dependencies [1bf00b8]
  - @schlessera/brain-ui-sdk@0.37.0
  - @schlessera/brain@0.37.0

## 0.36.0

### Minor Changes

- edb547b: Both backends register `show_block` and auto-allow it. It needs nothing from
  the host bridge, so it is always present: the Claude backend's `brain-ui` MCP
  server now exists on every turn (as `mcp__brain-ui__show_block`), and pi's
  bridge tool list carries it unconditionally, classed `read` in the risk table
  because it touches nothing. The system-prompt brief names it on both.
- f5512f7: Tool component contracts: one declaration per tool, read by both halves.

  A tool that renders as a component was previously described in four places at
  once — a name constant, a description constant, an input schema, a payload
  interface the handler happened to return, and a hand-written paragraph in the
  system prompt. Nothing tied them together, so a tool could be schema'd and
  never described to the model, and a renderer could be typed for a payload the
  handler had stopped sending.

  `@schlessera/brain-ui-sdk/tool-contracts` is now the single declaration:
  `{ name, description, input, brief }`, plus `payload` for a tool whose result
  is meant to be drawn rather than read. It is React-free and free of node
  built-ins, so the server builds its tool definitions and prompt brief from the
  same object the browser parses payloads with. The four bridge tools —
  `ask_user`, `get_current_location`, `request_image_mask`, `query_activity` —
  are declared there; the handlers stay in `/server` and both barrels re-export
  the contracts, so backend import sites are unchanged.

  What this closes:

  - The prompt's tool paragraph is GENERATED from the contract list. Adding a
    contract without deciding how a backend declares its tool is a `tsc` error.
  - Payload schemas are bound to their interfaces in both directions by a
    compile-time equality test, so a schema that drifts from what the handler
    returns fails the typecheck rather than a renderer at runtime.
  - `pi`'s `request_image_mask` now serialises its payload into `output` like
    every other payload tool, instead of reporting a sentence. That is a
    deliberate change to what the model sees, and it carries the `note` field pi
    used to drop.
  - Both backends convert input schemas through one helper, so the same tool
    advertises the same JSON Schema on either adapter.

### Patch Changes

- Updated dependencies [9827a47]
- Updated dependencies [bbc90ab]
- Updated dependencies [6b57843]
- Updated dependencies [b3a3ffd]
- Updated dependencies [2c9e5d3]
- Updated dependencies [edb547b]
- Updated dependencies [f5512f7]
  - @schlessera/brain-ui-sdk@0.36.0
  - @schlessera/brain@0.36.0

## 0.35.0

### Patch Changes

- Updated dependencies [f89897b]
- Updated dependencies [545f2f9]
- Updated dependencies [7a4b5af]
- Updated dependencies [cc48069]
- Updated dependencies [1ddc4bb]
- Updated dependencies [60e05c6]
- Updated dependencies [84b748c]
- Updated dependencies [8adb53d]
  - @schlessera/brain-ui-sdk@0.35.0
  - @schlessera/brain@0.35.0

## 0.34.1

### Patch Changes

- Updated dependencies [aade466]
  - @schlessera/brain-ui-sdk@0.34.1
  - @schlessera/brain@0.34.1

## 0.34.0

### Patch Changes

- 4adb327: Added the published backend contract harness and moved both first-party backends onto it.
- 17706aa: Add the shared permission-decision core and split backend factories into focused turn, usage, and runtime modules.
- c6d9a30: Add self-describing backend modules and make the server registry iterate their profile, settings, billing, credential, and discovery hooks.

  Preserve descriptor resolution hooks and model discovery when a third-party backend is passed by value through the static registry, and validate active backend-owned profile rules before startup completes without requiring or strictly parsing inactive backend packages.

  Change session routing to reject an unknown non-empty stored backend id instead of silently substituting the default; null and empty legacy ids still use the default.

- e326368: Add characterization coverage for backend permissions, streaming, usage, and history.
- a41e81a: - Define the four browser bridge tools once in the UI SDK while preserving Claude's names, descriptions, schemas, and result envelopes.
  - Reject NUL, absolute, traversal-escape, and symlink-escape paths before either backend writes an image mask.
  - Give pi's `ask_user` the full shared description, 1–4 question and 2–4 option bounds, a 12-character header bound, and optional option previews.
  - Require pi's `ask_user.multiSelect` instead of defaulting it to `false`.
  - Return pi's shared `ask_user` payload (echoed questions, answers, and annotations) to the model while keeping the full `AskUserResult` in details.
  - Advertise and validate pi's `query_activity.scope` as the shared enum.
- Updated dependencies [4adb327]
- Updated dependencies [17706aa]
- Updated dependencies [c6d9a30]
- Updated dependencies [a41e81a]
  - @schlessera/brain-ui-sdk@0.34.0
  - @schlessera/brain@0.34.0

## 0.33.1

### Patch Changes

- 5b7fb32: Restrict repo-owned subprocess environments by audience, preserve first-party CLI and module capability settings, and add an operator allowlist escape hatch. Pi extensions (`pi.exec()` through `execCommand()`) and pi's package-manager helpers still inherit the full server environment because pi 0.84.4 exposes no supported environment option; 0.35.0 moves the pi runtime under the `agent` uid to close that in-SDK residual.
- Updated dependencies [5b7fb32]
  - @schlessera/brain-ui-sdk@0.33.1
  - @schlessera/brain@0.33.1

## 0.33.0

### Patch Changes

- Updated dependencies [95a180c]
- Updated dependencies [54725c0]
- Updated dependencies [07d63eb]
  - @schlessera/brain-ui-sdk@0.33.0
  - @schlessera/brain@0.33.0

## 0.32.0

### Minor Changes

- ec340d2: Add the experimental audience-tagged subprocess environment descriptor and strip server-only credentials from brain CLI and agent subprocesses while retaining agent authentication, git credentials, and unknown operator variables.

### Patch Changes

- Updated dependencies [ec340d2]
  - @schlessera/brain-ui-sdk@0.32.0
  - @schlessera/brain@0.32.0

## 0.31.0

### Patch Changes

- @schlessera/brain@0.31.0
- @schlessera/brain-ui-sdk@0.31.0

## 0.30.1

### Patch Changes

- @schlessera/brain@0.30.1
- @schlessera/brain-ui-sdk@0.30.1

## 0.30.0

### Minor Changes

- eac9b98: feat: web search providers are toggles, and the agent knows which are live

  Settings → Models → Web search replaces its single provider dropdown with
  per-provider toggles (Exa, DuckDuckGo, Brave, Jina, Perplexity, Tavily,
  OpenAI, Gemini, Firecrawl, Kagi), each with its own API-key field, cost note
  and description.

  Enabled providers are written to `web-search.json` as an ordered
  `searchRouting.providers` chain sorted cheapest-first, with every failure kind
  in `fallbackOn`. An ordinary search is answered by a free provider; a paid one
  like Perplexity is only reached when the cheap ones fail, or when the agent
  asks for it by name.

  The pi backend's system prompt now names the providers that are actually
  reachable. This matters because `pi-web-access` hard-codes ~28 provider names
  into its own tool description regardless of configuration — a model reading
  only that will ask for a provider with no key and get an error. The brief also
  carries the cost gradient, so the agent knows to leave `provider` off unless a
  question warrants a specific one.

  Two hazards are now handled explicitly:

  - A `provider`/`searchProvider` key in `web-search.json` overrides
    `searchRouting` entirely, and pi's own `/curator` command writes one back.
    Writes here delete both keys, and the settings UI reports a stray one as an
    override rather than showing a chain that is not running.
  - A provider with no credential is skipped at search time, so enabling one is
    refused up front. Credentials are detected from the config file _or_ the
    environment, so a key supplied as `PERPLEXITY_API_KEY` counts.

  The provider catalog, path resolution and override rules now live in
  `@schlessera/brain-ui-sdk/server` (`WEB_SEARCH_PROVIDERS`, `webSearchBrief`,
  `resolveWebSearchConfigPath`), replacing three hand-maintained copies.

### Patch Changes

- Updated dependencies [eac9b98]
  - @schlessera/brain-ui-sdk@0.30.0
  - @schlessera/brain@0.30.0

## 0.29.0

### Patch Changes

- @schlessera/brain@0.29.0
- @schlessera/brain-ui-sdk@0.29.0

## 0.28.1

### Patch Changes

- @schlessera/brain@0.28.1
- @schlessera/brain-ui-sdk@0.28.1

## 0.28.0

### Minor Changes

- d4fcf65: "Always allow" per tool.

  - Approval cards gain an **Always allow** button: the host remembers the
    tool (server `settings` table) and answers its future requests without a
    card — for both backends and any extension/MCP tool, since the grant is
    applied host-side in the ws bridge before a card is ever emitted.
  - Permission requests now carry a `kind`: `"tool"` (grantable) vs
    `"command"` (a destructive-bash confirm-pattern confirmation). Kind
    "command" can neither be remembered nor auto-answered — the client hides
    the button and the host refuses a tampered `always` flag — so the
    destructive-command seatbelt stays per-use.
  - Settings → Models gains an **Always-allowed tools** list with per-tool
    revoke (`GET/DELETE /api/tool-permissions`).
  - Wire protocol: additive `always?: boolean` on `tool_approval`, additive
    `kind?` on `tool_approval_request` (re-delivered cards included).

### Patch Changes

- Updated dependencies [d4fcf65]
- Updated dependencies [e381a99]
  - @schlessera/brain-ui-sdk@0.28.0
  - @schlessera/brain@0.28.0

## 0.27.0

### Minor Changes

- afbe784: pi backend parallelism.

  - **Keyed locks replace the pi backend's global write mutex**: file writes
    lock per path, brain document tools share one key, and bash locks the
    repo-git key only for git-staging/history and brain-CLI write commands
    (`bashLockKey`, shared with the Claude backend via ui-sdk). Builds, greps
    and other read-shaped bash run lock-free, so pi's parallel sibling tool
    calls and parallel sessions actually execute in parallel. Injecting the
    legacy `writeLock` option restores whole-lock serialization.
  - **`subagent` fan-out**: the `pi-subagents` extension's tool joins the
    default allowlist (parity with Claude's auto-allowed Agent tool), and the
    system-prompt brief names it when the package is installed.
  - **Backend-honest execution brief**: `buildSystemPromptAppend` gains an
    `execution` option (subagent tool name, per-turn-process semantics,
    parallel tool calls). The Claude backend's text is unchanged; pi's brief
    now tells the model to batch independent tool calls (they run
    concurrently) and no longer references subagents it doesn't have.

### Patch Changes

- Updated dependencies [afbe784]
  - @schlessera/brain-ui-sdk@0.27.0
  - @schlessera/brain@0.27.0

## 0.26.0

### Minor Changes

- 8b41fc3: pi backend parity with the Claude backend.

  - **Approvals**: mutations no longer each raise a card. A single `tool_call`
    permission gate (inline extension, fires before every tool — curated and
    extension-registered) implements the Claude posture: allowlisted tools run
    free, destructive bash shapes confirm (shared
    `DEFAULT_CONFIRM_BASH_PATTERNS`, moved to `brain-ui-sdk/server`),
    non-allowlisted tools ask. `brain_archive` keeps its card.
  - **Context**: both `AGENTS.md` AND `CLAUDE.md` load when the brain repo has
    both (pi previously took AGENTS.md alone — the Claude backend reads
    CLAUDE.md, so the two backends saw different instructions). The
    system-prompt append is now built per session from the opening turn's
    client environment and turn budget, like the Claude backend's per-turn
    brief.
  - **Tools**: curated surface extended to the full brain MCP set
    (`brain_read`, `brain_list`, `brain_graph`, `brain_update`,
    `brain_archive`) plus bridge-backed `get_current_location` (reverse
    geocoding shared via `brain-ui-sdk/server`), `query_activity`, and
    `request_image_mask`, each registered per host capability.
  - **Extensions**: `loadExtensions` now defaults to true — the gate covers
    extension tools. Recommended: `pi-web-access` (web search/fetch,
    auto-allowed like Claude's WebSearch/WebFetch) and `pi-mcp-adapter` (MCP
    servers from `.mcp.json`, prompted like non-allowlisted MCP tools).
  - **rtk**: when the `rtk` binary is on PATH, both backends route bash
    commands through rtk's rewrite oracle (`git status` → `rtk git status`,
    60-90% less output for the model to read). Applied after gating, so
    confirm patterns see the original command; absent rtk changes nothing.
  - **Upstream bump**: pi SDK 0.80.10 → 0.84.4 (`pi-coding-agent`,
    `pi-agent-core`, `pi-ai`). Verified: event mapping already delta-based
    (0.84's `message_update` change), auth already on the `ModelRuntime` API,
    extension install + load re-tested on 0.84.4.
  - **Web search settings**: new Settings → Models → "Web search" card (pi
    deployments only). Provider select defaults to Auto — Exa's free keyless
    tier — with per-provider API keys (Exa, OpenAI, Brave, Tavily, Perplexity,
    Firecrawl, Jina, Kagi, Gemini) stored server-side in the pi config dir's
    `web-search.json`, the file pi-web-access reads. Key values never travel to
    the client; hand-edited config fields beside the managed ones survive; a
    save clears pi's extension cache so new conversations pick the change up.

### Patch Changes

- Updated dependencies [8b41fc3]
  - @schlessera/brain-ui-sdk@0.26.0
  - @schlessera/brain@0.26.0

## 0.25.0

### Minor Changes

- 02552ed: Per-model reasoning effort, editable in Settings → Models.

  - Effort-capable rows (the pi backend's profiles — Claude rows have no effort
    knob) get a tri-state effort select next to billing: "Default (<level>)"
    shows the configured level, an explicit pick is stored server-side
    (`PUT /api/models/thinking`, full record like hidden/billing) and applies
    to the NEXT new session — no env edit, no redeploy. Resumed sessions stay
    pinned.
  - `ProviderInfo.thinkingLevel` (additive) carries the effective level, and
    its presence marks a profile as effort-capable; `ModelCatalogEntry` gains
    `thinkingOverride`. `ThinkingLevel`/`THINKING_LEVELS`/`isThinkingLevel`
    join the sdk protocol.
  - `CreatePiBackendOptions.profiles` also accepts a function, re-read on every
    roster listing and model resolution, which is how the host applies settings
    overrides live.

### Patch Changes

- Updated dependencies [02552ed]
  - @schlessera/brain-ui-sdk@0.25.0
  - @schlessera/brain@0.25.0

## 0.24.0

### Minor Changes

- 88c03d9: Configurable default model, user-managed OpenRouter models, auto-collapsing
  thinking.

  - **Default model** (Settings → Models): the profile used when a turn names
    none — a fresh device's first conversation, a share filed into the brain,
    host-initiated actions. Stored server-side; "Auto" prefers a CONNECTED
    subscription account (pi's `openai-codex` — probed via the new
    `hasStoredCredential()` export, a cheap read of pi's auth store) and falls
    back to the built-in default. The resolved default also leads
    `/api/providers`, so a fresh picker lands on it.
  - **OpenRouter models** (Settings → Models): add or remove models by id
    (e.g. `z.ai/glm-5.3-flash`) with no env edit or redeploy. Stored ids join
    the Claude roster as declared OpenRouter profiles (api-billed via
    `OPENROUTER_API_KEY`); removing the model behind the stored default resets
    the default to auto.
  - **Thinking sections auto-collapse** when their streaming completes,
    leaving the "Thought for ~N tokens" affordance to reopen them.

### Patch Changes

- Updated dependencies [88c03d9]
  - @schlessera/brain-ui-sdk@0.24.0
  - @schlessera/brain@0.24.0

## 0.23.0

### Minor Changes

- 472a2d0: Sign in to pi model providers from Settings — no shell on the host needed.

  - `@schlessera/brain-backend-pi` exports `createPiAuth()`: a headless OAuth
    service over pi's `ModelRuntime.login` that answers the method prompt with
    the device-code flow (the browser flow would bind a callback port on the
    server), captures the user code from the auth event stream, and exposes a
    start/poll/cancel/logout surface. Credentials persist through pi's own
    locked store (`~/.pi/agent/auth.json`, `PI_CODING_AGENT_DIR` aware), so a
    login is immediately visible to the chat backend.
  - ui-server mounts `/api/pi-auth/*` behind the auth guard, lazily loading the
    optional pi package; provider ids are validated against the configured
    roster's vendors, and the endpoints report an empty provider list when pi
    is not in play.
  - Settings → Models grows an **Accounts** section (hidden on Claude-only
    deployments): Connect shows the device code and verification link, polls to
    completion, and Disconnect removes the stored credential. This is the
    intended path for connecting OpenAI (ChatGPT Plus/Pro) for the
    `openai-codex` gpt profiles.

### Patch Changes

- @schlessera/brain@0.23.0
- @schlessera/brain-ui-sdk@0.23.0

## 0.22.0

### Minor Changes

- 2a1c6c5: Run the pi backend alongside Claude, with declared model profiles — the path
  to OpenAI models under a ChatGPT subscription.

  - New `BRAIN_UI_PI_PROFILES` env var (JSON array of
    `{id,label,vendor,model,thinkingLevel?}`): when set with the default
    `AGENT_BACKEND=claude`, the pi backend joins the registry and its profiles
    join the picker. pi-ai's built-in `openai-codex` vendor authenticates only
    via ChatGPT Plus/Pro OAuth (`pi login`, device-code capable), so e.g.
    `{"id":"gpt-sol","label":"GPT-5.6 Sol","vendor":"openai-codex","model":"gpt-5.6-sol","thinkingLevel":"xhigh"}`
    runs on the subscription, not API tokens.
  - Fail-loud everywhere a wrong-but-plausible default could hide: malformed
    profiles JSON, duplicate/reserved ids (`default`, `claude`, `claude-*`),
    and invalid thinking levels refuse at boot; a missing pi package with the
    variable set refuses at boot; a declared vendor/model absent from pi's
    catalog rejects the turn instead of letting pi pick a provider; a resume
    whose saved model is unavailable rejects instead of silently substituting.
  - Billing classification keys on the profile vendor: `openai-codex` →
    subscription, other pi vendors (ambient API keys) → api. Claude
    classification is unchanged.
  - `PiProfile` gains `thinkingLevel` (passed to new sessions; pi clamps to the
    model's capability).

### Patch Changes

- d4261bb: Complete the per-backend tool-call rendering abstraction.

  The renderer registry was already backend-scoped, but the timeline hardcoded
  `backend: "claude"`, three code paths bypassed the registry (header label,
  touched-file summary, subagent-row gating), and risk advisories keyed on
  Claude tool names — so pi tool calls fell to the generic tier and risky pi
  `bash`/`write_file` inputs raised no approval-card advisories.

  - `session_info` now carries `backendId` (rev 3, additive); backends stamp
    their own, the host stamps stored sessions on resume/reattach. The client
    records it per session and scopes renderer resolution with it.
  - `ToolRenderer` grows `label`, `touchedFile`, `subagentRows`, and a
    backend-neutral `semantics` contract (`command`/`writePath`/`unsandboxed`);
    the timeline consumes only the renderer, no more name switches.
  - Risk rules now test semantics instead of Claude tool names, with a
    shape-sniffing fallback for renderers that declare none — the same rm -rf /
    force-push / curl|sh / writes-outside-repo advisories fire for every
    backend.
  - New pi renderer pack: `bash`, `read_file`, `write_file`, `edit_file`,
    `grep`, `brain_search`, `brain_context`, `brain_add` render with the same
    dedicated views (diff, file write, command, grep rows) as the Claude pack;
    pi's bare `ask_user` is recognized by the ask-user card grouping.

- Updated dependencies [d4261bb]
  - @schlessera/brain-ui-sdk@0.22.0
  - @schlessera/brain@0.22.0

## 0.21.0

### Patch Changes

- @schlessera/brain@0.21.0
- @schlessera/brain-ui-sdk@0.21.0

## 0.20.0

### Patch Changes

- 00565d5: Activity-layer review follow-ups (the items deferred from the 0.19.0 review):

  - **Watchdog** (ui-server): a per-job stuck-threshold override below the
    default now actually fires — the scan uses the smallest effective
    threshold, the per-span check still applies each job's own.
  - **Push retry** (ui-server): `send_failed` intents are retried with a
    3-attempt budget and 5-minute backoff (migration 009 adds
    `send_attempts`) — a transient push-service failure no longer forfeits
    push delivery for that notification.
  - **Restart notification** (ui-server): turns interrupted by a server
    restart now produce a failure intent — the boot orphan sweep runs after
    the notifier exists, so its terminal writes are seen by the first tick.
  - **Digest** (ui-server): generation is one immediate transaction and the
    covered-until write is monotonic — a manual run racing the cron job can
    no longer double-count a window or regress the retention floor.
  - **Prune index** (ui-server): migration 009 adds the partial index the
    hourly prune's candidate query needed and drops the unused
    `idx_activity_spans_session`.
  - **PushToggle** (ui-react): now performs the server-disagreement check —
    a subscription bound to a stale VAPID key is dropped (surfacing the
    re-enable button) and a server-side pruned row is healed by re-asserting
    the subscription.
  - **Span naming** (ui-sdk): the `execute_tool <name>`/`invoke_agent`
    convention is now exported protocol constants
    (`SPAN_OP_EXECUTE_TOOL`, `SPAN_OP_INVOKE_AGENT`, `SPAN_TOOL_NAME_PREFIX`)
    instead of three independent restatements.
  - **pi usage** (backend-pi): the turn-usage accumulator narrows the SDK's
    typed `message_end` variant instead of a hand-rolled double cast.

- Updated dependencies [d97dbd0]
- Updated dependencies [00565d5]
  - @schlessera/brain-ui-sdk@0.20.0
  - @schlessera/brain@0.20.0

## 0.19.0

### Minor Changes

- b15b5f0: Agent observability: a full activity layer across the stack.

  - **Activity record** (ui-server): an OTel-GenAI-aligned span store in the
    server SQLite records every turn, tool call, subagent run and cron run as
    a tree — written at start, closed write-once with a six-outcome taxonomy
    (`denied` and `interrupted` are first-class), with boot/staleness sweepers
    (heartbeat-keyed), a stuck-run watchdog, per-run rollups that survive
    pruning forever, and a digest-floor + hard-ceiling retention policy.
  - **Wire protocol** (ui-sdk, rev 3 additive): view-scoped
    `activity_subscribe`/`activity_snapshot`/`activity_delta` frames with a
    seq-discard ordering contract, a `usage` block (per-model token/cost
    breakdown) on `result`, and subagent linkage (`parentToolUseId`) on tool
    frames. `server_hello` advertises `capabilities.activity`.
  - **Backends**: the Claude adapter stops flattening subagent activity
    (task lifecycle, per-subagent usage, forwarded transcripts to the new
    bridge side channel; `forwardSubagentText` on; SDK floor 0.3.241) and
    reports full `modelUsage`; the pi backend reports per-turn token usage
    from its event stream. The new read-only `mcp__brain-ui__query_activity`
    tool lets the agent answer "what ran / what is running?" from the record.
  - **UI** (ui-react): live subagent rows with a stacked drill-in view
    (observation-shaped; approvals actionable there and in the chat), one
    server clock for live and reloaded duration badges, and a first-class
    Activity surface — live runs, history, rollup cards, failure inbox with
    nav badges, a while-you-were-away digest card, and a three-state web-push
    toggle. Activity takes the mobile tab-bar slot; Graph moves to More.
  - **Notifications** (ui-server): persisted intents (at-least-once, storm-
    capped, watched-suppressed) with an in-app inbox as the guaranteed tier
    and web push (generated VAPID keys in a secret-classified table,
    per-device subscriptions, minimized payloads, 404/410 pruning) on top.
  - `getCronStatus` now lists every recorded job name, closing the gap that
    hid module jobs from `/api/status`; the sessions listing merges stored
    cost accounting over backend zeros.

### Patch Changes

- Updated dependencies [b15b5f0]
  - @schlessera/brain-ui-sdk@0.19.0
  - @schlessera/brain@0.19.0

## 0.18.0

### Patch Changes

- Updated dependencies [a29b287]
  - @schlessera/brain-ui-sdk@0.18.0
  - @schlessera/brain@0.18.0

## 0.17.0

### Patch Changes

- Pin the whole @earendil-works family at one exact version (0.80.10): with
  the pins split across versions, a fresh install nested an incompatible
  pi-ai copy under pi-coding-agent and the backend failed at import time. A
  release guard now enforces pin coherence.

- 210446f: Unify boolean environment parsing across all packages: every boolean variable
  now accepts 1/true/on/yes and 0/false/off/no (case-insensitive, trimmed), and
  an unset, empty, or unrecognised value falls back to the variable's documented
  default instead of being misread. Defaults and directions are unchanged;
  previously `"1"`-only flags (the Chrome sandbox switches, `TRUST_PROXY`,
  `BRAIN_UI_DANGEROUSLY_DISABLE_AUTH`, `BRAIN_UI_ALLOW_PASSWORD`,
  `BRAIN_UI_ALLOW_LOOPBACK_ORIGIN`) accept the full truthy set, and the disable
  set for `BRAIN_UI_REVERSE_GEOCODE` / `BRAIN_UI_MODEL_DISCOVERY` gains `no`.
  `NO_COLOR` keeps its presence-based contract. Published descriptor types
  (`ENV_VARS` shapes) are unchanged.
- b84e70f: Finish wiring the observability layer through the server: report what already failed silently.

  The layer itself was sound — OpenTelemetry API on the producing side, our own
  console/recording/in-memory consumers on the other — but adoption stopped at
  two instruments, so most failures still answered the browser and left no
  server-side trace.

  - Turn lifecycle: every turn now emits "turn started" / "turn completed"
    (INFO, with `session.id` / `turn.id` / `profile` and duration), and every
    turn-failure path that previously only sent an error frame — SESSION_BUSY,
    BACKEND_REQUEST_ERROR, BACKEND_ERROR, FOLLOWUP_FAILED, SESSION_LOAD_ERROR —
    also logs (WARN for busy, ERROR otherwise) and feeds a `turns.failed`
    counter keyed by the bounded error code. `turns.started` / `turns.completed`
    counters and the turn-timeout WARN's correlation ids come with it.
  - Auth: password logins are observable — WARN on a failed password and on the
    rate limit, INFO on success, and a distinct ERROR when `Bun.password.verify`
    throws (a corrupt BRAIN_UI_PASSWORD_HASH is no longer reported as a wrong
    password). Failures land on the same `auth.failures` counter passkeys use.
  - Request logging now runs through the observability layer (method, path,
    status, duration; no query strings or bodies) instead of hono's raw-console
    `logger()`, so BRAIN_UI_LOG_LEVEL governs it; `/api/health` is skipped.
  - `/api/health` performs a SELECT 1 liveness probe of the app database and
    answers 503 `{"status":"unhealthy"}` when it fails — the Docker healthcheck
    no longer reports healthy over a wedged SQLite handle.
  - The dead `log?` seams (graph/files/share/render/models routes, settings,
    keyterm builder, share staging, the backend registry) actually receive a
    logger from `createApp`, and session-catalog write failures WARN with the
    session id instead of being swallowed.
  - New `recordCronRun(db, jobName)` export lets an external scheduler (the
    container crontab in the shipped deployment) record runs into `cron_runs`,
    so `/api/status`'s `cronJobs` reflects what actually ran.
  - WebSocket: the upgrade handlers gained `onError` (WARN + `ws.errors`
    counter), and broadcast send failures count on `ws.frames.dropped` with
    reason `broadcast_send_failed`, direction `outbound`.
  - Backends take an optional minimal `log` callback (no OTel dependency):
    the Claude backend routes its unparseable-confirmBashPatterns warning
    through it (console.warn only when standalone), and the pi backend's
    resource-loader fallback — which silently dropped the chat-surface
    system-prompt append — now says so.

- 6e1fd43: Fix per-connection protocol state never reaching the WS dispatcher (declared
  protocolRev was dropped, so the rev-3 turnId-echo requirement was never
  enforced), extract the tool-view diff engine into `lib/diff.ts`, and clean up
  dead imports/variables surfaced by the new oxlint gate.
- a714ee1: Per-package `test` scripts now pass `--timeout 30000`, so `bun run test` inside a package no longer flakes on bun's 5s default when suites spawn the CLI.
- ef519d1: Harden the publish surface: what a consumer installs now matches what the
  declarations, bundler and runtime actually reach for.

  - `@schlessera/brain-backend-pi` declares `@earendil-works/pi-agent-core`
    (exact-pinned, like its sibling pi pins) instead of borrowing it from
    hoisting — its public `history.d.ts` types reference the package, so a
    strict installer (pnpm, npm with isolated modes) could not typecheck it.
  - `@schlessera/brain-ui-react` sets `sideEffects` to `["**/*.css"]` — the
    blanket `false` licensed bundlers to tree-shake a direct
    `import "@schlessera/brain-ui-react/styles.css"` away entirely.
  - `./theme.css` now resolves from `dist/` (copied verbatim at build) like
    `./styles.css` already did, so both stylesheets survive a dist-only tarball
    and the export map is uniform. The import specifier is unchanged.
  - `@schlessera/brain-module-finance`, `-images` and `-speaking` declare the
    same optional `@types/bun` peer that `-jobs` already carried: their module
    declaration graphs reach `bun:sqlite` types through `@schlessera/brain`.
  - Every package exports `"./package.json"` — tooling like Vite, Tailwind and
    Jest stats it, and the export map previously made that unreachable.
  - `engines.bun` is aligned with reality: bun-runtime packages require
    `>=1.3.5` (the CVE-2026-24910 floor `brain doctor` warns below), and
    packages that import cleanly under plain Node carry no bun engines field.
    Scrape keeps its (bumped) engines despite importing node-clean: its proxy
    fetch path shells out through `Bun.spawn`, so the runtime constraint is
    real even though the import is not.
  - Backend loading in `@schlessera/brain-ui-server` uses `await import()`
    instead of CJS `require()`, and only "the backend package itself is not
    installed" maps to the install-hint error. An installed-but-broken backend
    (missing transitive dep, syntax error, `ERR_REQUIRE_ESM`) now surfaces its
    real error instead of a misleading "not installed".

- Updated dependencies [210446f]
- Updated dependencies [6e1fd43]
- Updated dependencies [a714ee1]
- Updated dependencies [ef519d1]
  - @schlessera/brain@0.17.0
  - @schlessera/brain-ui-sdk@0.17.0

## 0.16.0

### Patch Changes

- Updated dependencies [a7362e1]
- Updated dependencies [7ea32f7]
- Updated dependencies [0fc9c44]
  - @schlessera/brain-ui-sdk@0.16.0
  - @schlessera/brain@0.16.0

## 0.15.0

### Patch Changes

- Updated dependencies [4d3d28a]
- Updated dependencies [0af99c4]
  - @schlessera/brain@0.15.0
  - @schlessera/brain-ui-sdk@0.15.0

## 0.14.0

### Minor Changes

- 59de559: - Added: every package reads the environment in one chokepoint that declares
  each variable, exports the contract (`ENV_VARS`, `resolveEnv`, `readEnvVar`)
  from the package entry, and generates its README env table from it.
  - Added: `ui-server` exports a resolved `ServerConfig` and returns an app handle
    (`config`, `db`, `wsHost`, `isTurnActive`, `cancelActiveTurns`, `close`), so
    two differently-configured apps coexist in one process.
  - Added: `openBrainDb`/`withBrainDb` gate every `brain.db` read on
    `schema_version`; `assertBackendResolvable` refuses to boot when the selected
    agent backend is not installed.
  - Changed: `@schlessera/brain-backend-claude` is an optional peer of
    `ui-server`, not a dependency — a deployment declares the backend it uses.
  - Changed: the module contract carries the config generic through
    `CommandContext`, `HygieneContext` and `CommandModule`, so a module author no
    longer casts a value the loader already validated.
  - Changed: the Gemini providers no longer delete and restore `GOOGLE_API_KEY`
    around client construction.
  - Removed: `configureDb`, `getDb`, `closeDb`, `configureWsHost`,
    `defaultWsHost`, `cancelActiveTurn`, `isTurnActive`, the `brainClient`
    namespace and the `getBackends`/`getBackendsInfo` module functions — their
    replacements live on the app handle.

### Patch Changes

- Updated dependencies [59de559]
  - @schlessera/brain@0.14.0
  - @schlessera/brain-ui-sdk@0.14.0

## 0.13.1

### Patch Changes

- Updated dependencies [01004ef]
  - @schlessera/brain@0.13.1
  - @schlessera/brain-ui-sdk@0.13.1

## 0.13.0

### Patch Changes

- Updated dependencies [a4eb4d0]
- Updated dependencies [fc5c897]
- Updated dependencies [2be49b8]
- Updated dependencies [2be49b8]
- Updated dependencies [2be49b8]
  - @schlessera/brain@0.13.0
  - @schlessera/brain-ui-sdk@0.13.0

## 0.12.1

### Patch Changes

- @schlessera/brain@0.12.1
- @schlessera/brain-ui-sdk@0.12.1

## 0.12.0

### Patch Changes

- Updated dependencies [4281c59]
  - @schlessera/brain@0.12.0
  - @schlessera/brain-ui-sdk@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies [604abbc]
- Updated dependencies [cdfa039]
  - @schlessera/brain-ui-sdk@0.11.0
  - @schlessera/brain@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [e6f55e0]
- Updated dependencies [e33db75]
- Updated dependencies [50f6ec7]
- Updated dependencies [683f3e3]
- Updated dependencies [fc79a8f]
  - @schlessera/brain@0.10.0
  - @schlessera/brain-ui-sdk@0.10.0

## 0.9.0

### Minor Changes

- 1f7e6a3: Added: mermaid diagrams get their own share menu (PNG / PDF / SVG / source) and a
  full-screen pan-and-zoom viewer, opened by tapping the diagram.
  Added: a chat-surface brief appended to the agent's system prompt —
  `buildSystemPromptAppend({ client, tools })` — covering diagrams, `<share>`
  blocks, wikilinks, raw-HTML and tool-narration rules, the ask-user and location
  tools, and what the reader's device can do. Each backend declares its own tool
  names (pi has no location tool), and both take a `systemPromptAppend` option to
  override the whole brief.
  Added: `chat_message` frames carry an optional `client` field
  (`ClientEnvironment`: form factor, touch, standalone, camera, microphone,
  geolocation, share sheet, viewport, locale, timezone), feature-detected in the
  browser and validated strictly at the boundary. The Claude backend rebuilds its
  system-prompt append per turn from it.
  Changed: diagrams render in a theme built from the app's own tokens instead of
  mermaid's stock dark/neutral themes; exports use the matching light theme.
  Changed: `MermaidTheme` is now `"dark" | "light"` (was `"dark" | "neutral"`),
  `ShareMenu`'s `renderTrigger` also receives `status` and `icon`, and the
  server-internal `handleChatMessage` takes an options object.

### Patch Changes

- Updated dependencies [1f7e6a3]
  - @schlessera/brain-ui-sdk@0.9.0
  - @schlessera/brain@0.9.0

## 0.8.0

### Patch Changes

- @schlessera/brain@0.8.0
- @schlessera/brain-ui-sdk@0.8.0

## 0.7.2

### Patch Changes

- @schlessera/brain@0.7.2
- @schlessera/brain-ui-sdk@0.7.2

## 0.7.1

### Patch Changes

- @schlessera/brain@0.7.1
- @schlessera/brain-ui-sdk@0.7.1

## 0.7.0

### Patch Changes

- Updated dependencies [b8cbf72]
  - @schlessera/brain@0.7.0
  - @schlessera/brain-ui-sdk@0.7.0

## 0.6.3

### Patch Changes

- @schlessera/brain@0.6.3
- @schlessera/brain-ui-sdk@0.6.3

## 0.6.2

### Patch Changes

- @schlessera/brain@0.6.2
- @schlessera/brain-ui-sdk@0.6.2

## 0.6.1

### Patch Changes

- Updated dependencies [89d8a72]
  - @schlessera/brain@0.6.1
  - @schlessera/brain-ui-sdk@0.6.1

## 0.6.0

### Patch Changes

- @schlessera/brain@0.6.0
- @schlessera/brain-ui-sdk@0.6.0

## 0.5.1

### Patch Changes

- @schlessera/brain@0.5.1
- @schlessera/brain-ui-sdk@0.5.1

## 0.5.0

### Patch Changes

- Updated dependencies [2904074]
  - @schlessera/brain-ui-sdk@0.5.0
  - @schlessera/brain@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [2c42696]
  - @schlessera/brain-ui-sdk@1.0.0
  - @schlessera/brain@1.0.0

## 0.3.0

### Patch Changes

- Updated dependencies [9e4668b]
- Updated dependencies [e08752c]
  - @schlessera/brain@0.3.0
  - @schlessera/brain-ui-sdk@0.3.0

## 0.2.1

### Patch Changes

- Republish with correct internal dependency pins. The 0.2.0 manifests pinned
  cross-dependencies to 0.1.0, a version that was never published, making five
  of the eight packages uninstallable.
- Updated dependencies
  - @schlessera/brain@0.2.1
  - @schlessera/brain-ui-sdk@0.2.1

## 0.2.0

### Minor Changes

- rename brainform to brain-kit

### Patch Changes

- Updated dependencies
  - @schlessera/brain@0.2.0
  - @schlessera/brain-ui-sdk@0.2.0
