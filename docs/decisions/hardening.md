# Decision — the hardening roadmap

The 2026-09-06 layer review found a set of boundary, session, environment and
packaging weaknesses. Closing them was sequenced across four releases, and this
is the reasoning behind that sequencing and each fix. Three of the four shipped
— 0.32.0 Boundary, 0.33.0 Kit owns the app, 0.34.0 One backend seam. The fourth,
least privilege in the container, is open and tracked in the private deployment
shell's issue tracker.

The original plan's unit tables and its forty-row progress log are gone: the
code is the answer to what landed, and the git history is the answer to when.
What is kept is why each fix has the shape it has, because that is what a later
change has to respect.

**Decision 8 below is superseded.** It sketched the least-privilege design
before the container spike ran; the spike then measured two things that changed
it — a plain uid drop breaks cancellation, and the pi backend cannot stay in the
server process. Read
[`container-privilege.md`](container-privilege.md) instead, and treat 8 as the
question it was answering.

## Key Technical Decisions

1. **Risk-ordered by runtime blast radius, not by severity.** 0.32.0 is
   server code the suite can prove; 0.35.0 is the only release with a data
   step. The CSRF fix removes the remote path to the agent before the
   agent's own privileges are reduced. Container hygiene with no data step
   (pins, sshd) ships in 0.33.0, not 0.35.0.
2. **One origin policy, mounted first.** `isSameOriginRequest` is rewritten:
   accept when `Sec-Fetch-Site` is `same-origin`/`none`, **or** when `Origin`
   matches the expected origin, **or** when both headers are absent
   (non-browser client, still auth-gated); `Origin: null` is rejected; when
   `ALLOWED_ORIGINS` is set it is consulted after both. The expected origin's
   scheme comes from `X-Forwarded-Proto` only under `TRUST_PROXY`, else from
   the request URL; without `TRUST_PROXY` the compare is host+port, as
   today, and hosting.md says so. It is mounted right after the request
   logger, before every `/api` route including the public login and passkey
   POSTs, and replaces `isAllowedWsOrigin` on the upgrade. `requireJson()`
   parses the media type (so `; charset=utf-8` passes) and applies only to
   routes that call `c.req.json()`. decisions.md records that dev relies on
   the OR (the vite proxy rewrites `Host`), so nobody tightens it to AND.
3. **Sessions epoch, not a session table.** One integer in `settings`
   (`auth.sessionsEpoch`), embedded in the signed cookie as
   `<issuedAt>.<epoch>` (safe because hono splits on the last dot; asserted
   by a test); `hasValidSession` rejects a mismatch or a payload without an
   epoch. Logout and passkey revocation bump it **and close every open
   WebSocket** (new `ClientSet.closeAll`). **The bump requires a valid
   epoch-bearing session**: logout is a public route today
   (`/auth/logout`, `packages/ui-server/src/middleware/auth.ts:794`,
   mounted before the guard), and a public epoch bump would let anyone log
   the owner out of everything in a loop. The epoch accessor is strict, not
   the fail-open settings getter: first initialization is distinguished from
   a corrupt row, which refuses. The epoch is authoritative auth state in
   `brain-ui.db`, not disposable derived state. The epoch is global, so the
   button reads "Sign out everywhere"; existing cookies are rejected once on
   upgrade. **Rollback below 0.32.0 revives revoked cookies** (the old
   verifier checks only signature and age), so the rollback step rotates
   `COOKIE_SECRET`.
4. **Secrets leave the subprocess env in two steps, from one audience-tagged
   descriptor.** `ui-sdk/server` gains `SUBPROCESS_ENV`: a map of variable
   name → audiences (`cron`, `agent`, `brainCli`) with the server-only set
   marked for none. 0.32.0 (U10) applies it as a denylist (strip what has no
   audience) — zero capability risk. 0.33.0 (U21) flips it to an allowlist
   per audience, with `BRAIN_UI_SUBPROCESS_ENV_EXTRA` as the operator escape
   hatch read in each package's env chokepoint, and the crontab emitter
   (U14) derives `/etc/environment` from the `cron` audience. One list, one
   owner, three subsets.
5. **Bridge tools are defined once in `ui-sdk/server` as zod objects.** The
   Claude adapter passes `schema.shape` to `tool()`; the pi adapter passes
   `z.toJSONSchema(schema, { io: "input" })` (with `$schema` stripped) as the
   `parameters` — plain JSON Schema satisfies pi's `TSchema` and is what
   pi-ai compiles; no typebox enters the SDK. Both adapters run
   `schema.parse(input)` before the shared handler, so zod is the canonical
   validator and JSON Schema is pi's advertisement layer. The shared
   description text and the shared zod schema identity are the equality
   proof; invalid-input behaviour is tested on both sides. `ask_user` on pi
   regains its description, `preview` and bounds (additive). The
   allowed-tools posture and the activity nonce wrapper become shared
   constants.
6. **Self-describing backend modules, minimal and `@experimental`, passed by
   value.** Each backend exports a `BackendModule` descriptor (`id`,
   `resolveFromEnv`, `profileSchema`, `settingsHooks`, and an optional
   `modelSource` that the Claude backend already implements today for
   Anthropic model discovery) — exactly what the two first-party backends
   need. The registry iterates a list of descriptors instead of a
   `claude | pi` union. `AGENT_BACKEND` keeps accepting only `claude` and
   `pi`: `docs/extending/README.md` binds "no plugin loader, no runtime
   discovery; custom implementations are imported and passed as values", so
   a third-party backend is first-class by handing its descriptor to
   `createApp({ registry })` from the consumer's bin, not by naming an npm
   specifier in the environment. The declaration-surface gate keeps
   forbidding specifiers in emitted types; its mirror-drift `Assert<>` block
   is rewritten in the same PR. Unknown non-empty stored backend ids fail
   explicitly (today `getBackendForSession` silently substitutes the
   default, `backend.ts:1039`, against brain-ui decision 3).
7. **Cron moves as a bin with a parameterised emitter and a golden test.**
   `brain-ui-cron` (`src/bin/brain-ui-cron.ts`, bun-only like the package)
   with `run`, `digest`, `crontab`, `environment` subcommands. The emitters
   are pure functions of the module list, `wrapperCommand`, `pathLine` and
   `user`; the golden is captured from today's bash with today's values, and
   the cutover changes parameters, not the emitter. `DB_PATH` and every env
   read move into the ui-server env chokepoint.
8. **Least privilege is a toolchain relocation first, then users.** bun, the
   Claude CLI, `CLAUDE_CONFIG_DIR`, the pi state dir and logs move out of
   `/root` to `/opt` and `/data` prefixes with explicit owners (U30); only
   then does `brain-ui` run as `brain` under supervisord `user=` and cron
   lines carry the user field (U31). The agent runs as `agent` through a
   wrapper reached via `CLAUDE_CODE_PATH` (Claude) and an argv wrapper for
   pi's two spawns; the uid switch is `sudo` with one exact rule and an
   explicit `env_keep` list, with signal relay proven by an abort test, or a
   setuid-root exec helper if sudo's fork breaks cancellation. The brain repo
   is group-shared (`core.sharedRepository=group`, setgid dir, umask 002,
   `safe.directory` for both users). Everything is decided by a container
   spike in 0.33.0 (U24), recorded here before 0.34.0 is cut so 0.35.0 is
   designed a release ahead.
9. **brain-ui gets tags.** Each milestone's deps-bump merge commit is tagged
   `v<kit version>`.
10. **The refactor release owns every refactor, as separately tagged
    releases.** Dispatcher, store and page splits (U33) ship in the 0.34.x
    train, never in the container release. Because U28 changes frame
    production (`adapter.adapt(msg)`,
    `packages/ui-backend-claude/src/turn-runner.ts:200`) and U33 changes frame
    consumption
    (`handleServerMessage`, `packages/ui-react/src/connection.ts:125`), the
    same symptom could come from either, so they are **0.34.0** (seam) and **0.34.1** (splits), each its own
    image. For the same reason the cron bin and emitters (U13/U14) ship as
    **0.33.0** with the denylist unchanged and the allowlist (U21) as
    **0.33.1**: both change what a scheduled job sees at `cron-run.ts:218`.
