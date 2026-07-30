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
   scraped content as untrusted data; write-capable tools sit behind your
   agent's permission gating; hosting docs recommend container isolation.
   Residual risk remains and is stated here honestly: a sufficiently crafty
   payload can influence an agent that reads it.
3. **Keep the content repo private.** The template pushes `--private`,
   `brain init` preflights remote visibility, and `brain doctor` warns loudly
   when the remote is public. Your brain contains your life — treat the git
   remote as part of the attack surface.
4. **brain-ui (separate repo) is a remote surface to an agent that can run
   commands in a container holding your data and tokens.** Auth is mandatory
   there; `AUTH_MODE=none` refuses to start on any non-loopback host,
   regardless of `NODE_ENV`, unless an explicit
   `BRAIN_UI_DANGEROUSLY_DISABLE_AUTH=1` says otherwise. See brain-ui's own
   SECURITY.md — it is the more critical of the two.
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

## Scope

Vulnerabilities in `@endoxa/*` packages and the template are in scope.
Prompt-injection reports are welcome but tracked as hardening work, not
CVE-class bugs, unless they cross a documented security boundary.
