# One Odysseus example world

**Maintainer decision, 2026-09-30:** Odysseus is the sole example corpus for
brain-kit. The [ruling on the launch epic](https://github.com/schlessera/brain-kit/issues/608#issuecomment-5909881946)
and [migration scope](https://github.com/schlessera/brain-kit/issues/625)
include core integration fixtures, CLI and MCP demonstrations, documentation,
skills, onboarding transcripts, renderer examples, measurement harnesses,
Storybook, screenshots and public website demos.

## The world and its facts

Use D19's established cast and tone: **ancient problems, modern organisational
tools**. Odysseus has a smartphone; his problems remain mythologically grounded.
No invented startup, modern biography or additional example persona.

The [UI fixture guide](../../packages/ui-kit/fixtures/README.md) defines the
cast and chronology. The reference date remains `2026-07-12`: Troy fell ten
years earlier, Calypso has kept Odysseus on Ogygia for seven years, and the
seventeen-day passage ends July 29. Penelope holds Ithaca; Telemachus seeks
news in Sparta. The crew ledger counts 600 men in 12 ships from Troy and no
survivors of the crew after Thrinacia. Odysseus is the single survivor.

Fictional addresses use reserved domains and number ranges. Personal content,
real deployment captures and infrastructure remain forbidden. The whole-tree
leakage gate keeps its existing scope and patterns.

## Separate representations serve different tests

This explicitly supersedes **D18's separate-persona and no-shared-content
restrictions** and **D19's restriction to UI/presentation surfaces** in
[the design-kit record](design-kit/fixtures.md#2026-09-15--d19-the-fixture-world-is-the-odyssey-maintainers-choice).
Their reasons for separating invariant-focused fixtures from presentation
fixtures still apply. One world does not mean one generic fixture framework.

The [core corpus](../../packages/core/fixtures/README.md) keeps its compact
25-document shape, engineered links and gaps, aliases, fixed dates, audit
findings and retrieval query classes. The UI fixtures keep their presentation
shapes and closed link graph. Core runtime code does not depend on a UI
package. A path may differ between representations when it serves a technical
scenario; it still describes the same world.

A dated planning observation need not equal a later presentation snapshot.
The core focus document records July 5 preparations; the UI stages the morning
of July 12 after the four-day raft build. Intentional negative cases, such as
the long bio's wrong year for the fall of Troy, remain clearly marked and audited. They
are never a second canonical account.

## Historical evidence remains accurate

Keep dated measurements, transcripts and changelog entries as the evidence
that was actually collected. Mark superseded corpus assumptions beside the
relevant passage; never rename an old measurement into an Odysseus run.
Future measurement harnesses and public captures use this world. A new
measurement needs its own provenance; a fixture migration authorizes no paid
rerun or publication.

A new user's template remains empty and onboarding remains individualised.
Odysseus demonstrates the product; the product does not impose his taxonomy
or populate a user's brain with his notes.
