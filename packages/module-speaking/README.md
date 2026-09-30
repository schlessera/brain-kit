# @schlessera/brain-module-speaking

Requires Bun ≥ 1.3.5. A brain-kit module for researching conferences,
developing talk ideas, submitting to CFPs, tracking outcomes, preparing talks
and wrapping up afterward. It contributes content and seven skills.

## Types and index rules

| Type | Default directory |
| --- | --- |
| `talk` | `talks/` |
| `conference` | `conferences/` |

User `taxonomy.types` overrides can retain custom directories. Conference
classifier hints include `cfp`, `call for papers`, `keynote`, `conference`,
`submission deadline` and `speaker slot`; add personal vocabulary in your
own configuration.

The shared directory anchors `status.md`, `itinerary.md`, `outline.md` remain
available, preserving existing speaking links. Slide-deck working segments
`alt-decks`, `versions`, `deck` remain excluded from indexing.

## Skills

| Skill | Purpose |
| --- | --- |
| `conference-research` | Research a conference's CFP, past themes and audience. |
| `talk-ideas` | Generate talk concepts for a conference. |
| `brainstorm-talks` | Develop concepts in dialogue. |
| `new-submission` | Build a CFP submission and start tracking it. |
| `submission-outcome` | Record the outcome and sync tracking layers. |
| `talk-prep` | Prepare the description, outline and speaking notes. |
| `conference-aftermath` | Write a retrospective and close the conference. |

`submission-outcome` links to the travel module's `plan-travel` capability.
Conference hubs keep their existing journey links. `conference-aftermath`
can close a linked completed journey with the ordinary archive command.
Its publishing handoff still uses your configured content workflow, or a
plain retrospective note when none is configured.

## Configuration and travel upgrade

Enable speaking with an empty block:

```ts
modules: { "@schlessera/brain-module-speaking": {} }
```

Travel taxonomy, `plan-travel` and `travelParty` now belong to
[`@schlessera/brain-module-travel`](../module-travel/README.md). Speaking
retains `talk` and `conference`. This is an approved pre-1.0 breaking
ownership change: existing travel paths, types and links remain intact,
but travel must be enabled explicitly after upgrading.

Install and enable the matching travel package, then run
`brain travel migrate --dry-run --json` and `brain travel migrate --json`.
Review the config edit, restart the session and sync skills. The deprecated
speaking `travelParty` field remains accepted during the transition and is
retained until migrated; a nonempty legacy value produces an actionable warning.
The migration preserves every member, role and requirements-document path,
refuses conflicting or ambiguous values, and is a no-op after completion.
See the travel README for complete JSON/TypeScript and saved-settings handling.
