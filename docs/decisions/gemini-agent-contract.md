# Gemini receives the installed agent contract

The maintainer's [2026-09-30 ruling on #439](https://github.com/schlessera/brain-kit/issues/439#issuecomment-5906585118)
chooses an embedded managed block in `GEMINI.md`. The installed
`packages/core/CONTRACT.md` remains the single authored source. The Gemini
emitter uses the same body renderer and marker editor as Codex, without
changing the `SkillEmitter` seam or the contract's rules.

## Discovery and instruction context have different jobs

Gemini CLI's [skill documentation](https://geminicli.com/docs/cli/skills/),
checked on 2026-09-30, describes native workspace discovery in `.agents/skills/`
as well as `.gemini/skills/`. Enabled skill names and descriptions are available
at startup, and a skill body loads when activated. Restating those names and
descriptions in a generated Skills index spends instruction context on
information the agent already discovers.

The old emitter gave Gemini that index but omitted the brain's contract.
Skill discovery does not convey that Markdown is authoritative, `brain.db` is
disposable, or how frontmatter and wiki-links work. Gemini's
[context documentation](https://geminicli.com/docs/cli/gemini-md/), checked on
the same date, says workspace `GEMINI.md` files load as instruction context.
The emitter puts the installed contract there, including with zero skills.

## Why embed the body

Gemini supports `@` imports, so importing the installed contract was an
available alternative. The ruling selects embedding instead: the instruction
file contains its contract directly, uses Codex's existing rendering behavior,
and is refreshed by `brain skills sync` after package upgrades. Loading the
generated copy does not depend on resolving an import into an installed
package. No second contract is authored in the emitter or the repository.

The shared `renderContractBlock` normalizes only whitespace surrounding the
installed body (`renderContractBlock`,
`packages/core/src/lib/skills/emitters/contract-block.ts:12-21`). The installed
file has the same relative location from source and built emitters
(`CONTRACT_FILE`, `packages/core/src/lib/skills/emitters/contract-block.ts:9-9`).
Changing the installed body changes the next generated block; an identical
result causes no write.

## Migration keeps the user's bytes

The Gemini emitter accepts exactly one ordered start/end pair for each known
block. Missing, repeated, reversed or overlapping markers are ambiguous:
guessing a span can delete the user's prose. It leaves the whole file
unchanged and warns to repair markers by hand. A failed installed-contract
read also preserves the file and reports how to retry (`geminiEmitter`,
`packages/core/src/lib/skills/emitters/gemini.ts:17-65`).

A clean old Skills index is replaced in place. If a contract block already
exists, it is refreshed and a separate old index span is removed. Prefix,
suffix and intervening text remain byte-identical, including CRLF line endings,
trailing spaces and the absence of a final newline. With no existing span,
the contract is appended without trimming the user's text. This migration
does not inspect or delete `.codex/prompts/`; Codex owns that cleanup.

## What the evidence establishes

Keyless tests emit real files, refresh an isolated installed contract, reject
ambiguous markers, preserve surrounding bytes and repeat syncs on a read-only
file to prove that an unchanged result causes no write. Independent mutations
that remove the contract body or overwrite the user's prefix fail on those
specific content and preservation assertions. Codex's contract and migration
tests continue to exercise the shared helper.

These tests establish emitter behavior and installed-file resolution. The
upstream documentation establishes the supported discovery and default
instruction path. Neither constitutes evidence that a live Gemini session
loaded a particular file. A custom global context filename, Gemini manual-only
policy and changes to other agents remain outside this decision.
