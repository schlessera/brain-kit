# @brainform/module-speaking

A brainform module for the speaking lifecycle: researching conferences, developing
talk ideas, submitting to CFPs, tracking outcomes, preparing talks, planning
travel, and wrapping up after a conference.

This module is **content + skills only** — it contributes taxonomy, classifier
hints, index-sync rules, and eight skills. It ships no CLI command and no
database.

## Contributed document types

| Type         | Directory      | What lives there                                        |
|--------------|----------------|---------------------------------------------------------|
| `talk`       | `talks/`       | Talk registry entries + prep materials (`talks/{slug}/`) |
| `conference` | `conferences/` | Per-conference dirs (`conferences/{name}-{year}/`)       |
| `travel`     | `travel/`      | Per-trip dirs (`travel/{trip-slug}/`)                    |

The directories above are the module's **static defaults**. A default-exported
manifest cannot read user config, so if you relocate one of these, also override
the type in your `brain.config` `taxonomy.types` so path inference stays correct.

## Classifier hints

Keyword/phrase heuristics used to guess a document's type during capture:

- **conference**: `cfp`, `call for papers`, `keynote`, `conference`, `submission deadline`, `speaker slot`
- **travel**: `itinerary`, `flight`, `hotel booking`, `accommodation`, `road trip`, `check-in`, `train to`

Personal venue vocabulary (a conference series you attend every year, a home
airport, etc.) is intentionally **not** here — put those in your own
`brain.config` `taxonomy.classifierHints` so they layer on top.

## Index-sync rules

Contributes directory anchors so a wiki-link to a conference/talk/trip directory
resolves to the right file:

- `dirAnchors`: `status.md`, `itinerary.md`, `outline.md` (in addition to the core `_index.md`)

## Excluded path segments

Slide-deck working directories are excluded from indexing (drafts and alternate
cuts are noise for search):

- `exclude.segments`: `alt-decks`, `versions`, `deck`

## Skills

| Skill                  | Purpose                                                                        |
|------------------------|--------------------------------------------------------------------------------|
| `conference-research`  | Research a conference's CFP, past themes, audience, and differentiation angles. |
| `talk-ideas`           | One-shot generation of 3-5 talk concepts mapped to a conference.                |
| `brainstorm-talks`     | Interactive, iterative development of talk concepts.                            |
| `new-submission`       | Build a CFP submission (bio, abstract, takeaways) and start status tracking.    |
| `submission-outcome`   | Record an accept/reject/waitlist decision and sync every tracking layer.        |
| `talk-prep`            | Generate description, outline, audience analysis, and speaking notes.           |
| `plan-travel`          | Plan a trip with per-traveler requirements, index sync, and conference links.   |
| `conference-aftermath` | Write a retrospective, record the delivery, and archive the conference + trip.  |

### Genericization notes

- **plan-travel** reads the travel party from the `travelParty` config below
  rather than hardcoding names, and builds a per-member requirements checklist
  from each member's optional `requirementsDoc`.
- **conference-aftermath** ends in a **pluggable** publishing handoff: if you've
  configured a content/publishing workflow (e.g. a personal overlay skill), it
  hands the reflection off; otherwise it writes a plain retrospective note in the
  conference directory. No platform is baked in.

## Config schema

```ts
// modules["@brainform/module-speaking"]
{
  travelParty?: Array<{
    name: string;
    role?: string;            // e.g. "partner", "assistance-dog", "child"
    requirementsDoc?: string; // path (relative to brain root) to that member's needs
  }>;                         // default: []
}
```

Example:

```ts
"@brainform/module-speaking": {
  travelParty: [
    { name: "Alex Example", role: "partner" },
    { name: "Rover", role: "assistance-dog", requirementsDoc: "me/family/rover.md" },
  ],
}
```

## Scope note

Travel lives **inside** the speaking module for v1. A standalone travel module is
a post-v1 open item.
