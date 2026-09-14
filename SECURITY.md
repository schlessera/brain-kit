# Security

## Reporting a vulnerability

Email the maintainer via the address on the GitHub profile, or open a private
security advisory on GitHub. Solo-maintained project — expect a response
within a week, not hours.

## Threat model, in plain words

1. **This system grants an LLM read access to everything you put in it, and
   write access to the repo.** That is the product. Do not put content in a
   brain that you would not hand to the AI provider configured in your
   `brain.config.ts` (embeddings, completions, and your coding agent all see
   content).
2. **Prompt injection is a real, unresolved risk.** Imported notes, scraped
   job postings, and any third-party text your agent reads can contain
   instructions that steer it. Mitigations shipped: skills frame imported and
   scraped content as untrusted data; hosting docs recommend container
   isolation. Residual risk remains and is stated here honestly: a
   sufficiently crafty payload can influence an agent that reads it.
3. **Keep the content repo private.** The template pushes `--private`,
   `brain init` preflights remote visibility, and `brain doctor` warns loudly
   when the remote is public. Your brain contains your life — treat the git
   remote as part of the attack surface.
4. **brain-ui (separate repo) is a remote surface to an agent that can run
   commands in a container holding your data and tokens.** Auth is mandatory
   there; `AUTH_MODE=none` refuses to start on any non-loopback host,
   regardless of `NODE_ENV`, unless an explicit
   `BRAIN_UI_DANGEROUSLY_DISABLE_AUTH=1` says otherwise. See brain-ui's own
   SECURITY.md — it is the more critical of the two. From 0.33.1, every agent,
   cron, and brain CLI subprocess that brain-kit itself spawns receives only
   its audience allowlist; required agent credentials and git tokens remain,
   while server-only values such as `COOKIE_SECRET`, the password hash,
   Deepgram key, skills token, WebAuthn settings, and proxy-auth settings do
   not. One pi-SDK residual remains: an extension's `pi.exec()` follows
   `DefaultResourceLoader` → extension loader → `execCommand()` → `spawn()`,
   and pi's package-manager helpers spawn the same way, with no supported
   environment option in pi 0.84.4. Those in-SDK children therefore inherit
   the full brain-ui server environment, including those server-only values.
   S4a is closed for every spawn this repository owns and remains open for
   pi's in-SDK spawns until U32 in 0.35.0 moves the pi runtime under the
   `agent` uid.
5. **Key handling.** Every API key lives in `.env` (gitignored) and is only
   read by the provider that declares it (`apiKeyEnv`). What each key can
   spend: an embeddings key (Gemini free tier covers a personal corpus) is
   low-risk; a completions/agent key spends per token; a coding-agent OAuth
   token can do whatever your agent can do — scope it accordingly.
6. **Containment: everything the CLI writes stays inside the brain root.**
   Config-supplied directories, module config paths, and caller-supplied
   document paths are validated as repo-relative (no absolute, `~`, `..`, or
   control characters) and resolved through a symlink-aware canonicalizer, so
   neither a symlinked directory nor a dangling symlink can redirect a write
   out of the repo. Mutating commands refuse to run when no `brain.config` is
   found, so they cannot initialize a stray directory. The `modules` config
   key is the only value that reaches `import()`: it must be an npm package
   specifier or a contained `./path`, and it is canonicalized before load, so
   a symlink cannot make the loader execute code from outside the root.
7. **Module contributions are validated, not trusted.** A module's `setup()`
   output is schema-checked before anything merges it, and cron entries are
   constrained to shapes that cannot inject a line into a generated crontab —
   container entrypoints materialize them with root privileges.
8. **Encryption.** brain.db and markdown live in plaintext on your disk; use
   full-disk/volume encryption for at-rest protection and encrypted backups
   (restic/borg). True end-to-end encryption is incompatible with a
   server-side agent that must read plaintext to operate — any setup claiming
   otherwise is misrepresenting something.
9. **A principal is not a containment boundary.** A principal that has run a
   turn has had code execution in the container and could have read
   `COOKIE_SECRET` or written `brain-ui.db`. Revocation is the control for a
   lost or leaked credential and for a well-behaved agent; the control for a
   hostile one is rotating `COOKIE_SECRET` and auditing the system. Revocation
   disconnects that principal, discards its queued work, and makes its push
   subscriptions ineligible for future delivery, but work already running
   keeps running. A notification already handed to a device's push service or
   operating system cannot be recalled and may remain visible there; push
   payloads are minimized for that reason.

## What tool approvals are, and are not

The chat UI shows an approval card for some tool calls. **That is a
confirmation, not a containment boundary,** and the difference matters if you
are reasoning about what an agent can do.

`Bash` is auto-allowed, and the Agent SDK never consults the permission
callback for an allow-listed tool. An agent with `Bash` can therefore reach any
effect a gated tool would have had — through the CLI, a heredoc, or a script it
just wrote. For a while `brain archive x.md` typed into Bash ran silently while
the same operation through the `brain_archive` MCP tool raised a card; the
gated path was the one the documentation steers away from, so the confirmation
almost never fired.

What ships now is a configurable pattern list
(`BRAIN_UI_CONFIRM_BASH`): a Bash command matching one of them raises the
normal approval card. The shipped set covers `brain archive`, recursive `rm`,
and the git operations that discard work. It is deliberately a seatbelt:

- It catches a destructive command **you did not intend** — the realistic
  failure, where an agent misreads a request or follows an injected
  instruction and does something surprising in plain sight.
- It does **not** stop an agent that is working around it, and nothing here
  pretends otherwise. A command-string match cannot.

`brain archive` is on the list for a reason worth stating: archiving is a
visibility change. An archived document drops out of search, briefings and
context assembly, so a silent archive surfaces later as holes in output you
cannot account for — answers that should have cited something simply do not,
with nothing pointing at why. It is easy to undo and easy to miss, which is the
combination worth confirming.

**The real boundary is auth.** Only someone who can reach the UI can drive the
agent at all; that is what `AUTH_MODE` protects, and it is why `AUTH_MODE=none`
refuses to start on a non-loopback host.

## Scope

Vulnerabilities in `@schlessera/brain-*` packages and the template are in scope.
Prompt-injection reports are welcome but tracked as hardening work, not
CVE-class bugs, unless they cross a documented security boundary.
