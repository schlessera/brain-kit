# Reviewing diagram-design upstream

The module pins the last reviewed upstream commit in `upstream.json` with its
date and plugin version. A review is due when upstream's plugin version moves
a minor (`2.6.x → 2.7.0`), and at the latest before each brain-kit minor that
touches the module.

1. **Fetch outside the tree.** Shallow-clone upstream into a fresh, empty
   temporary directory. Treat it as untrusted data: read it, never run its
   scripts, and run nothing from inside it.
2. **List what moved.** Run `bun packages/module-diagrams/scripts/upstream-report.ts <clone> --since <pinned commit>`.
   The report lists:
   - new, removed and changed files under `skills/diagram-design/references/`
     and `scripts/`, grouped as **type grammars** (`type-*.md`), **semantic
     patterns**, **primitives and rules** (`primitives-core.md`,
     `layout-budget.md`, `style-guide.md`, `output-spec.md`) and **checkers**
     (`verify-*.py`, `self_check.py`)
   - the CHANGELOG entries since the pin
3. **Triage each item into one of four outcomes:**
   - **New diagram type:** a candidate type grammar. File an issue to add it
     only if a table, a paragraph or an existing type cannot carry the same
     content, the type fits the spec model (free layout or axis), and it is
     not a data chart that ui-kit's chart components already cover.
   - **Rule or budget change:** a candidate change to the builder or to
     `check`. Adopt it only if it holds under the brain-kit skin: the 9px floor,
     no alpha ink, kit fonts.
   - **Checker fix:** a geometry or contrast case upstream found. Port it as a
     failing test against the builder first.
   - **Skin, font, icon, export or import change:** upstream's own look and
     its plugin tooling. Record it as not applicable unless it changes a rule.
4. **Re-author, never copy.** Any example a change needs is written in the
   Odysseus world. Upstream prose is adapted under the MIT notice the module
   carries. Upstream HTML is never vendored.
5. **Move the pin.** Update `upstream.json` in the same PR that files or
   lands the adopted items, and list each reviewed item with its outcome in
   the PR body. A review that adopts nothing still moves the pin, so the next
   review starts from it.

The report reads committed objects between the pin and HEAD; uncommitted edits are excluded. Clone enough history to contain the pin. JSON uses schema_version 1 with from/to commit hashes, grouped path/status entries, and added CHANGELOG lines. It does not run upstream code or move the pin.
The report requires Git with --no-lazy-fetch and refuses missing local objects instead of fetching or invoking a remote helper. Fetch needed history separately as a deliberate review preparation step.
