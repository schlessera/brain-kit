---
"@schlessera/brain": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
---

Custom user skills, managed from the frontend.

- **Settings → Skills** (new tab): create, edit, enable/disable, and remove
  your own skills, plus a read-only view of the built-ins. Custom skills are
  REAL directories in the brain repo's `.agents/skills/` — the local layer
  `brain skills sync` already treats as canonical and never touches — so
  they persist across deployments, ride the repo's git backups, override
  same-named built-ins, and reach every backend (Claude, pi, codex, gemini).
  Disable moves the directory to `.agents/skills-disabled/`, taking the
  skill out of every agent's discovery at once.
- **`/api/skills`** CRUD (auth-guarded): strict name validation, frontmatter
  validation (name must match the directory, description required), size
  caps, and symlink-safe mutations (package skills can never be edited or
  deleted through this surface). Every mutation runs `brain skills sync` so
  the change reaches the next turn/session without a restart; a failed sync
  degrades to a response warning.
- **Install from ZIP or GitHub**: upload a .zip, or point at a repository
  (`owner/repo`, a github.com URL, or a `/tree/<ref>/<path>` URL —
  private repos via the server's `GITHUB_TOKEN`). Any folder containing a
  SKILL.md installs as a skill, one source may carry several; the installed
  name comes from the frontmatter, zip-slip is rejected outright, archives
  are size/count-capped, installs are staged-then-swapped, conflicts are
  skipped unless overwrite is chosen, and built-ins can never be replaced.
- **New core skill `add-skill`**: interactive, brain-kit-optimized skill
  authoring — interviews for the workflow and triggers, enforces the
  backend-portable subset (no agent-specific frontmatter or tool names,
  `brain` CLI / bun scripts for portability), writes into
  `.agents/skills/`, runs sync + lint, and hands off to Settings → Skills.
