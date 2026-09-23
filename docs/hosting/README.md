# Hosting

You do not have to host anything. A brain is a git repo you operate from a
coding agent on your own machine — that is the whole product. Hosting adds two
optional things: an off-machine **backup** (a private git remote) and a
self-hosted **chat UI** you can reach from your phone. This page is the honest
overview of both.

## What you generate, and what you run

> **The hosting template is not published yet.** Everything below describes what
> self-hosting will look like and what the deployment does; the repository you
> generate it from, `schlessera/brain-hosting-template`, is not available. The
> backup half of this page needs nothing but git and works today.

The chat UI is a Progressive Web App that drives a coding agent over your brain.
Nothing in this repository runs it: what you run is a **deployment shell** you
generate for yourself — a Dockerfile, a compose file, a bin entry, your own
branding — wrapped around the `@schlessera/brain-ui-server` and
`@schlessera/brain-ui-react` packages published from this monorepo.

That split is the point. Every line of app behaviour lives here and ships as an
npm package; the shell holds only what is true of *your* machine, and it takes
upgrades by bumping a dependency. It versions independently against the
[integration contract](../integration-contract.md), so a shell generated once
keeps working as the packages move.

Running it means running an agent that can execute Bash in a container that
holds your data and your API tokens. That is powerful and it is a real attack
surface — which is why auth is mandatory (below) and why the content repo must
stay private.

## The brain CLI your content repo pins

**The server refuses to boot against `@schlessera/brain` older than 0.33.0.**
This is not an upgrade note for one release; it is a standing floor, enforced at
`MIN_BRAIN_CLI_VERSION` (`packages/ui-server/src/brain/client.ts:58`). The server
places `--` before user-controlled CLI positionals, and a core below 0.33.0 eats
that separator — every search then silently returns nothing, which is why the
version is checked at startup instead.

The pin lives in your **content** repo's `package.json` and lockfile, not in the
deployment. Two consequences people meet the hard way:

- Bump the pin and refresh the lockfile **before** you deploy, not after. The
  symptom of skipping it is a container that will not start.
- Rolling the image back does not roll the pin back. They are two separate
  actions, and leaving a newer compatible core pinned is safe.

## Subprocess environment allowlist (0.33.1+)

Agent and scheduled-job subprocesses receive a per-audience allowlist rather
than the server's whole environment. If an agent or scheduled job suddenly
cannot authenticate after upgrading, the credential probably uses a custom
environment-variable name that the shipped allowlist does not know. Set
`BRAIN_UI_SUBPROCESS_ENV_EXTRA` to a comma-separated list of the missing names
(for example, `BRAIN_UI_SUBPROCESS_ENV_EXTRA=ACME_API_TOKEN,HTTPS_PROXY`) and
recreate the container. Whitespace is trimmed and malformed or empty entries
are ignored.

Only add variables the child genuinely needs: every listed name is exposed to
all subprocess audiences. `BRAIN_UI_SUBPROCESS_ENV_EXTRA` itself is control
configuration and is never forwarded to the spawned command.

The shipped allowlist includes the core CLI's `BRAIN_ROOT`,
`BRAIN_RERANK_MODE`, and `XDG_BIN_HOME` settings; the jobs module's
`SCRAPE_CHROME_URL`, `CHROME_CDP_URL`, `SCRAPE_CHROME_PATH`,
`SCRAPE_CHROME_NO_SANDBOX`, `SCRAPE_USER_AGENT`, and
`SCRAPE_RESPECT_ROBOTS` settings; and the images module's `OPENAI_BASE_URL`
and `GEMINI_BASE_URL`. These capability settings are available to agents,
direct brain CLI children, and scheduled jobs.

## Recovery and partial availability

The UI server permits one HTTP sync at a time per canonical brain root.
Concurrent requests receive HTTP 409 with a busy message. Closing the stream
leaves the sync running and the reservation in place until the child exits.
This reservation is local to the server process; external CLI/cron invocations
are not coordinated by it.

Cron output-forwarding failures do not change the child's exit status. The
wrapper continues draining output and waits for exit before recording the
outcome, and closes tracking resources even if recording fails.


The session drawer keeps available histories when another backend fails or
exceeds its three-second listing deadline. It shows a warning and a Retry
button; a failed refresh preserves sessions already loaded. The HTTP session
list includes an optional `unavailableBackends` array of backend IDs when
results are incomplete.

Notification detection persists its cursor with inbox entries in the UI
SQLite database. After restart it replays retained activity changes in batches,
including failures recorded while the server was offline. Existing notifications
are deduplicated, including acknowledged entries. Keep the UI database on its
persisted volume to retain this progress.

Share cleanup refuses staging paths that traverse symlinks, including links to
other directories inside the brain. Accessing the brain root itself through a
symlink is supported.

## The `/brain-host` skill

`/brain-host` is the conversational way to set this up. It interviews you for
intent — (a) private GitHub backup only, (b) a VPS with public HTTPS, (c) a
home/Tailscale-only server, (d) fly.io, or (e) nothing — then automates the safe
parts and generates a copy-paste runbook for the rest:

- Creates the private GitHub repo (`gh repo create --private`), pushes, and
  verifies the remote is not public.
- Writes the `.env` for the compose stack from your answers (auth mode, domain,
  tokens, timezone) and generates a password hash.
- For a VPS, produces a provision → DNS → `docker compose up` → healthcheck
  runbook, and can drive it over SSH with your consent.
- Validates the result: a health check, a login check, and one chat round-trip.

## Auth modes

The server **fails closed**: it never ships a default that exposes a
write-capable agent without authentication.

| Mode        | What it is                                                                                   | Use when                              |
| ----------- | -------------------------------------------------------------------------------------------- | ------------------------------------- |
| `password`  | **Default for public exposure.** Hashed password, signed HttpOnly session cookie, rate-limited login, guard on both `/api/*` and the WebSocket upgrade. The only mode where `docker compose up` on a bare VPS is safe with nothing else in front. | A public HTTPS VPS. |
| `tailscale` | Trusts a Tailscale-provided identity. Pair with `TRUST_PROXY=1` only behind a trusted proxy. | A private tailnet / home server.      |
| `proxy`     | Trusts an upstream auth header from a reverse proxy (Authelia, oauth2-proxy, Caddy basic-auth). | You already run an auth proxy.     |
| `none`      | **Refused in production** unless the host is loopback.                                        | Local development only.               |

## Claude subscription login

The chat UI's Claude turns bill the Claude subscription. They never bill an API
key: a turn whose profile has no credential of its own clears
`ANTHROPIC_API_KEY` before Claude Code starts, and refuses to send its prompt if
Claude Code still selects a key. The subscription is authenticated by one
secret, `CLAUDE_CODE_OAUTH_TOKEN`: a **bearer credential for the account's
inference**. Anyone holding it can spend that account's usage, so keep it where
you keep your other secrets.

The token is minted **off the host**, because minting it needs the account
holder to approve it in a browser, and a headless server has neither the
browser nor, usually, a terminal you can paste into. It lasts one year. Run
this procedure once a year, and again whenever the token is revoked or the
server says to log in again:

1. **Mint.** On any machine with a browser and Claude Code installed, run
   `claude setup-token` and approve in the browser. Either completion path
   works. The browser can redirect back to the CLI, or, if it cannot reach the
   CLI, the page shows a code to paste at the CLI's prompt. The CLI prints the
   token.
2. **Store.** In the host's secret store, set `CLAUDE_CODE_OAUTH_TOKEN` to the
   token and `BRAIN_UI_CLAUDE_TOKEN_MINTED_AT` to today's date (for example
   `2026-09-23`). Change both together: the date is how the server knows when
   the token expires.
3. **Redeploy.** The server reads both at start-up; there is nothing to restart
   by hand beyond your platform's redeploy.
4. **Confirm.** Send a chat turn, then open `/api/status` (it is behind the
   login). Its `subscription` object shows `tokenSet: true`, the new `mintedAt`
   and `expiresAt`, and `lastProvenAt` from the turn you just sent.

What the server does between logins:

- **Before expiry.** From 30 days before `expiresAt`, and after it, the server
  logs a WARN at boot and at most once a day, naming the date and this
  procedure. Without `BRAIN_UI_CLAUDE_TOKEN_MINTED_AT` it cannot tell, and says
  so once at boot. A date it cannot read refuses the boot.
- **Proof it works.** `lastProvenAt` is the latest successful turn that ran on
  the subscription (kept in the database, so it survives a restart and the
  activity retention window), or a successful model-discovery call with the
  token in this process, whichever is later. Model discovery costs no usage.
- **When it stops working.** Every auth failure logs one WARN with an
  instruction, and `/api/status`'s `subscription.lastAuthFailure.action` carries
  the same:
  - `relogin`: the token was rejected (`authentication_failed`, or a 401 from
    model discovery). Run the procedure above.
  - `check_account`: the account itself was refused (`oauth_org_not_allowed`,
    `account_on_hold`, `billing_error`). A new token will not help; look at the
    account at claude.ai.
  - `check_config`: the server refused the turn before sending anything,
    because Claude Code was not set to run on the subscription
    (`subscription_required`): the token is missing, or a Claude setting on the
    host selects another credential or provider. The refusal names which.

  A failure on a profile that declares its own credential is that profile's
  and does not appear under `subscription`.

`claude auth status` is not a liveness check: it reports any well-formed token
as logged in. `/api/status` is the check.

## Agent and device access

A principal is the server-side identity attached to an authenticated device,
delegated agent, or system job. It gives activity an actor and, for
password-mode devices and agents, gives the owner one credential to revoke
without signing out the rest.

1. To create agent access, sign in as the owner, open **Settings → Devices &
   agents**, enter a recognizable label and expiry, and select **Create agent
   credential**. Copy the credential into the agent's secure configuration as
   the value of the `brain_ui_session` cookie: the value is shown once and
   cannot be recovered later.
2. To remove one device or agent, select **Revoke** beside it. Revocation rejects
   its future requests, closes its open sockets, discards its queued work that
   has not started, and makes its push subscriptions ineligible for future
   delivery. Work already running keeps running, and notifications already sent
   to a push service or device cannot be recalled.
3. **Sign out everywhere** still means everywhere: it revokes every active
   password-mode device and agent principal, not only the browser that selected
   it.

### Version transition

1. Upgrade the server and expect one re-login on every password-mode device: the
   new verifier rejects cookies in the old format. An agent using an old owner
   cookie also loses access; after signing in, mint it a delegated credential.
2. If the deployment stays on the upgraded version, keep the existing
   `COOKIE_SECRET`; the forced login is the only transition step.
3. A rollback needs no secret rotation: the upgrade migration advanced the
   legacy session epoch once, invalidating every pre-upgrade cookie that the old
   verifier could otherwise accept again.
4. Start the rolled-back deployment and sign in again on every device that
   should retain access.

## The honest cost picture

The hosting is cheap. The AI is not — and that is the part people underestimate.

| Item                | Cost                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------- |
| VPS                 | €4–6/mo (entry tier) — or $0 on a home server                                           |
| Domain              | ~$10/yr                                                                                 |
| Embeddings (Gemini) | ≈ $0 — the free tier covers a personal corpus                                           |
| Voice (Deepgram)    | Optional — free credit, then cents per hour                                             |
| **The model**       | **The dominant cost.** Claude backend: ~$100–200/mo (Max) or $20 (Pro, tight). pi backend: any API key at per-token rates, OpenRouter, or **$0 with local models** (Ollama/vLLM) at reduced quality. |

> **The AI usually costs more than the hosting.** Budget for the model first.

## Encryption, honestly

**True end-to-end encryption is incompatible with a server-side agent** — the
agent has to read your plaintext to operate on it. So brain-kit scopes
encryption to what actually protects you:

- **At rest** — an encrypted volume (LUKS or your provider's volume encryption)
  is the documented default for VPS deployments. This is real and recommended.
- **Encrypted backups** — restic or borg with encryption; an easy, high-value
  win (see below).
- **Encrypted git remote** for the content repo (age-encrypted bundles or
  git-remote-gcrypt) is a documented pattern, post-launch.
- **`brain.db`** stays unencrypted by design — it is a disposable, regenerable
  cache; the markdown is the sensitive artifact, so protect that.

Do not read "encrypted" as "the server operator cannot read your notes" — a
server that runs an agent over your notes can. [SECURITY.md](../../SECURITY.md)
states the threat model plainly.

## Backups

Independent of the UI, back up the two things that matter: the **markdown repo**
(a private git remote is the simplest backup) and, if you want point-in-time
recovery, **encrypted snapshots** with [restic](https://restic.net) or
[borg](https://www.borgbackup.org). Both encrypt client-side, so the backup
target never sees plaintext. `brain.db` needs no backup — `brain index --force`
rebuilds it from the markdown.

## See also

- [quickstart.md](../quickstart.md) — the local-first starting point.
- [concepts.md](../concepts.md) — why `brain.db` is disposable.
- [integration-contract.md](../integration-contract.md) — the surface a deployment consumes.
