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

Template extraction and clean-room hosting verification remain with
[#70](https://github.com/schlessera/brain-kit/issues/70). The package behavior
below is reference material; it is not a completed deployment walkthrough.

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

The [agent worker host boundary](agent-workers.md) documents the required
Linux/bubblewrap probe, visible startup refusal and measured launcher profiles.
Browser clients can use other operating systems.

**The server refuses to boot against `@schlessera/brain` older than 0.33.0.**
This is not an upgrade note for one release; it is a standing floor, enforced at
`MIN_BRAIN_CLI_VERSION` (`packages/ui-server/src/brain/client.ts:88`). The server
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

## Sync

A sync from the UI runs `brain sync`, which commits, pulls, merges and pushes
without a coding agent, and starts the agent (the `/sync` skill) only for a
conflict no merge strategy handles or files it could not classify. Media
leftovers are listed in the report and never committed, since nobody is at a
terminal to approve them. Most syncs therefore cost no agent session.

A scheduled sync records whether it started the agent and, when it did, the
Claude Code version that agent run reported, on the run in Activity.
`/api/status` shows the latest sync's own state and the last version a sync
observed, with the run and time it came from, under `runtime.sync` beside the
chat runtime. The two can differ: chat and the brain CLI may run different
Claude Code installations.

The sync asks TypeSafe AI's Jev two narrow questions when `TYPESAFE_API_KEY`
is set; the server passes the key through to the brain CLI. Without it the
sync takes the conservative defaults. See
[configuration.md](../configuration.md#sync).

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

## Offline use and local recordings

These are package capabilities for a host using the
[durable recording root](../../packages/ui-react/README.md#recording-on-the-device)
and [cached-shell policy](../../packages/ui-sdk/README.md#cached-offline-capture-shell).
The host must enable durable local capture and precache the shell's capture
assets. Previously visiting a host does not by itself prove those assets remain
cached. Generated worker/index/offline pages and manifests are owned by
[brain-hosting-template #11](https://github.com/schlessera/brain-hosting-template/issues/11).
Older installed packages or a shell
without this setup need not offer these capabilities.

| How you opened the app | Available locally | Needs the host |
| --- | --- | --- |
| **Warm disconnect:** this page already connected, then lost transport | Drawn chat stays mounted. Keep typing with focus, selection, IME, images and reading position preserved. Start/stop local recording, play retained accessible audio, review a saved transcript and add it to a local draft. | Send, server history/agent work and saved-audio transcription. Reconnect restores availability without sending new local work. |
| **Cold cached launch:** open a new page offline with a controlling worker and retained shell assets | A minimal capture screen creates **unassigned** device-local recordings and permits their playback/discard. Account audio is locked; only aggregate size is shown. | Protected chat/history, account drafts and transcription. When the server returns, choose Continue; capture drains before leaving, and login/explicit association precede upload. |
| **First-ever uncached offline visit**, or missing required shell assets | The capture app cannot boot. A browser offline error or a reachable worker's last-resort explanation may appear. | Load successfully online before attempting cached offline use. This is not a supported first-visit offline app. |

The [warm continuity proof](https://github.com/schlessera/brain-kit/pull/1232)
and [actual cached/uncached worker proof](https://github.com/schlessera/brain-kit/pull/1247)
exercise these boundaries in real Chromium. A full offline history cache and
offline server-side agent execution are not provided.

**Transport loss and sign-in expiry differ.** Expiry/revocation stops capture,
commits the work snapshot and removes protected views. Successful sign-in as
the same account restores the saved work context without a full reload when
the snapshot exists. An unfinished IME composition is not recoverable through
auth loss; only committed text is kept. Another account cannot open the prior
account's work. A failed snapshot is reported and uses reload/cold recovery.
[Auth-transition proof](https://github.com/schlessera/brain-kit/pull/1240) covers
this independently from transport continuity.

### Keeping and accepting audio

Recordings have a **10-minute limit each** and a **100 MiB total retained-audio
limit per app origin/device**, across all account partitions and unassigned
recordings. Browser capacity can be lower. A limit or failed write stops
capture and keeps the committed playable prefix; older recordings are never
evicted to admit a new one. There is **no automatic age expiry**. Keep audio
until you explicitly discard it or accept its transcript into a safely saved
local draft. Transcription success alone does not delete it.
[Retention ruling](https://github.com/schlessera/brain-kit/issues/578#issuecomment-5907064902)
and [real recording-store proof](https://github.com/schlessera/brain-kit/pull/1230)
establish these limits.

**Saved up to** names the last committed audio boundary. The end may be missing
after interruption or storage failure; the app does not promise a one-second
loss limit or background recording through screen lock/calls. It never restarts
the microphone automatically. Microphone denial or unsupported capture/storage
gets an explanation; warm local typing remains available. Storage persistence
requests and capacity estimates are not guarantees.

To transcribe, reconnect and sign in, explicitly associate any unassigned
recording with the account, select Transcribe, then confirm **Upload and
transcribe**. Only that action uploads audio to your brain server, which sends
it to the named speech provider. Deepgram is the only built-in saved-audio
provider; Web Speech and external providers without the capability retain the
unavailable explanation and your audio. Live dictation is a separate path.
No audio upload happens just because you sign in, reload or reconnect.

A failed transcription retains audio. Definitive transient/capacity provider
failures allow at most **three explicit user retries** per recording/hash.
Unknown outcomes are terminal; media/validation and authentication failures do
not offer Retry. A lost reply may mean processing happened; it is not called
Not sent without evidence. Reconnection may query transcription status or flush
an earlier explicit receipt deletion, and does not upload or retry audio.
These rules come from the [retry ruling](https://github.com/schlessera/brain-kit/issues/1021#issuecomment-6055129108)
and [keyless saved-transcription proof](https://github.com/schlessera/brain-kit/pull/1256),
not measured live-provider performance.

Review and edit the saved transcript, then choose **Add to draft**. The draft
commits locally before audio deletion; a failed save keeps the recording. Add
does not send a message, upload the draft or answer an approval. You still
choose Send; subsequent editing resumes the ordinary host-draft workflow.
[Acceptance proof](https://github.com/schlessera/brain-kit/pull/1241) exercises
the native commit-before-delete boundary. Draft text/images can be saved on the
device; **staged track files stay in this tab only**, including when their view
is hidden. A browser leave warning does not make those files survive reload.
[Track lifetime](https://github.com/schlessera/brain-kit/issues/1112#issuecomment-6032010851)
and [leave-warning proof](https://github.com/schlessera/brain-kit/issues/1150#issuecomment-6033781561)
explain the distinction.

### Privacy and browser recovery limits

Account partitioning controls what this UI can open; **it is not protection
against someone with access to the device**. Local audio/drafts are not
per-account encrypted. Anyone using this browser profile can play unassigned
recordings. Login does not silently assign them: selection starts empty,
association moves only the chosen recordings, and cancellation keeps them
unassigned. Sign-out warns and clears the current account's local partition.
Unassigned recordings stay unless you tick the separate, initially unticked
Also delete choice. Storage failure cannot veto the logout attempt and is
reported afterwards; failed cleanup does not imply that all local work is gone.
[Approved R1/R2 policy](https://github.com/schlessera/brain-kit/issues/578#issuecomment-5998617047)
and [native account/sign-out proof](https://github.com/schlessera/brain-kit/pull/1248)
establish this boundary.

Browser storage can be unavailable, evicted, private-profile-limited or cleared
by the user. These risks have no measured per-browser loss distribution in V1.
If an index and some chunks survive, recovery can keep an interrupted playable
prefix. If all chunks are gone but an unaccepted transcript survives in the
index, review remains available with an audio-unavailable explanation, without
adding to the removed-recording count. An index with neither audio nor a
transcript instead produces the removed-recording notice. **If both the
recording index and its chunks disappear, with no other
surviving evidence, there is nothing the UI can show or report.** Retention
policy does not protect against loss of the browser's underlying storage.

The [dated V1 browser matrix](../decisions/design-kit.md#desktop-browser-measurements-and-their-limits)
gives exact versions, conditions and loss distributions: Playwright 1.63.0,
Chromium 153.0.8010.12 and Firefox 155.0, requested 1000 ms timeslices, seven
runs per measured interruption cell plus five confirmation runs for the named
subset. This was headed desktop Linux with deterministic fake audio, not a
physical-device trial. All measured runs preserved committed chunks and their
index. The matrix separates simulated track end, actual process kills/full disk,
and a hidden Chromium tab from real OS interruptions.

| Browser / condition | Measured boundary or explicit limitation |
| --- | --- |
| Desktop Chromium 153.0.8010.12 | WebM/Opus capture, Blob storage, close/crash/browser kill, hidden-then-kill, simulated track end and full disk measured under the linked V1 conditions. MP4 capability detected; interruption runs used WebM. |
| Desktop Firefox 155.0 | WebM/Opus probe, Blob storage, close/content-process/browser kill, simulated track end and full disk measured. MP4 unsupported in that build. Hidden behavior **NOT MEASURED**: runner could not hide its separate window; [#1236 measurement handoff](https://github.com/schlessera/brain-kit/issues/1236). |
| Playwright Linux WebKit 26.6 | No MediaRecorder in that build; recording interruptions **NOT MEASURED** for that reason. It is not Safari; [#1236 handoff](https://github.com/schlessera/brain-kit/issues/1236). |
| Android Chromium | **NOT MEASURED**: V1 had no device and no emulator finding is supplied; [#1236](https://github.com/schlessera/brain-kit/issues/1236). |
| Safari macOS | **NOT MEASURED**: no available Apple device; [#1236 scope exclusion](https://github.com/schlessera/brain-kit/issues/1236) and [ruling](https://github.com/schlessera/brain-kit/issues/1010#issuecomment-6045077836). |
| Safari iOS tab / installed PWA | Both **NOT MEASURED**: no available Apple device; [#1236 scope exclusion](https://github.com/schlessera/brain-kit/issues/1236) and [ruling](https://github.com/schlessera/brain-kit/issues/1010#issuecomment-6045077836). |
| Real OS mic interruption, screen lock / background freeze, all browsers | **NOT MEASURED**: V1 could simulate track end, not an OS call or locked screen; the CDP freeze request did not freeze capture. Attainable emulator cells moved to [#1236](https://github.com/schlessera/brain-kit/issues/1236). |
| Eviction, private-mode lifetime, user-cleared site data and an origin quota lower than free disk, per browser | **NOT MEASURED**: V1 did not provoke these storage-lifecycle events or impose a lower engine quota. [Full reasons and #1236 handoff](../decisions/design-kit.md#unmeasured-cells-and-detectable-storage-loss). |

The [desktop-suffices ruling](https://github.com/schlessera/brain-kit/issues/1010#issuecomment-6040793673)
accepts these desktop findings for package work. It does not certify any
unmeasured device or interruption cell.

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

Claude profiles without their own credential require the Claude subscription.
Profiles that explicitly declare an API credential use that profile's billing
mode instead. A turn whose profile has no credential of its own clears
`ANTHROPIC_API_KEY` before Claude Code starts, and refuses to send its prompt if
Claude Code still selects a key. The subscription is authenticated by one
secret, `CLAUDE_CODE_OAUTH_TOKEN`: a **bearer credential for the account's
inference**. Anyone holding it can spend that account's usage, so keep it where
you keep your other secrets.

The token is minted **off the host**, because minting it needs the account
holder to approve it in a browser, and a headless server has neither the
browser nor, usually, a terminal you can paste into. The server estimates
expiry as one year after the supplied mint date; this is its reminder policy,
not proof that a token is still accepted. Renew when the account/provider
requires it, the token is revoked or the server says to log in again:

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

Budget for hosting and model usage separately. Prices, credits and quotas vary
by provider, account, region and date; no free allowance is guaranteed here.

| Item                | Cost                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------- |
| Host                | Provider plan, storage and backups; a home server also uses hardware and electricity. |
| Domain              | Registration and renewal if you choose public HTTPS. |
| Embeddings/enrichment | Corpus size, changed chunks, asset descriptions and the selected provider's current rates/quotas. |
| Voice               | Optional transcription usage under the selected provider's plan. |
| Chat model          | A supported subscription or API usage for the configured profile. Local models need compute and may differ in capability. |

Consult the current provider plan before enabling paid capabilities, and use
the Activity cost figures only where the backend can actually report them.

## Encryption, honestly

**True end-to-end encryption is incompatible with a server-side agent** — the
agent has to read your plaintext to operate on it. So brain-kit scopes
encryption to what actually protects you:

- **At rest** — protect the content and UI-state volumes with your host's
  encryption facilities; brain-kit does not provision an encrypted host.
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

If you run the chat UI, its database is separate persistent state: sessions,
principals, settings, activity and push/notification records are not rebuilt
by `brain index`. Preserve that database and the required secrets as part of
your host's backup and restore procedure. See the server's
[environment reference](../../packages/ui-server/README.md#environment)
for `DB_PATH`; the future hosting template owns the operational procedure.

## See also

- [quickstart.md](../quickstart.md) — the local-first starting point.
- [concepts.md](../concepts.md) — why `brain.db` is disposable.
- [integration-contract.md](../integration-contract.md) — the surface a deployment consumes.
