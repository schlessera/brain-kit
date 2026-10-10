# Claude 2.1.287 permission compatibility measurement

Measured on 2026-10-03 for [#901](https://github.com/schlessera/brain-kit/issues/901).
This records evidence and an upgrade recommendation; it changes no permission
policy, dependency requirement, package version or `MEASURED_RUNTIME` constant.

The retained SDK/CLI pair passes the full existing probe. The candidate pair
reproduces all three reported failures. The production backend's explicit
allowlist enforcement preserves the tested authorization boundary on both
pairs. An omitted permission mode changes from `default` to `auto` in this
loopback setup; explicitly requesting `default` restores the three selected
raw-probe verdicts. That control is not a full candidate upgrade verification.

## Identity and isolation

Both environments began with the same source at
`1d1fcc72a7e06352e8b5ee020b3910864babc5db`. The retained worktree used
`bun install --frozen-lockfile`. A disposable copy changed only its backend SDK
dependency to exactly `0.3.287`, then ran `bun install`. Its lockfile diff added
only that SDK and its eight platform packages; all other resolved packages
remained identical. The experimental manifest and lockfile are not committed.

The probe resolves the SDK from the backend source directory. The candidate
copy also has a hoisted retained SDK: it does **not** answer for the backend's
nested candidate SDK. Each permission turn reported its actual CLI version in
`system/init`, including all twelve production turns in each environment.

| Identity | Retained | Candidate |
| --- | --- | --- |
| Actually loaded SDK manifest | 0.3.283 | 0.3.287 |
| Actually executed CLI, from every permission turn's init | 2.1.283 | 2.1.287 |
| Loaded `sdk.mjs` SHA-256 | `d88abad1360f675dda417c9a6ce7395447d0892b77735529083d10ea4fbdd242` | `21fbc4b359e517a370524dd6e25c40c5eab40368eb122491530ac4233021925d` |

The npm registry's candidate manifest pins every optional platform package to
0.3.287. Its SDK tarball integrity is
`sha512-DrYUMzmSVfL1VciNDo/9BhxiVnTsSCKVzxLHB3+NvvRiyN4pfWTKFrUzQesPnWswds9x1Ir10Gi6GRsnjT0UkA==`.

All runtime runs used Linux user/network namespaces with only loopback enabled:
`unshare --user --map-root-user --net sh -c 'ip link set lo up && …'`.
The real CLI spoke to the scripted loopback Messages API. Homes and config
directories were temporary, credentials were bogus, and external inference
could not be reached. The production profile explicitly selected API billing
with the fixture credential. This is no paid or real-model measurement.

## Full raw-probe results

The observation-bearing full runs finished at 17:26:13Z UTC. Each case required
the scripted planned call to be sent, the CLI to emit that call, every
registered hook to fire for its tool-use id, and a successful terminal turn.
Every case met those premises; none was inconclusive.

| Case | Retained | Candidate |
| --- | --- | --- |
| classifier-bypass | pass | pass |
| classifier-not-a-bypass | pass | fail |
| toolsearch-bypass | pass | pass |
| settings-hook-allow-bypass | pass | pass |
| permissions-allow-not-a-bypass | pass | fail |
| bypass-mode-not-a-bypass | pass | pass |
| rewrite-without-decision | pass | fail |
| ask-keeps-rewrite | pass | pass |
| parallel-rewrites-last-wins | pass | pass |
| inprocess-deny-beats-settings-allow | pass | pass |
| pretooluse-awaited-when-allowlisted | pass | pass |
| d44-always-load-reaches-the-model | pass | pass |

All five credential rows passed on both pairs: OAuth only, API key only, both
through the raw CLI, neither, and both through the production backend. Every
credentialed row recorded nonempty request headers. The neither row recorded
no inference request and the not-logged-in ending. The full retained run exited
0; the full candidate run exited 1 for exactly the three permission cases.

### Selected calls and controls

Every row below sent and emitted one nonempty `Bash` call with id
`toolu_probe_1`. Every row had one nonempty tool result. `marker`, `a`, and `b`
were distinct paths inside that row's fresh scratch working directory. The
rewritten arm's hook fired once with the original `touch a` input.

| Case / arm | Planned input | Retained callback count / file effects | Candidate callback count / file effects |
| --- | --- | --- | --- |
| classifier / deny | `touch marker` | 1; no marker; named callback denial | 0; marker created; successful result |
| classifier / allow | `touch marker` | 1; marker created | 0; marker created |
| settings allow / deny | `touch marker` | 1; no marker; named callback denial | 0; marker created; successful result |
| settings allow / allow | `touch marker` | 1; marker created | 0; marker created |
| rewrite / rewritten | `touch a`, hook rewrites to `touch b` | 1, sees `touch b`; only b created | 0; only b created |
| rewrite / control | `touch a`, no hook | 1, sees `touch a`; only a created | 0; only a created |

The settings-allow arms loaded `permissions.allow: ["Bash(touch:*)", "Bash"]`.
The deny callback's distinctive result was `probe-callback-denied`. The
candidate's rewrite applied correctly; its failure was the missing callback,
not a lost rewrite. Its control ran, so an absent tool definition, failed
inference or inability to touch the file cannot explain that verdict.

## Upstream change and diagnostic control

Anthropic's [SDK changelog at the inspected commit](https://github.com/anthropics/claude-agent-sdk-typescript/blob/36836f000b931056f7de6471bcc90b31d658d4e9/CHANGELOG.md#03286)
documents a change in 0.3.286: an omitted mode is now resolved by the CLI.
Project defaults may apply, and third-party endpoints or disabled telemetry
can select auto mode. It recommends explicit `default` for manual approvals.
The 0.3.287 entry confirms parity with CLI 2.1.287. The installed sources agree:
the retained query assigns a default unless its internal CLI-resolution option
is enabled; the candidate passes the omitted value through. Both add
`--permission-mode` only when a value exists. These are the shipped SDK sources,
not a guessed option shape or a version inferred from a different package.

Anthropic's [permission documentation](https://platform.claude.com/docs/en/agent-sdk/permissions)
also describes the omitted-mode change and places hooks before mode/allow
resolution and the callback. A callback alone is not an every-call boundary.

On the candidate pair, the existing three selected cases run with the new
diagnostic `--permission-mode default` flag all passed at 17:27:18Z UTC.
Their planned calls, hook firings, callback counts and file effects matched
the retained column above. All five credential rows still passed. This is
evidence that the changed omission semantics explain these observations;
it does not isolate every CLI-internal classification rule. The flag affects
raw permission cases only and never changes production backend options.

## Production authorization boundary

The property under test is: with `enforceAllowedTools: true`, a `Bash` call
outside the turn's roster cannot execute unless the host bridge grants that
call, including when settings or a rewrite could otherwise auto-approve it.
The backend builds the actual turn options and production permission handlers
(`createClaudeSdkTurn`, `packages/ui-backend-claude/src/sdk-options.ts:55-160`).
The explicit ask lives in
(`enforcementHook`, `packages/ui-backend-claude/src/permission-hooks.ts:106-129`)
and is registered under enforcement in
(`...(enforced ?`, `packages/ui-backend-claude/src/permission-hooks.ts:399-402`).

`scripts/measure-claude-enforcement.ts` runs `createClaudeBackend().startTurn()`
and forwards to the SDK resolved from that backend. Its query wrapper only
records the production hooks, callback outputs and actual CLI stream; it
preserves registration order, matchers, inputs and outputs. No replacement
policy or helper that simulates runtime permission precedence is used.
The controlled RTK executable supplies an input rewrite through the actual
production RTK subprocess hook. Other scenarios make that oracle decline.

Each pair ran all four scenarios with three independent arms. The denied and
approved arms used an empty roster; the allowlisted arm included `Bash`.
The bridge denied in the first arm and granted the exact request input in the
second. The allowlisted control's denying bridge was never reached.

| Scenario | Denied arm, both pairs | Approved arm, both pairs | Allowlisted control, both pairs |
| --- | --- | --- | --- |
| plain `touch original` | ask; 1 callback and bridge request; no write | ask; 1 callback and bridge grant; original created | no callback/request; original created |
| project permissions.allow | ask; 1 callback and bridge request; no write | ask; 1 callback and bridge grant; original created | no callback/request; original created |
| project hook returns allow | settings hook witnessed; ask; 1 callback/request; no write | settings hook witnessed; ask; 1 callback/grant; original created | settings hook witnessed; no callback/request; original created |
| production RTK rewrite to `touch rewritten` | rewrite recorded without allow; ask; callback/request see rewritten input; neither file created | rewrite recorded without allow; ask; callback/grant see rewritten input; only rewritten created | only rewritten created; no callback/request |

All 24 turns passed, sent/emitted their planned call, recorded all three
matching production hooks, returned nonempty tool results, and completed
successfully. Every outside-roster request carried
`outsideEnforcedAllowlist: true` and the planned tool-use id. Every denial
returned `production-probe-denied`. Production options omitted the mode on
both pairs; hook inputs reported `default` on retained and `auto` on candidate.
These observations establish the boundary for these cases despite that change.

As a mutation, the candidate copy omitted only the production enforcement
hook registration. All eight outside-roster arms failed the specific
ask/callback/bridge requirement. The four denied writes executed without any
callback and created their intended file; all four allowlisted controls passed.
The remaining two matching hooks fired, the planned calls and results were
nonempty, and the CLI loaded successfully. Restoring the hook returned all
twelve arms to pass. CI now runs this production probe after the existing full
raw probe, in a loopback-only namespace.

## Limits and recommendation

This establishes neither real-model classifier decisions nor first-party URL
auto-mode behavior, classifier traffic, model choice, latency, general shell
safety, every tool, subagent, resume or no-grant-surface posture. It does not
audit blocked background connection attempts. Hook observations are narrower
than proving how every internal permission branch reaches its decision.

The affected retained-runtime claims are the command-shape comparison and
settings-rule paragraph beside `enforcementHook`, the rewrite callback claim
in the existing raw probe, and the permission discussion in
`docs/extending/agent-backends.md`. They remain measured claims about the
retained pair, not promises about arbitrary future versions. The production
explicit-ask claim and the updated-input application survived the tested
candidate comparison; a production escape was not observed.

Keep the retained measured pair and the existing declared caret requirement
unchanged. Before an upgrade, make the mode choice explicit in its scoped
ruling: either preserve manual-approval semantics with an explicit mode or
define and measure the intentionally different mode semantics. Re-run the
**full** network-isolated raw and production probes on that implementation,
including the credential rows and exact loaded/executed identity, before
changing measured constants. Passing these three selected default-mode
controls alone is insufficient. No production-policy repair is proposed by
this measurement because the tested enforcement property held.

## Reproduction

In each isolated environment, run:

```sh
unshare --user --map-root-user --net sh -c 'ip link set lo up && bun scripts/measure-claude-runtime.ts --observations --out raw.json'
unshare --user --map-root-user --net sh -c 'ip link set lo up && bun scripts/measure-claude-enforcement.ts --out production.json'
unshare --user --map-root-user --net sh -c 'ip link set lo up && bun scripts/measure-claude-runtime.ts --permission-mode default --only classifier-not-a-bypass,permissions-allow-not-a-bypass,rewrite-without-decision --observations --out default-control.json'
```

Use a separate source/dependency copy for the candidate, preserving the original
lockfile except for its exact SDK resolution. Inspect `agentSdk` and every
CLI init observation, rather than treating an installation command as proof
of what the backend loaded. Raw observations include temporary scratch paths;
the production report replaces its scratch root before writing. Screen reports
before publishing them. The default full CI probe has no diagnostic mode flag.
