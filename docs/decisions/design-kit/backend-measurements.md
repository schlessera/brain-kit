# Design kit — Backend measurements

Part of the [design-kit decision record](../design-kit.md). Entries retain their
original dates and order within this subject; the index maps the complete chronology
and relationships with [other subjects](../design-kit.md#subjects).

<a id="2026-09-25--measured-the-claude-backend-at-server-level-beside-pi-137"></a>

## 2026-09-25 — measured: the Claude backend at server level, beside pi (#137)

**Question.** pi drew a block on 52 of 60 turns (87%, "2026-09-22 — measured: pi draws the block" above). The
Claude backend drew one on 76–77% in D43 and D44, and that residue had three
possible explanations: the layer, the tool roster, or the backend. None of the
three had been measured. D43 and D44 drive the Agent SDK directly. pi was
measured through the whole server. So no backend had been measured at both
layers, and the Claude arm had never run where its brain tools could appear.

**Method.** `scripts/measure-show-block-server.ts --backend claude --model
claude-sonnet-5`, at pi's counts: prompts 0–3 at six reps and 4–7 at two, run
twice. That is 64 turns on 2026-09-25, from 01:45:23Z (the first measured
turn's stream) to 02:12:48Z. It is the shipping configuration, with the bridge
server always loaded (D44) and the brief in the prompt. Claude Code 2.1.280 ran
under `@anthropic-ai/claude-agent-sdk` 0.3.280. The brain was a copy of
`packages/core/fixtures/corpus/`. It was not a git repository and was indexed
with `brain index` before the first turn. D43's counting rules carry over
unchanged. **Every one of the 64 turns completed, and 2 are excluded for
leaving the brain (below), so 62 are counted.**

The environment presences the harness recorded, identical on all four run
files: `CLAUDE_CODE_OAUTH_TOKEN` set. `TYPESAFE_API_KEY`, `ANTHROPIC_BASE_URL`,
`ANTHROPIC_API_KEY`, `CLAUDE_CODE_PATH` and `PI_CODING_AGENT_DIR` were unset.
So these turns billed the subscription, where pi's billed an API key. The
classification pass was off throughout. None of that can move what the model
does during a turn.

**Isolation, and what it took.** #50 abandoned this control twice. Three smoke
turns found three more leaks, each shown in the CLI's own session transcript
and each closed before the measured runs:

- **The brain has to live outside the operator's home directory, not only
  outside a checkout.** `settingSources: ["project"]`,
  `packages/ui-backend-claude/src/sdk-options.ts:146`, makes the CLI walk up
  from the cwd, and at every ancestor it reads `.claude/CLAUDE.md`,
  `.claude/skills/` and `.claude/agents/`. A brain anywhere under a home
  directory therefore loads `~/.claude/CLAUDE.md` as *project* instructions,
  together with that user's skills and agents. An empty `CLAUDE_CONFIG_DIR`
  does not stop this, because the walk never consults it. This is the leak
  #50 put down to the config directory. The brain ran from a path under
  `/tmp` with no `.claude` ancestor.
- **A copied login is not a deployment's credential.** With a copied
  `.credentials.json` in the empty config directory, the CLI fetched the
  account profile. It then put the account's email address into the context,
  and the model quoted it back when asked whose brain this was. It also
  connected the account's claude.ai connectors, so mail, calendar and drive
  tools joined the deferred roster. Passing the same subscription's access
  token as `CLAUDE_CODE_OAUTH_TOKEN`, the variable a deployment sets, removed
  both. `apiKeySource` was `none` on every turn, and the server's own
  subscription gate admitted each one. **Deviation, recorded:** this is a
  login token passed through the variable meant for a `claude setup-token`
  token, not a setup token itself.
- **Auto-memory reads outside the brain.** The CLI's memory prompt sent the
  model to read its memory directory under `CLAUDE_CONFIG_DIR`, and the
  escape rule correctly dropped that turn. **Deviation, recorded:** the brain
  copy's own `.claude/settings.json` sets `autoMemoryEnabled: false`. The
  same file sets `enableAllProjectMcpServers: true` for the brain's
  `.mcp.json`. Both are brain-repo settings the backend already loads, not
  changes to the backend. pi has no memory feature, so this narrows a
  difference rather than adding one.

**Two turns left the brain anyway, and the harness did not see it.** Run 1's
fifth `trend` turn and run 2's fourth each looked for git history. Both ran
`find / -maxdepth 3 -iname "*.git" -type d` and got back repositories
elsewhere on the host. The saved `escapedBrain` flag is `false` on both,
because the rule (`export function escapesBrain`,
`scripts/measure-show-block-server.ts:280`) looked only for `~/` and `/home/`
paths when these turns ran. A bare `/` never matched that pattern. This brain
lived under `/tmp`, so a path elsewhere outside `/home` would not have matched
either. #360 closed the gap. So the
audit here reads every path-like token handed to a non-block tool — a
bare `/`, `~` and `..` included — out of the CLI's own transcripts. It finds
exactly these two turns. Both are **excluded**, under the rule the harness
states: a turn whose shell left the brain is not a measurement of this brain.
Both drew a `trend` block, so the exclusion lowers the Claude rate rather than
flattering it. `trend` is also the prompt that cost pi its four excluded
turns.

> **2026-09-30 — Corpus ruling.** The former corpus in this measurement is historical.
> [One Odysseus world](../example-corpus.md) now governs every example surface.
> The original passage and measured results below are preserved as evidence.

Apart from those two, an audit of all 64 transcripts found no tool argument
naming a path outside the brain, no instruction file, no user skill or agent,
and no account email. Skills and agents were only the CLI's built-ins. Every
contact answer named Alex Example, and every schedule answer reasoned about
the corpus's own dates. The per-turn roster was read from each turn's
stream-json `init` message. The CLI was launched through
`BRAIN_UI_EXEC_WRAPPER`, and the wrapper copied its stdout to a file and
changed nothing else. The roster was then joined to the CLI's session
transcript by session id.

**The roster each turn saw**, identical on all 62 counted turns. `init` lists
34 tool names, but that list is an inventory. The session transcript's
`deferred_tools_delta` announces 16 of those names by name only, so they are
behind tool search rather than in the prompt as schemas.

| | Claude backend (this run) | pi (#50) |
| --- | --- | --- |
| in the prompt as schemas | 13 CLI tools (`Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `Agent` (`Task` in `init.tools`), `Skill`, `ToolSearch`, `ListAgents`, `ReportFindings`, `ScheduleWakeup`, `Workflow`) plus the five bridge tools, `show_block` among them: 18 | pi's curated surface: `read_file`, `grep`, `bash`, the file writers, the eight `brain_*` tools, and the bridge tools with `show_block` |
| behind tool search, by name only | **all eight `mcp__brain__*` tools**, plus 16 CLI tools (`WebFetch`, `WebSearch`, `NotebookEdit`, the cron, plan-mode, worktree and messaging tools and others) | nothing; pi cannot defer a registered tool |
| called, across the counted turns | `Bash` 103, `Read` 72, `show_block` 40, `Grep` 28, `Glob` 5, `ToolSearch` 5, `brain_search` 3, `brain_list` 3 | `bash`, `show_block`, `brain_read`, `grep`, `brain_search`, `read_file`, `brain_list`, `brain_graph` |

**The brain MCP tools are in the Claude roster, but deferred.** The brain's
`.mcp.json` registers a stdio server without `alwaysLoad`, so the CLI lists its
eight tools by name only, behind `ToolSearch`. This is the configuration every
brain made from the template ships, not a harness artefact. The model loaded
them in 5 of 62 turns and called one in 3. It read the brain with `Bash` and
`Read` instead. D43 found the same mechanism for `show_block`. Here it applies
to the tools that read the brain.

**The rate, on one axis.** Each cell counts turns that drew at least one
accepted block. Right kind is scored against the kind the brief prescribes.
The excluded turns are out of every cell.

| prompt | expected kind | Claude, run 1 | Claude, run 2 | Claude, pooled | pi, pooled |
| --- | --- | --- | --- | --- | --- |
| `compare-short` | `comparison` | 6/6 | 6/6 | **12/12**, right 12 | 12/12, right 12 |
| `compare-long` | `comparison` | 6/6 | 6/6 | **12/12**, right 12 | 12/12, right 12 |
| `trend` | `trend` | 5/5 | 5/5 | **10/10**, right 10 | 8/8, right 8 |
| `contact` | `contact` | 0/6 | 0/6 | **0/12** | 5/12, right 5 |
| `steps` | `steps` | 2/2 | 1/2 | **3/4**, right 3 | 4/4, right 4 |
| `schedule` | `schedule` | 2/2 | 0/2 | **2/4**, right 0 (`timeline` ×2) | 4/4, right 0 (`timeline` ×4) |
| `quote` | `quote` | 0/2 | 0/2 | **0/4** | 3/4, right 3 |
| project summary | — | 0/2 | 1/2 | **1/4** (`receipt`) | 4/4 |
| overall | | 21/31 | 19/31 | **40/62 (65%)** | **52/60 (87%)** |

Right kind is 37 of 39 scorable turns on Claude and 44 of 48 on pi. Both
backends make the same kind error: they draw `timeline` where the brief
prescribes `schedule`. Neither backend typed a markdown table on any turn,
and the handler rejected no Claude call. pi counted eight `trend` turns and
Claude ten, and Claude drew on every one. With `trend` held at pi's eight,
Claude reads 38/60 (63%).

**The gap is wider than it looked, and it is not a flat rate.** Measured at
the same layer on the same prompts, it is 87% against 65%, not 76–77%. The
whole gap sits in five prompts, and all five are answered by reading the
brain: `contact`, `quote`, the project summary, `steps` and `schedule`. On the
three prompts where both backends draw every time, they match at 34 of 34
against 32 of 32. On `contact` and `quote` the Claude backend drew nothing in
16 turns. It typed the answer instead, with the quote as a markdown
blockquote all four times, which is the classification pass's candidate
rather than the tool's.

**The three candidates.** None is ruled out.

1. **The layer is still open, though what could be compared looks the
   same.** The SDK harness and this one share three prompts verbatim:
   `compare-short`, `compare-long` and `contact`. With the tools loaded, the
   SDK harness drew on 6/6, 6/6 and 1/6 of them (D43's per-prompt table, both
   arms), and #148 reports `contact` at 0/3 in both of D44's arms. This run
   drew on 12/12, 12/12 and 0/12. The pattern on those three is similar at
   both layers. That does not rule out a layer effect on the prompts the two
   harnesses do not share. `trend`, `steps` and `quote` are worded
   differently, and `schedule` and the summary have no SDK-level counterpart.
   Most of the gap to pi sits in exactly those prompts. So the 76–77% against
   65% difference is at least partly prompt mix, and this run cannot say it
   is only that.
2. **The roster is still open, and it is the leading suspect.** On the
   prompts where the backends diverge, they differ in exactly the way that
   could matter. On pi the brain tools are in the prompt and get called. On
   the Claude backend they are deferred and almost never loaded. The two
   prompt-level rosters also differ in size and composition — 18 schemas here,
   pi's curated set there. This run cannot separate the roster from candidate
   3, because the roster and the backend changed together.
3. **The backend itself is still open** for the same reason.

The next measurement changes one roster difference on the brain side:
`alwaysLoad: true` on the brain's own stdio server in `.mcp.json`, which puts
the eight `brain_*` tools in the Claude prompt the way pi has them. The
server-level harness can run it unchanged, and it is #358. It tests whether
eager brain tools close the gap. It does not make the two rosters equal: the
13 CLI tools and pi's curated set still differ. A behind-tool-search
`show_block` cell was not needed, because nothing in the always-loaded result
turned on it.

**What this does not say.** Sixteen turns at two reps per prompt on prompts
4–7 are thin. The `steps`, `schedule` and summary cells can move by a turn in
either direction on a re-run, as `schedule`'s 2/2 against 0/2 already shows.
The `contact` and `quote` cells are the firm ones: 0 of 16 on Claude against 8
of 16 on pi. `contact` as its own question belongs to #119. The two backends
also billed differently, the subscription here and an API key on pi. No
mechanism is known by which billing reaches what the model decides, but the
two runs were not identical in that respect.

<a id="2026-09-25--measured-eager-brain-tools-change-how-the-claude-backend-reads-the-brain-no-observed-gain-on-contact-or-quote-358"></a>

## 2026-09-25 — measured: eager brain tools change how the Claude backend reads the brain; no observed gain on `contact` or `quote` (#358)

**Question.** The entry above left the tool roster as the leading suspect for
the gap to pi, which sits in the prompts answered by reading the brain. On pi
the eight `brain_*` tools are in the prompt. On the Claude backend they come
from the brain's `.mcp.json` as a stdio server without `alwaysLoad`, so they
wait behind `ToolSearch`. This run changes that one difference and nothing
else: does the rate on the brain-reading prompts move when the brain tools
are in the Claude prompt?

**Method.** The same harness, model, prompts and counts as #137:
`scripts/measure-show-block-server.ts --backend claude --model
claude-sonnet-5`, prompts 0–3 at six reps and 4–7 at two, run twice. That is
64 turns on 2026-09-25, from 04:51:00Z (the first measured turn's stream) to
05:15:43Z, on Claude Code 2.1.280 under `@anthropic-ai/claude-agent-sdk`
0.3.280. The environment is #137's, rebuilt rather than reused: a fresh copy
of `packages/core/fixtures/corpus/` under `/tmp`, outside any home directory
and checkout, with no `.claude` ancestor and no git repository, indexed
before the first turn. `HOME` and `CLAUDE_CONFIG_DIR` were empty, the
subscription's access token was passed as `CLAUDE_CODE_OAUTH_TOKEN`, and
the brain copy's `.claude/settings.json` set `autoMemoryEnabled: false` and
`enableAllProjectMcpServers: true`. The environment presences on all four run
files were `CLAUDE_CODE_OAUTH_TOKEN` alone, and `apiKeySource` was `none` on
every turn. **The one difference:** the brain's `.mcp.json` entry carried
`"alwaysLoad": true`. One smoke turn (`contact`) confirmed the roster and the
isolation before the measured runs. **All 64 turns completed. 3 are excluded
for leaving the brain (below), so 61 are counted.**

**The roster each turn saw**, identical on all 64 turns and read the way #137
read it: the `init` inventory minus the names the session transcript's
`deferred_tools_delta` announced.

| | Claude backend, eager brain tools (this run) | Claude backend, shipping (#137) |
| --- | --- | --- |
| in the prompt as schemas | the same 13 CLI tools and five bridge tools, **plus all eight `mcp__brain__*` tools**: 26 | 13 CLI tools and five bridge tools: 18 |
| behind tool search, by name only | 16 CLI tools, the same 16 as #137 | the same 16 CLI tools plus all eight `mcp__brain__*` tools |
| called, across the counted turns | `brain_read` 61, `show_block` 43, `Bash` 35, `brain_list` 26, `brain_search` 25, `brain_context` 6, `Skill` 1 | `Bash` 103, `Read` 72, `show_block` 40, `Grep` 28, `Glob` 5, `ToolSearch` 5, `brain_search` 3, `brain_list` 3 |

**The change took.** No turn called `ToolSearch`, `Read`, `Grep` or `Glob`.
33 of the 61 counted turns called a brain tool, against 3 in #137, and every
one of the 28 turns on prompts 3–7 read the brain through the brain tools
alone. `Bash` survived only on `trend`, where the model counted files by
creation date. The only skill loaded was the CLI's built-in `dataviz`, once,
on a `trend` turn.

> **2026-09-30 — Corpus ruling.** The former corpus in this measurement is historical.
> [One Odysseus world](../example-corpus.md) now governs every example surface.
> The original passage and measured results below are preserved as evidence.

**Three turns left the brain.** All three are `trend` turns in run 1. One ran
`find / -maxdepth 3 -iname "brain"`, and two listed the directory that holds
the brain copy. The harness's escape rule, conservative since #360, flagged
all three itself. The transcript audit read every path-like token handed to a
non-block tool, a bare `/`, `~` and `..` included, and found the same three
and no others. All three are **excluded**. Two of them drew a `trend` block
and one did not, so the exclusion moves the overall rate from 44/64 (68.75%)
to 42/61 (68.85%). Apart from those, the audit found no
instruction file, no user skill or agent, and no account email. Skills and
agents were the CLI's built-ins, the same list #137 saw. Every `contact`
answer named Alex Example.

**The rate, on one axis**, beside #137's Claude run and pi's run. Each cell
counts turns that drew at least one accepted block. The excluded turns are
out of every cell.

| prompt | expected kind | eager, run 1 | eager, run 2 | eager, pooled | Claude #137, pooled | pi, pooled |
| --- | --- | --- | --- | --- | --- | --- |
| `compare-short` | `comparison` | 6/6 | 6/6 | **12/12**, right 12 | 12/12, right 12 | 12/12, right 12 |
| `compare-long` | `comparison` | 6/6 | 6/6 | **12/12**, right 12 | 12/12, right 12 | 12/12, right 12 |
| `trend` | `trend` | 3/3 | 6/6 | **9/9**, right 8 (`timeline` ×1; one turn drew `bars` after its `trend`) | 10/10, right 10 | 8/8, right 8 |
| `contact` | `contact` | 0/6 | 0/6 | **0/12** | 0/12 | 5/12, right 5 |
| `steps` | `steps` | 2/2 | 2/2 | **4/4**, right 4 | 3/4, right 3 | 4/4, right 4 |
| `schedule` | `schedule` | 1/2 | 1/2 | **2/4**, right 0 (`timeline`, `receipt`) | 2/4, right 0 (`timeline` ×2) | 4/4, right 0 (`timeline` ×4) |
| `quote` | `quote` | 0/2 | 0/2 | **0/4** | 0/4 | 3/4, right 3 |
| project summary | — | 1/2 | 2/2 | **3/4** (`receipt`) | 1/4 (`receipt`) | 4/4 |
| overall | | 19/29 | 23/32 | **42/61 (69%)** | **40/62 (65%)** | **52/60 (87%)** |

Right kind is 36 of 39 scorable turns, against 37 of 39 in #137. The handler
rejected no call, and no turn typed a markdown table. On `quote` the model
typed the sentence as a markdown blockquote all four times, as it did in #137.

**The effect, with a number.** Over the five prompts answered by reading the
brain (`contact`, `steps`, `schedule`, `quote` and the summary), eager brain
tools drew on **9 of 28 turns, against 6 of 28 with the tools deferred**. pi
drew on 20 of 28. The whole move is three turns in the two-rep cells, the
summary and `steps`. At four turns a cell, 1/4 to 3/4 is too few turns to
call either an effect or noise. On `contact` and `quote` there was **no
observed improvement: 0 of 16 with eager brain tools, 0 of 16 deferred, and
8 of 16 on pi**. The overall rate went from 65% to 69%, and it is still 18
points short of pi's 87%.

**What that means for the roster candidate.** Deferral of the brain tools
explains *how* the Claude backend read the brain in #137. It went through
`Bash` and `Read` because the brain tools were behind tool search, and with
them in the prompt it reads through them, as pi does. It does not explain
*whether* it draws. On `contact` and `quote` the model now reads the brain
the way pi does and still typed the answer on every turn measured. So
deferral does not account for the size of pi's lead on those two cells (8 of
16 against 0 of 16). These counts cannot rule out a smaller effect: a true
draw rate of 10% still gives 0 of 4 about two times in three. It does not
rule out the roster either. The Claude prompt still carries
the 13 CLI tools, and pi carries its curated set, so the two rosters still
differ in size and composition. The layer and the backend are also still
open. Nothing here separates them from what is left of the roster.

**What this does not say.** It does not say what `brain setup` or the
template should write into `.mcp.json`. That is a separate decision this run
informs, not makes. The rate is one input to it. The prompt was 8 schemas
larger, and on prompts 3–7 the model stopped reading the brain through a
shell. Prompts 4–7 are still two reps a run, so the summary's 1/4 to 3/4
and `steps`' 3/4 to 4/4 are open in both directions, and so is an effect on
`contact` and `quote` smaller than these counts can see.
