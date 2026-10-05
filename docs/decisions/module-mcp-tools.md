# Decision — a module may contribute MCP tools, and they are contract surface

**Ruled 2026-09-28 by the maintainer on #59; specified 2026-09-30.** Binds
`ModuleContribution`, the loader, `brain mcp`, `brain module lint` and
`brain module list`, every module that ships a tool, and the tool policies of
the chat backends.

## Summary

- A module may contribute **namespaced MCP tools**. `brain mcp` serves them
  beside the eight core `brain_*` tools, as `<module>_<tool>`.
- **One compatibility policy covers every tool**, core or module. A namespace
  prevents collisions. It is not a stability exclusion. Each module owns the
  documented names, schemas and behaviour of its supported tools.
  First-party tools follow the project's versioning rules. A third-party
  module applies the same policy in its own package.
- **A tool is a second front door to an existing operation, not a second
  implementation.** It calls the same deterministic function as the module's
  CLI subcommand. Skills still orchestrate.
- **The tool set is fixed when a server process starts.** Nothing is unloaded
  at runtime, nothing is cancelled because a module changed state, and
  nothing a call completed is rolled back. This matches #527's dormancy
  model, which takes effect in the next session.
- **The first tool is `jobs_review`.** It is a read-only query over the jobs
  review queue, so a voice turn can reach a question it cannot answer today.

## Why a module needs this

The CLI-plus-skill path works wherever the agent has a shell. It fails in two
places.

1. **In a voice turn, by design.** The voice posture removes `Bash` and
   `Skill` (`export const VOICE_ALLOWED_TOOLS`,
   `packages/ui-backend-claude/src/tool-policy.ts:115-151`), for the reasons
   in [voice-permission.md](voice-permission.md#the-voice-posture): 192 of
   192 measured approvals came from `Bash`, and a skill without `Bash` fails
   partway. What the posture keeps (`brain_*`, `Read`, `Glob`, `Grep`)
   reads markdown. The jobs review queue is not markdown. It lives in the
   module's own SQLite file (`const dbPath`,
   `packages/module-jobs/src/cli.ts:58`). "Anything new in my job queue
   above 70?" therefore has no answer by voice. The agent can say it cannot
   help, or it can make something up.
2. **In a client with no shell at all.** [mcp.md](../mcp.md) names desktop
   clients and editors as consumers. From such a client, deterministic
   module logic such as the finance AR arithmetic is unreachable. The agent
   has to recompute it in-model, which is what "the CLI executes" exists to
   prevent.

Before this ruling a module could contribute taxonomy, skills, one CLI word,
hygiene checks, index rules, excludes and cron, but no tools
(`export interface ModuleContribution`,
`packages/core/src/lib/module-types.ts:120-146`).

## Alternatives rejected

- **No module tools. Modules stay CLI-plus-skill only.** This leaves both
  failures above in place. Adding `Bash` back to the voice posture to reach
  one query reopens the problem the posture closed.
- **A module registers its own MCP server, or picks arbitrary tool names.**
  That is a general MCP plugin system, a new seam that ROADMAP's second
  binding decision rules out. It also makes collisions a runtime surprise
  and not a load error. Core owns the one server and composes every module
  tool's name. A module cannot choose its prefix.
- **Expose every CLI subcommand automatically.** The CLI's argument parsing
  is not a schema (`function makeArgs`,
  `packages/module-jobs/src/cli.ts:87-106`), and its human output is not a
  result. An automatic bridge would ship interactive commands (`jobs
  triage`), mutating ones and TTY-only ones with no schema and no
  annotations. A tool is declared one at a time, deliberately.
- **Tool logic beside the CLI.** Two implementations of one operation drift
  apart, and "skills orchestrate, the CLI executes" stops meaning anything.
  The tool and the subcommand call one exported function.
- **"Namespaced means unstable."** Rejected by the ruling in so many words.
  A voice posture that names `jobs_review` depends on it the same way a
  client depends on `brain_search`.
- **Trust a tool's own `readOnlyHint` to auto-allow it.** An annotation is a
  claim made by the code being gated. Backends decide by name, as they do for
  core tools. No module tool is allowed anywhere until a backend lists it.
- **Unload or hide a tool when its module goes dormant, mid-process.** #527
  excludes runtime unloading. `brain.config.ts` is loaded with a dynamic
  `import()` (`const mod = await import(tsPath)`,
  `packages/core/src/lib/config.ts:601`), and a process caches that import,
  so a running server cannot reliably see a config change anyway. Promising
  it would be promising something the loader cannot deliver.

## How it sits with the binding decisions

- **No new seam.** `tools` is a contribution field of the existing module
  mechanism, the same kind of thing as `commands`. Nothing in core becomes
  replaceable. The not-pluggable list keeps "the `brain` CLI surface and MCP
  tool names". Core's eight names stay fixed, and the `brain_` namespace
  stays core's. That line in `docs/extending/README.md` gains one sentence:
  module tools are contributions under the shared policy, not a way to
  replace or shadow a core tool.
- **Skills orchestrate, the CLI executes.** This still holds. A tool is only
  admissible as a thin wrapper over the function that a `--json` subcommand
  already calls.
- **The machine surface is a versioned contract.** A first-party module tool
  enters `docs/integration-contract.md` when it ships. Its input schema is
  pinned the way core's are, and it is versioned by
  [contract-versioning.md](contract-versioning.md).
- **Markdown is the source of truth.** No tool gets `brain.db` handed to it.
  A tool reads what its module's CLI reads.

## The specification

### 1. Declaration

```ts
export interface ModuleContribution<C = unknown> {
  // … existing fields …
  /** MCP tools, keyed by local name. `brain mcp` serves each as `<module>_<local>`. */
  tools?: Record<string, () => Promise<{ default: ModuleTool<C> } | ModuleTool<C>>>;
}

export interface ModuleTool<C = unknown, I = unknown, O = unknown> {
  title?: string;
  description: string;            // non-empty; states defaults and caps, as core's do
  inputSchema: ZodObject;         // zod 4 object schema, .strict()
  outputSchema: ZodObject;        // required: the result is validated against it
  annotations: {
    readOnlyHint: boolean;        // required, no default
    destructiveHint?: boolean;    // required when readOnlyHint is false
    idempotentHint?: boolean;
    openWorldHint: boolean;       // required: does it reach outside the brain?
  };
  run(input: I, ctx: ToolContext<C>): Promise<O>;
}

export interface ToolContext<C = unknown> {
  root: string;
  config: C;                      // the owning module's validated block, as CommandContext has it
  taxonomy: Taxonomy;
  signal: AbortSignal;            // aborted when the client cancels the call
}

export function defineModuleTool<C, I, O>(tool: ModuleTool<C, I, O>): ModuleTool<C, I, O>;
```

- Tool code is imported lazily, as `commands` is. The loader runs for every
  CLI command, and only `brain mcp` and `brain module lint` need tool
  definitions.
- `defineModuleTool` is an identity helper, like `defineModule`. It exists
  so that `run(input)` is typed from `inputSchema` with no cast, and the
  first-party lint against `ctx.config as X` (`scripts/check-module-casts.ts`)
  extends to `ToolContext`.
- `ToolContext` deliberately has no database handle and no `json` flag. A
  tool reads what its CLI operation reads, and its result is always
  structured.
- Schemas are zod 4, the major core and every first-party module depend on.
  The SDK turns them into the JSON Schema that `tools/list` reports. A
  schema from another zod major is a definition error (§3). Registration
  checks `schema._zod.def.type === "object"`.

### 2. Names

| Part | Rule | Why |
| --- | --- | --- |
| Module name (only when `tools` is declared) | `^[a-z][a-z0-9-]{0,30}$`, and not `brain` | No `_`, so the first `_` in a tool name always ends the module part. `brain` would produce core's namespace. |
| Local name | `^[a-z][a-z0-9_]{0,31}$` | Snake case, like core's inputs. |
| Canonical name | `<module>_<local>`, at most 64 characters | Composed by core, never by the module. |

- The character set is the intersection of what MCP recommends (letters,
  digits, `_`, `-`, `.`) and what the Claude API accepts for a tool name,
  which is `^[a-zA-Z0-9_-]{1,128}$` (verified against the API's tool
  definition reference on 2026-09-30). There is no `.`, and names are
  lowercase. A client prefixes MCP tools with its server key. Claude Code
  produces `mcp__brain__jobs_review`, so 64 leaves headroom under 128.
- **Collisions are impossible by construction and still checked.** Module
  names are unique at load (`if (seenNames.has(manifest.name))`,
  `packages/core/src/lib/module-loader.ts:104-107`), local names are keys of
  one record, and `brain` is reserved. Registration nevertheless checks
  every composed name against the names already registered, core's first,
  then modules in config order. On a duplicate it fails with
  `module tool "<name>" from module "<b>" collides with <core | module "<a>">`.
  That message is independent of anything but config order. The check runs
  before any tool is registered, because the SDK's own duplicate check
  throws mid-registration and would take the whole server down.

### 3. Validation: when, and what a failure costs

| When | What | On failure |
| --- | --- | --- |
| Load (every command) | The `tools` record: local-name regex, and the module-name rules of §2 when `tools` is non-empty; values are functions | A load error, the same as any invalid contribution (`const contributionSchema`, `packages/core/src/lib/module-loader.ts:25-81`). The CLI reports an invalid config. `brain mcp` starts in its existing degraded mode with no modules loaded (`const configWarning = configError`, `packages/core/src/mcp-server.ts:97-99`). |
| `brain mcp` start | Each import resolves. The definition parses: description, zod 4 object schemas, the annotation rules of §1. Canonical names do not collide. | **That module's tools, all of them, are not registered.** Nothing else changes. Core tools and other modules' tools are served. The failure goes to stderr and into the `warnings` of the core tools that return them, the channel the config warning already uses (`const toolWarnings`, `packages/core/src/mcp-server.ts:185-189`). A module never contributes half its tools. |
| `brain module lint <name>` | Everything `brain mcp` checks, plus §9 | A lint error, so the module's author sees it before a user does |

One module's bug does not take `brain_search` away from a voice client. That
is why a definition failure degrades per module and does not fail the
server. Static declaration errors stay load errors, because they are the
same class as a misspelled contribution key, and `brain validate` should
catch them.

### 4. Registration and discovery

- `brain mcp` (`export const mcpCommand`,
  `packages/core/src/cli/commands/mcp.ts:4-17`) registers core's eight tools
  first, then each loaded module's tools in config order, then each
  module's tools in the order its record declares them. `tools/list`
  therefore returns them in a stable order.
- Discovery is `tools/list` and nothing else. The server's `instructions`
  stay core's and do not list module tools. A tool's own description is
  what a client shows the model.
- **The set is fixed for the life of the server process.** The server never
  sends `notifications/tools/list_changed`. The SDK advertises the
  `listChanged` capability for any server that registers tools, and a
  client that never receives the notification behaves correctly. A config
  change takes effect in the next process, which for a chat backend is the
  next session.
- `brain module list --json` gains `tools: string[]` per enabled module,
  listing canonical names in registration order. This is additive.

### 5. Results and errors

- The handler parses nothing itself. The SDK validates input against the
  strict schema, and an invalid call becomes a tool error naming the field.
  The handler then calls `run(input, ctx)` with the **owning** module's
  config.
- A resolved value is returned as `structuredContent`, and also as the first
  `content` block in compact JSON, the convention core's tools follow since
  0.38.0. The SDK validates it against `outputSchema`. A mismatch is a tool
  error and never a malformed success.
- A thrown error becomes `{ isError: true, content: [{ type: "text", text:
  "Error: <message>" }] }`, the shape core's `errorResult` returns
  (`const errorResult`, `packages/core/src/mcp-server.ts:181-184`).
- A tool caps its own result size and states the cap in its description, as
  `brain_search` does with `limit`. Core adds no generic cap. The right
  bound depends on the operation, and a silent truncation would be worse
  than none.

### 6. Annotations and permissions

- Annotations are **hints to the client**, as MCP defines them. They are
  never the permission decision. `readOnlyHint` and `openWorldHint` have no
  default, so an author has to state both. A tool that writes also states
  `destructiveHint`.
- **No backend allows a module tool unless it names it.** The Claude backend
  auto-allows by exact name (`export const DEFAULT_ALLOWED_TOOLS`,
  `packages/ui-backend-claude/src/tool-policy.ts:26-79`). A module tool
  arrives as `mcp__brain__<module>_<local>`, so it raises an approval card
  in text chat and is denied in a voice turn. That is the fail-closed
  default. A brain owner can allow one through the existing profile
  `allowedTools`. No new mechanism is needed.
- **Admitting a tool to the voice posture is a change to
  [voice-permission.md](voice-permission.md) first.** That record's rule
  applies unchanged. A read-only tool over the owner's own data is the easy
  case. A mutating module tool needs the bounded-and-recoverable argument
  that `brain_add` and `brain_update` each carry there. None is in the first
  slice.
- **A mutating module tool must be serialized before any backend allows it.**
  The Claude backend's awaited hook covers every `mcp__brain__` name
  (`export const MUTATING_TOOL_MATCHER`,
  `packages/ui-backend-claude/src/tool-policy.ts:177`).
  Only the five core reads and `jobs_review` are exempt
  (`const BRAIN_READ_TOOLS`,
  `packages/ui-backend-claude/src/tool-policy.ts:181-188`).
  Every other brain tool takes the core document writers' brain lock
  (`export function lockKeyForTool`,
  `packages/ui-backend-claude/src/tool-policy.ts:235-256`).
  An approved call reacquires that same key after its approval wait. This
  serialization policy does not admit a tool or trust its own annotation.
- A tool is not an escape from containment. It resolves paths with
  `safeResolve`, as the module's commands already must. The contract's
  containment guarantee covers it.

### 7. Lifecycle: dormancy, stale handles, in-flight calls

The [instruction ownership and explicit migration record](module-instruction-ownership.md)
binds structured module contributions, separately owned generated regions and
reviewed migration before either toggle changes config, managed skill links or
instructions. Its preservation rules leave the MCP process lifecycle below intact.

This agrees with #527 as filed. #527 keeps a dormant module **loaded**: its
types stay valid, and `brain module list` shows it. Its workflow leaves the
context, and runtime unloading is out of scope, taking effect in the next
session. For tools:

| Situation | Behaviour |
| --- | --- |
| Module dormant when the server starts | Its tools are not registered and do not appear in `tools/list`. That is the point of dormancy: they cost no context. |
| A client calls a name this process did not register (a dormant module, a removed module, a handle cached from an earlier process) | The SDK's own tool error: an `isError` result whose text is `MCP error -32602: Tool <name> not found`, not a protocol error (see "Measured" below). This is deterministic, and it tells the model the tool is not available. The server does not guess whether the name belonged to a dormant module. |
| Module made dormant while a server is running | The running process keeps serving its tools until it exits. The CLI answers the dormancy message from the next command on, because each CLI command is a new process. Dormancy is a context control, not a permission boundary. It is documented as such and never presented as revocation. |
| A call in flight when the module changes state | It runs to completion. Nothing in core cancels it. |
| A client cancels a call | `ctx.signal` aborts. A tool that can stop early should. Whatever it already did stays done. The tool is not rolled back, and its description must not claim otherwise. |

**Measured** on 2026-09-30, against the SDK the lockfile pins (1.30.1), with a
real `Client` over an in-memory transport:

- An unregistered name returns `{ isError: true }` with the text
  `MCP error -32602: Tool jobs_review not found`.
- An unknown input key against a `.strict()` schema returns `isError`,
  naming the key.
- A result that violates `outputSchema` returns `isError`, naming the field.
- Registering a name twice throws `Tool stub_ping is already registered`
  from `registerTool`.
- A server that registers tools advertises `tools: { listChanged: true }`.

The §11 tests pin each of these, so an SDK upgrade that changes them fails
there first.

No additional lifecycle decision is needed before implementation. Dormancy
for tools is a filter at registration. It lands with, or after, #527's
state, and it needs nothing of its own.

### 8. Compatibility: who owes what

| Party | Obligation |
| --- | --- |
| Core | The declaration types, the naming rules, validation and failure behaviour (§2 to §3), result and error wrapping (§5), and lifecycle (§7). These are the module-authoring API. They are `@experimental` until 1.0, then stable under #537. The `brain_` namespace stays core's. |
| A first-party module | Each tool it documents is contract surface. The integration contract lists it, the pinned input-schema snapshot covers it, and it is versioned like a core tool. Additive changes ship in a minor. A break needs a ruling, the `breaking` label and a changeset, and from 1.0 a major. |
| A third-party module | The same policy, documented in its own package: the supported tool names, schemas and behaviour, and how the package versions them. The namespace keeps it from colliding with anything. It does not make the module's tools exempt. |

A module that stops shipping a documented tool is making a breaking change.

### 9. Lint and documentation checks

`brain module lint <name>` gains these checks
(`function moduleLint`, `packages/core/src/cli/commands/module.ts:104-154`):

- `tool-load`: every declared tool imports, and its definition passes §1
  and §3.
- `tool-name`: the module and local names satisfy §2. This duplicates the
  loader's check so that lint names the tool.
- `tool-annotations`: `readOnlyHint` and `openWorldHint` are present, and
  `destructiveHint` is present for a writing tool.
- `tool-schema`: both schemas are zod 4 strict objects, and every input has
  a description.
- `tool-docs`: the module's README has a `## MCP tools` section that names
  every declared tool. This mirrors how the contract doc names core's.

`docs/modules.md` documents the `tools` field and the authoring rules.
`docs/mcp.md` gets a module-tools section: naming, discovery, lifecycle.
The `new-module` skill asks whether any CLI operation needs a tool, and
applies the §2 name rule to the module's name before scaffolding.
`docs/integration-contract.md` states the shared policy once. Each
first-party tool gets a row.

### 10. The first tool: `jobs_review`

**The workflow it enables.** A brain owner has enabled `module-jobs` and uses
the hosted PWA by voice. The daily cron has already scraped and scored
(`cron: [{ name: "scrape"`, `packages/module-jobs/src/module.ts:76`). They
ask "anything new in my job queue above 70?". The voice turn calls
`mcp__brain__jobs_review` with `{ min_score: 70 }` and reads back titles,
companies and scores. The same call works from a desktop MCP client with no
shell.

**The operation it shares.** `brain jobs review --json` parses flags,
calls the shared `reviewJobs` operation, and prints `{ jobs }`
(`function cmdReview`, `packages/module-jobs/src/cli.ts:300-337`). The query
is `getReviewQueue` (`export function getReviewQueue`,
`packages/module-jobs/src/review.ts:12-49`). The exported operation
(`export function reviewJobs`,
`packages/module-jobs/src/review-operation.ts:19-40`) is called by both
surfaces. It takes typed options (`status`, `minScore`, `limit`, `source`), validates them, opens the
database, runs the query and closes the database. The CLI keeps its flags
and its `--json` envelope exactly. Two defects in the shared path get fixed
once, for both surfaces:

- The former query interpolated `limit` into SQL and the CLI passed
  `Number(...)` unchecked. The shared function requires a positive integer;
  the query now binds its limit as a parameter.
- The database helper creates by default (`export function openDatabase`,
  `packages/module-jobs/src/db.ts:94-104`).
  A read must not create `jobs.db`. The shared function returns an empty
  queue when the file does not exist and opens with `create: false`. Opening
  an existing database can still run the module's schema migration, as it
  does for the CLI today.

**Its shape.**

| | |
| --- | --- |
| Annotations | `readOnlyHint: true`, `openWorldHint: false` |
| Inputs | `status?`: one of `REVIEW_STATUSES` or `"all"`, default `"queued"` (`export const REVIEW_STATUSES`, `packages/module-jobs/src/types.ts:29-37`). `min_score?`: a number. `limit?`: an integer from 1, default 20, capped at 50. `source?`: one of `ALL_SOURCES`. |
| Result | `{ jobs: JobSummary[] }`, the same rows in the same order as `brain jobs review --json` for the same filters, each projected to the fields a spoken or chat answer uses: `id`, `title`, `company`, `location`, `remote_type`, `salary_raw`, `salary_min`, `salary_max`, `salary_currency`, `source`, `published_at`, `review_status`, `relevance_score`, `tags` (parsed to `string[]`), `url`. |

The projection is the one exception to "same envelope". A row carries the
listing's full `description` and `description_text`. Twenty of those are the
kind of payload that fills a voice turn's context and says nothing aloud.
The projection sits in `review.ts`, beside `formatJobSummary`, which already
chooses these fields for the human listing. It is shared code, not tool
logic. The contract documents these fields and no others.

### 11. Tests the implementation must carry

All of these are keyless and offline. Each runs against a temp brain with
local `./modules/<name>` fixture modules, the pattern `brain module list`'s
contract test already uses. Protocol behaviour is proven through the real
stdio server and an SDK `Client`, as `packages/core/tests/mcp-contract.test.ts`
does. A test of the declaration alone proves nothing about what a client
sees.

| Test | Mutation that must turn it red |
| --- | --- |
| Two fixture modules' tools appear in `tools/list` with their composed names, annotations and JSON schemas, after core's eight, in config order | Register modules before core, or drop the module prefix |
| Each tool receives its own module's config (two modules, each tool echoing `ctx.config`) | Pass the first module's config to every tool |
| A module named `brain`, a module name with `_`, and an invalid local name each fail load with the §2 message | Delete the reserved-name check. Loosen the regex. |
| A composed name that collides with a registered one fails with the §2 message, driven through the real registration function against a real `McpServer` | Remove the pre-check. The SDK's throw then surfaces with a different message. |
| A module whose tool definition is invalid (no `outputSchema`) contributes no tools. Another module's tools and core's still list and run, and the warning is present. | Let the definition error propagate, so the server fails to start |
| A tool returning a result that violates its `outputSchema` yields `isError` | Register without `outputSchema` |
| An unknown input key yields `isError` | Make the input schema non-strict |
| Calling a name this process did not register yields `isError` with `Tool <name> not found` | (pins SDK behaviour across an SDK upgrade) |
| A dormant fixture module's tools are absent from `tools/list`, and a call yields `isError`; its CLI word still answers the dormancy message | Remove the dormancy filter at registration |
| `jobs_review` and `brain jobs review --json` return the same ids in the same order for the same filters, on a seeded fixture `jobs.db`, and each tool entry equals the projection of the CLI row | Change the tool's default `status`, or its ordering |
| `jobs_review` against a brain with no `jobs.db` returns `{ jobs: [] }` and creates no file | Restore `{ create: true }` on the read path |
| `jobs_review`'s input schema matches the pinned snapshot | Rename an input |

The PR for each task records the mutation it ran and the assertion that
failed.

## Deliberately left open

- **The pi backend.** It does not use `brain mcp`. It builds its brain tools
  in-process with its own names (`export const TOOL_RISK`,
  `packages/ui-backend-pi/src/tools.ts:212`), and it keeps `bash`, so
  `brain jobs review` is reachable there already. Serving module tools on pi
  would need collision rules against pi's flat namespace (`read_file`,
  `ask_user` and `web_search` all parse as `<module>_<local>`). It needs its
  own case.
- **A second first-party tool.** `finance_report`, the AR report from a
  shell-less client, is the next candidate. The desktop-client evidence for
  it is thin. It does not ride on this ruling, and it needs its own issue
  with a use case.
- **Mutating module tools in voice.** Nothing is ruled beyond §6: each one
  would need its own row in voice-permission.md.
- **Dynamic tool lists.** A running server that adds or removes tools would
  need a config source the process can re-read. #528's per-module JSON
  settings might become one. Until someone needs it, §7 stands.
