---
name: brain-host
description: Set up backup or hosting for a brain — private GitHub backup, a public HTTPS VPS, a home/Tailscale server, or fly.io. Interviews for intent, automates the safe parts, and generates a runbook. Use when the user wants their brain backed up or reachable.
requires: [gh, git, ssh, curl, docker]
---

# Brain Host — Backup and Self-Hosting

Sets up where a brain lives and how it's reached. Interviews for intent, automates what is safe
to automate, generates a copy-paste runbook for the rest, and validates the result. Includes an
honest cost picture so the user isn't surprised.

**This skill orchestrates external tools with consent.** Anything that creates a repo, pushes,
or drives a remote host is confirmed before it runs.

## Interview

Ask what they want:

- **a. Private GitHub backup only** — versioned off-machine copy, no server.
- **b. VPS with public HTTPS** — brain-ui reachable from anywhere, password-protected.
- **c. Home server / Tailscale-only** — private network, no public exposure.
- **d. fly.io** — managed container host.
- **e. Nothing right now** — explain the trade-offs and stop.

## What each path does

| Concern | Automates (with consent) | Documents |
|---|---|---|
| GitHub private repo | `gh auth status` → `gh repo create --private` → push → **verify visibility is private** | PAT scopes for the container (`GITHUB_TOKEN`) |
| Env generation | writes `.env` for the compose stack from the answers (auth mode, domain, tokens, TZ); generates the password hash | where each key comes from (the setup-token flow for the agent backend is documented in `.env.example`) |
| VPS | generates a runbook (provision → DNS → `docker compose up` → healthcheck curl); may drive it command-by-command over SSH **only with consent** | Hetzner walk-through, fly.io variant, DNS, backups |
| Tailscale / home | compose without the reverse proxy, `AUTH_MODE=tailscale`, `TRUST_PROXY` notes | Tailscale install + Serve |
| Validation | `curl` the health endpoint, a login check, one chat round-trip through the UI | troubleshooting table |

**Always verify repo visibility after `gh repo create`.** A brain pushed to a public repo is a
serious leak; confirm private before pushing content, and stop if the check disagrees.

## Auth defaults

For any public path, default to `AUTH_MODE=password`: generate the hash into `.env` and never
expose a write-capable agent without a login. `AUTH_MODE=none` must refuse to start in
production unless the host is loopback — do not talk the user out of that guard.

## Honest cost table (state this plainly)

- **VPS:** €4–6/mo entry tier (e.g. Hetzner), or **$0** on a home server.
- **The model is the dominant cost.** Claude backend: Max $100–200/mo, or Pro $20/mo (tight).
  pi backend: any API key at per-token rates, OpenRouter, or **$0** with local models
  (Ollama/vLLM) at reduced quality.
- **Embeddings:** Gemini ≈ **$0** — the free tier covers a personal corpus.
- **Voice (optional):** Deepgram — free credit, then cents per hour.
- **Domain:** ~$10/yr.

The one-line summary to give the user: **"the AI usually costs more than the hosting."**

## Validation

After deployment, confirm end to end:

```bash
curl -fsS https://<host>/api/health
```

Then walk the user through a browser login and one chat message that reads something back from
the brain. If any step fails, use the troubleshooting table rather than guessing.

## CLI it relies on

- `gh` — `gh auth status`, `gh repo create --private`, visibility verification.
- `git` — push the brain to the remote.
- `ssh` — optional command-by-command VPS driving (consent required).
- `curl` — health check and round-trip validation.
