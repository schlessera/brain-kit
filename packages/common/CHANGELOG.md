# @schlessera/brain-common

## 0.44.0

### Minor Changes

- 800d965: Keep the committed generated-text caches in their own `.brain-cache/` directory: `.context-cache.jsonl` becomes `.brain-cache/contexts.jsonl` and `.asset-cache.jsonl` becomes `.brain-cache/assets.jsonl`. Breaking before 1.0, ruled in #2692 (option B, delivered in #2725): the location of committed files changes. The line format and every CLI, MCP and HTTP shape are unchanged. An existing clone keeps every cached context and asset description: reads count the old root-level files, and the next index run (or `brain doctor --fix`, new check `legacy-caches`) moves every line into the new file and deletes the old one. The move is idempotent and keeps union-merged lines, and `brain sync` treats the old names as derived caches, so a merge with a clone that still writes them keeps both sides. The template ships the empty caches in `.brain-cache/` with `merge=union` for the new paths, and `brain doctor --fix` adds those lines to an existing brain. While a governance policy names provider folders, every governed writer retains `.brain-cache/` beside `.brain-index/`, a hosted or autonomous turn that masks any provider folder sees it as an empty read-only folder, and a turn allowed every provider folder sees the real caches. A root-level cache from an earlier release keeps its file mask on every turn under a provider rule. ui-server starts one index run at boot when such a file is present.
- bde209b: Keep the disposable search index in its own `.brain-index/` directory: `brain.db`, its SQLite sidecars and the embedding lock move from the brain root to `.brain-index/brain.db`. Breaking before 1.0, ruled in #1668 (option B): a direct SQL reader opens the new path. The schema and every CLI, MCP and HTTP shape are unchanged. An existing brain migrates by rebuilding, never by moving: the first writable command creates the directory and `brain index` fills it. The old root-level files are ignored; `brain doctor` reports them as `legacy-index` and `--fix` deletes them. ui-server now requires a content CLI of at least 0.44.0, deletes the old root-level index at boot and starts one index run. While a governance policy names provider folders, every governed writer retains `.brain-index/` like a provider folder, and publication refuses to remove or replace it.
- ff70ec1: Apply governance provider selectors to core embedding eligibility, reconcile forbidden vectors while keeping keyword content, and distinguish proven built-in Google transport identity from model and cost labels. Treat linked or unreadable source paths as unproven rather than allowing an unrestricted alias to authorize a request. Keep matching content local when an enrichment route is unknown and warn about affected turns losing Git history. This does not enable inference-worker routing or history isolation.
- 69151ca: The `brain` CLI's paid providers work again in governed and strict turn workers, through a metered host relay, and the worker still holds no provider key (#1673). On a host with managed native storage, each such turn gets a relay beside its egress proxy. Gemini embeddings, Gemini completions without video, Anthropic completions, and OpenAI and Gemini images send their native requests to it. The server adds the key, records each request's usage on the turn, counts it toward the turn, conversation and day budgets, and refuses the next request with `budget_exceeded` once a budget is blocked. Nothing is reserved, so requests already in flight can take a budget slightly past its stop. `brain search` uses its vectors again instead of falling back to keyword results. The relay refuses streamed requests, caps how many requests and request bytes it holds at once, and replaces any copy of the key in a response with `[redacted]`. `brain video watch` and the `jev` reranker are not relayed and still report `provider_unavailable`.

  A relayed Claude API-key turn no longer breaks `anthropic-haiku`. The CLI used to send the turn's inference placeholder and fail authentication; it now reaches the host's `ANTHROPIC_API_KEY` through the relay.

  Credentialed maintenance (search from the UI, cron jobs, module actions) on those hosts also runs without `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or the brain's `.env*`, and uses its own relay. A run started from a turn's tool is charged to that turn; any other run counts toward the UTC day. Keys the relay does not carry, such as `TYPESAFE_API_KEY`, stay as before. Hosts without managed native storage are unchanged, and worker-host status says so.

  The budget receipt's `coverage` now reads "Built-in inference and relayed brain CLI providers; other provider and tool spend is not metered". Receipts stored earlier keep the old text, and the schema accepts both. Gemini embeddings are priced at Google's list price per input modality. Image requests stay unpriced, and their reported tokens count toward the unpriced-token stops.

  **Migration:** the relay sends a key only to its own first-party origin. If you point a built-in provider at a custom endpoint (`GOOGLE_GEMINI_BASE_URL`, `GEMINI_BASE_URL`, `OPENAI_BASE_URL`), or use a custom `apiKeyEnv`, list that key and exact origin in the new `BRAIN_UI_CLI_PROVIDER_ORIGINS`, for example `GEMINI_API_KEY=https://gateway.ithaca.invalid`. Until you do, the relay refuses those requests. Keys must be in the server's environment; a key kept only in the brain's `.env` no longer reaches relayed maintenance. A governed turn with an `allowlist` egress policy needs the provider's host on that allowlist.

### Patch Changes

- 04a6595: Refuse unsupported frontmatter languages before parser engine dispatch in data-only governance, skills, schedules and content workflows. Preserve supported YAML, jobs' legacy JSON scoring input, policy last-valid fallback, approval checks, cache independence and travel's custom YAML date parser.
- 066107c: Put the brain's installed CLI first on governed and strict interactive workers' PATH, matching maintenance workers, and explain installation in the sandbox note when it is missing. Restricted autonomous environments retain their fixed PATH.
- 1faf79c: Governed and strict turn workers no longer receive the `brain` CLI's provider keys (#1666). A worker keeps only its own inference credential where the host does not relay it, plus any name an operator admits through `BRAIN_UI_SUBPROCESS_ENV_EXTRA`. `GEMINI_API_KEY`, `OPENAI_API_KEY`, `TYPESAFE_API_KEY` and the other provider credentials stay on the host. The brain's `.env*` files were already unreadable in these workers, and now there is a test for that.

  A `brain` command that needs a withheld key names the provider and the key, and falls back where it can. `brain search` returns keyword results, `brain index --embeddings` builds a keyword index, and an enabled `jev` reranker keeps lifecycle order. `brain process`, `brain image` and `brain video watch` refuse, because the built-in providers' own missing-key errors name a withheld key too. Each notice ends in a `[provider_unavailable …]` token. The worker learns which keys it lacks from the new `BRAIN_WITHHELD_KEYS` variable, which holds names only. The server records each token in a tool's result as a `provider_unavailable` governance event, at most 20 per turn. The capabilities note now says that secrets are hidden and names the keys a worker keeps.

  To keep the old behaviour for a key until the metered relays land (#1673), admit it explicitly with `BRAIN_UI_SUBPROCESS_ENV_EXTRA`. Outside a worker, a brain without keys behaves as before.

## 0.43.1

## 0.43.0

## 0.42.1

## 0.42.0

### Minor Changes

- 52cbd1d: Enforce admitted command deny and confirmation policies in both interactive adapters, recheck approved edits, and retain attributed rule receipts after Activity detail pruning.
- 8b4fbdc: Give each hosted worker a private, filesystem-limited turn-temp tmpfs,
  defaulting to 256 MiB, with whole-lifetime aggregate admission shared by both
  backends. Keep XDG writes inside it and real HOME read-only; retain a directory
  descriptor so linked deliverables can still be promoted after exit.

  Add the `turn_temp` tool for usage and scoped purge, preserving output-linked
  files unless named paths explicitly force their removal. Record purge governance
  events and explain the allowance, 80% warning and out-of-space recovery in the
  sandbox note. Add host overrides `BRAIN_UI_TURN_TEMP_BYTES` and
  `BRAIN_UI_TURN_TEMP_BUDGET_BYTES`; unavailable capacity refuses as
  `worker_state_busy` with Retry.

- f5433b3: Require existing per-use approval for visible outward commands in interactive turns, preserve force-push and voice refusals, and retain irreversible admission receipts in the turn journal. Explicitly disclose opaque HTTPS-script and unavailable outward MCP descriptor coverage.
- 185803c: Read a strict, versioned governance policy as host data, with a read-only
  `brain policy check --json` command, content-index exclusion, last-valid
  fallback, immutable per-turn identity and interactive/voice profile and
  protected-path selection. Autonomous authority and sibling enforcement remain
  unchanged. Approved budget and scope defaults resolve without enforcing them.
  Authoritative agent Markdown and submitted PNG applications share admitted
  protection, including planned destinations and protected scratch retention.

  The CLI and server share the data-only policy reader through the internal common
  package, preserving server imports and declarations without the optional core peer.

### Patch Changes

- 1283ca4: The note a hosted agent reads before its turn is shorter and states its rules directly (#1654). It opens with the turn's profile (`strict`: the brain is read-only, change it through `write_file`, `edit_file` and the curated tools), lists turn temp, the persistent areas and the brain, and ends with the link rule: anything the reader should open goes in `.brain/scratch/` and is linked from there. Each area is named by the path the worker was actually given. Both backends inject the same text. When a `brain` CLI write hits the read-only brain, the refusal now repeats the note's rule word for word; the `read_only_brain` code and its `tool` field are unchanged.

## 0.41.0

### Minor Changes

- 1caadca: Add `@schlessera/brain-common`, an internal-only package with no compatibility promise. Its `./internal/env` entry holds the environment descriptor core and `./internal/frontmatter` holds the cache-free `parseFrontmatter`. The packages that carried byte-identical copies of these files now depend on it instead. Environment and frontmatter parsing behave exactly as before, and every public export is unchanged. module-finance, module-jobs, module-travel and ui-server no longer depend on `gray-matter` directly.
