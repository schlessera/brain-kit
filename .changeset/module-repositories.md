---
"@schlessera/brain": minor
"@schlessera/brain-ui-server": minor
---
A module's cron job can now read another repository, including a private one (#3380). The module's config block lists the repositories it needs with the new core-owned `repositories` key, and `brain module list --json` reports them. The host fetches a listed repository only when the operator's new `BRAIN_UI_MODULE_REPOSITORIES` allow-list names it too, so an edit to `brain.config.ts` alone cannot widen access. The host fetches with the sync transport's credential into a private mirror. The job's worker reads that mirror through a Git URL rewrite, so a plain `git clone <url>` works there, and the worker never holds the credential. A job whose module asks for a repository the operator has not allowed fails before it starts, with an error that names the repository and the setting.
