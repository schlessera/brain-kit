# Provider history is append-only

A conversation with a model provider is a sequence of requests. Each one resends
everything that came before: the tool definitions, the system prompt and every
earlier message. Providers cache that prefix. A request whose prefix matches the
previous one byte for byte is billed mostly at the cache-read rate. A request
whose prefix differs anywhere is billed in full from the first changed byte
onward, and the changed version is written to the cache again at a premium.

brain-kit sits between the user and that request on every turn. It chooses the
tools, writes the system-prompt append, adds context to the user's message,
spawns the worker that runs the provider client, restores the transcript the
client resumes from, and records what happened. Each of those is a chance to
change bytes the provider has already cached. This record is the rule that keeps
brain-kit from doing that, and the guard that checks it.

## The rule

**What the provider received for turn N is the prefix of what it receives for
turn N+1.** brain-kit may only add to the end of the conversation, never change
what is already in it. Concretely, across the turns of one session:

1. **Tools stay the same.** The same tool definitions, with the same schemas and
   in the same order, on every turn. A posture, profile or capability that
   should not use a tool is enforced in the permission hooks, not by leaving
   the tool out.
2. **The system prompt stays the same.** Anything brain-kit puts into the system
   prompt or its append is fixed for the life of the session. Nothing in it may
   depend on the time, the device, the repository's state, budgets, the sandbox,
   or anything else that changes between turns. That includes what the
   provider client adds on its own, such as Claude Code's git status, which is
   rebuilt by each new CLI process.
3. **Earlier messages stay as sent.** A saved transcript is the provider's
   record and is never rewritten: no stripping, redaction, link rewriting,
   synthetic entries or replaced tool results. Whatever brain-kit needs to
   remember about a message lives in brain-kit's own storage, keyed to it.
4. **Internal data stays internal.** Budgets, journals, attribution, receipts,
   labels, display hints and diagnostics belong in brain-kit's database, the
   journal and the UI. They are not added to the provider-facing conversation.
5. **What the model must see is added once, at the end.** If the model needs a
   new fact to act on, such as a crossed budget threshold or a changed device,
   it goes into the new message as new content, and only when it changed. It is
   never restated on every turn, and an earlier copy is never edited or removed.

The same rule applies to every backend. On Claude the provider client owns the
request, so brain-kit's obligation is over what it feeds that client: options,
system-prompt append, tool lists, settings, environment, hooks, the prompt
text and the transcript file it resumes. On Pi, brain-kit assembles the context
itself, so it owns the request outright.

## Why

**Adding to the history costs every turn after it.** Anything appended to a
message is resent on every later request for the rest of the session. A
120-token note added to each user message is 120 tokens on turn 1, 240 on turn 2
and 1,200 by turn 10. They are cheap cache reads, but they are paid on every
request, and they crowd the context window.

**Changing the history can lose reuse and prior thinking.** A changed prefix
can prevent reuse of the cache entry for that prefix. Provider pricing,
cache lifetime and thinking behavior depend on the model and platform; consult
the provider's [prompt-caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
and [extended-thinking documentation](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
for their current rules. This guard proves byte stability, not a particular
bill, cache hit or thinking-invalidation response.

### What prompted this

The prompt-cache stability epic #2045 identified several independent prefix
risks: repository context in the Claude preset (#2046), a system append rebuilt
from per-turn facts (#2047), posture-dependent tool lists (#2048), rewritten
native transcripts (#2049), routine budget notes (#2051), and auxiliary title
traffic (#2052). Local request captures establish request assembly only; they
do not identify a production cache miss's cause or demonstrate provider savings.

## Selected ruling: new facts in the new tail

The maintainer selected option B on 2026-10-16 for #2047. Authoritative state,
change tracking, attribution and structured provenance stay internal. Relevant
changes to device/capability facts, sandbox/journal/protected-path facts and
actionable budget thresholds may reach the model once, in the new user content
or equivalent new-turn context. Static configured warn/stop limits may remain
in the session's fixed append. Routine running totals do not enter it.

Replay recognizes additions through structured ownership keyed to native
message identity and content, preserving user-authored lookalikes exactly.
The native transcript remains untouched. This retains the enforcement decisions
in [voice-permission.md](voice-permission.md), [worker-writable-areas.md](worker-writable-areas.md)
and [governed-writable-workers.md](governed-writable-workers.md).

Rejected alternatives are freezing all live facts out of the model (which
withholds relevant safety/context changes), rebuilding the system append
(which rewrites the prefix), and recognizing owned context by display text
(which can corrupt user-authored lookalikes).

## The guard

The keyless test `packages/ui-backend-claude/tests/provider-history.test.ts`
runs real consecutive turns through the installed SDK against a local fake
Messages endpoint. It records the exact request bodies and asserts the rule
directly:

- `tools` and `system` are byte-identical between turns of one session;
- every request's `messages` extend the previous request's `messages` plus that
  request's answer;
- between the turns, the test changes everything that legitimately changes in
  real use: the repository (a commit and an untracked file), the device, the
  budget, the sandbox facts and the posture.

`packages/ui-backend-pi/tests/provider-history.test.ts` does the same for Pi
against a fake OpenAI-compatible endpoint, which Pi reaches through
`/v1/responses`.

On Claude the guard also checks the `systemPrompt` option brain-kit hands the
SDK on each turn, not only the bytes that reach the endpoint. Against a local
endpoint the CLI replays turn 1's recorded system prompt, so a changed append
never shows up in the request there. The SDK documents that recording as
account-gated, so production can still send the changed append, and only the
option-level check catches it.

The resolved #2047/#2048/#2049/#2051 cases are ordinary passing tests.
A new known break that is not fixed yet is written as `test.failing` with the
issue that tracks it. When the fix lands the case starts to pass, `bun test`
reports that as a failure, and the fix's PR turns it into a plain `test`. A
break can therefore be acknowledged, but not silently tolerated or forgotten.

The Claude probe also runs with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
unset: the installed CLI issues a tool-free title helper on the first turn,
using the same model as the main request. Explicitly setting the flag to `1`
suppresses it. Auxiliary traffic is separated from main history; its supported
OTLP `query_source=generate_session_title` attribution and cumulative-once
accounting are guarded separately by #2052. Same-model usage alone is not a
classifier. Pi voice is rejected before session acquisition, so the guard
asserts that refusal and unchanged request count, rather than comparing a nonexistent voice request.

The guard proves how brain-kit assembles a request. It does not prove that a
provider hits its cache: a local endpoint changes some request details (see
[the autonomous prompt-cache notes](../hosting/autonomous-prompt-cache.md)),
and cache identity depends on the account, model and platform. Confirming
real cache hits stays an opt-in measurement with a real provider.

## When you change something on a turn's path

Ask, for every byte your change sends to the provider:

- **Is it new?** Then it goes at the end of the newest message, once.
- **Does it change something already sent?** Then it is wrong. Store it
  internally, or find the append-only form.
- **Does it vary between turns but live in the tools or system prompt?** Then
  it is wrong. Move it to the end of the newest message, or make it fixed per
  session.
- **Does the model actually need it?** If it is for the UI, attribution,
  accounting or debugging, it never reaches the provider.

Then run the guard. A PR that has to change the guard's expectations, rather
than its `test.failing` list, needs a maintainer ruling on its issue first.

## Rejected

- **Put per-turn facts in the system prompt so the model always sees the
  current value.** Every turn would then rewrite the whole prefix. The 2.1.29x
  Claude CLI also appears to reuse turn 1's recorded system prompt on resume
  (read from the bundled binary, not documented), so the model might not see
  the new value anyway.
- **Strip display-only additions from the history on replay.** The provider has
  already cached the unstripped bytes, so stripping is itself an edit. Keep the
  addition out of the history in the first place.
- **Rely on the provider's cache diagnostics in production.** They find a break
  after it has been paid for, and only on providers that offer them. The guard
  finds it before merge, keyless, for every backend.
