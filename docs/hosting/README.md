# Hosting

You do not have to host anything. A brain is a git repo you operate from a
coding agent on your own machine — that is the whole product. Hosting adds two
optional things: an off-machine **backup** (a private git remote) and a
self-hosted **chat UI** you can reach from your phone. This page is the honest
overview; the detailed runbooks ship with brain-ui.

## What brain-ui is

**brain-ui** ([github.com/schlessera/brain-ui](https://github.com/schlessera/brain-ui))
is a separate, open-source repo: a Progressive Web App chat interface that
drives a coding agent over your brain. It is a **thin deployment shell** —
Dockerfile, bin entry, branding — over the `@schlessera/brain-ui-server` and
`@schlessera/brain-ui-react` packages published from this monorepo; every line
of app behavior lives here, and brain-ui consumes the published npm packages
like any other dependency (no vendored copies). It versions independently
against the [integration contract](../integration-contract.md). Its own README
and docs cover deployment specifics.

Running brain-ui means running an agent that can execute Bash in a container that
holds your data and your API tokens. That is powerful and it is a real attack
surface — which is why auth is mandatory (below) and why the content repo must
stay private.

## Upgrading to 0.33.0

Before deploying brain-ui 0.33.0, bump the brain repo's
`@schlessera/brain` pin to 0.33.0 or newer and refresh its lockfile. The
ui-server now places `--` before user-controlled CLI positionals, which requires
the end-of-options parser added in core 0.33.0. Rolling the image back does not
roll back the brain repo's package pin; manage that pin separately (and leaving
the compatible newer core pinned is safe).

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

brain-ui **fails closed**: it never ships a default that exposes a write-capable
agent without authentication.

| Mode        | What it is                                                                                   | Use when                              |
| ----------- | -------------------------------------------------------------------------------------------- | ------------------------------------- |
| `password`  | **Default for public exposure.** Hashed password, signed HttpOnly session cookie, rate-limited login, guard on both `/api/*` and the WebSocket upgrade. The only mode where `docker compose up` on a bare VPS is safe with nothing else in front. | A public HTTPS VPS. |
| `tailscale` | Trusts a Tailscale-provided identity. Pair with `TRUST_PROXY=1` only behind a trusted proxy. | A private tailnet / home server.      |
| `proxy`     | Trusts an upstream auth header from a reverse proxy (Authelia, oauth2-proxy, Caddy basic-auth). | You already run an auth proxy.     |
| `none`      | **Refused in production** unless the host is loopback.                                        | Local development only.               |

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

brain-ui's SECURITY.md states plainly what each mode does and does not protect.
Do not read "encrypted" as "the server operator cannot read your notes" — a
server that runs an agent over your notes can.

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
- [integration-contract.md](../integration-contract.md) — the surface brain-ui consumes.
