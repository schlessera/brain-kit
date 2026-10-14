# @schlessera/brain-common

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
