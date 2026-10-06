---
"@schlessera/brain-ui-kit": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-react": minor
---

`show_block` gains a `tracker` block (#1001): issues and pull requests the agent opened, closed, reopened, merged, labeled, commented on or reviewed, as `{ kind: "tracker", events: [{ url, action, qualifier?, title }] }` with 1-20 events.

- **ui-kit:** `TrackerPillList` draws each event as one tappable line, `action [qualifier] · number · title ↗`, under run headers that name the host and repository. Repository, number and type are derived from a GitHub-shaped `url`; any other address shows only its title, action and host. Long titles truncate instead of wrapping, a refused address draws a withheld line with no anchor, more than six events collapse to five behind `Show all N changes` (a shared image or PDF draws them all, titles in full), and the list always says the changes are as reported by the brain.
- **ui-sdk:** the schema rejects an event carrying any key besides its four, so a payload cannot state a repository, number or type, and the handler rejects an event whose address the link policy refuses, naming its position and the reason. The `show_block` description tells the model to use `tracker` instead of listing tracker changes in prose; the per-turn brief is unchanged.
- **ui-react:** the block renderer draws `tracker` blocks.
