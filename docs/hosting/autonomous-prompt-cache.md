# Restricted autonomous prompt and optional cache measurement

Restricted Claude turns use package-owned instructions with a deliberate `v1`
version and sorted, deduplicated server-approved tool membership. Changing
instruction semantics requires changing that version; changing membership changes
the prefix bytes. No arrival, model output, policy file, client device or project
instruction participates in that prefix. Permission enforcement and containment
remain the shared worker/permission boundary, independent of prompt text.

The installed SDK's `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` terminates the custom
system prefix. The server's `systemPromptAppend` for a restricted turn becomes
turn context in the user message, before the item prompt. Item state, decision,
capability, remaining budget and attempt metadata belong there. Interactive and
nonrestricted nonpersistent turns keep their existing preset/append behavior.
The custom prompt needs no preset `excludeDynamicSections`: that option only
applies to presets. The restricted envelope still disables ambient setting
sources and project MCP configuration, keeps the credential in the relay and
refuses unsupported hosts. It does not enable the production dispatcher (#689).

## Selected runtime facts

The keyless fixture probe uses the lockfile's Claude Agent SDK 0.3.293 and its
bundled CLI 2.1.293, with the API-billed `claude-sonnet-4-6` profile through the
restricted inference relay. It records actual tool/system/message JSON. At the
relay's local origin, the CLI coalesces a custom prompt's static and dynamic
system sections into one cache-marked block even when the SDK boundary marker
is supplied. Therefore all dynamic turn context lives in the user message.
The resulting system block has `cache_control: {"type":"ephemeral"}` (no
explicit TTL or global scope field); the marker itself is consumed. The complete
tool/system prefix is identical across changed cwd, Git state and item context.
This establishes request assembly, not provider cache hits or savings.

As checked on 2026-10-10, the [Anthropic cache documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
reports a default five-minute lifetime and optional one-hour lifetime. For the
fixture's Sonnet 4.6 model it reports a 1,024-token minimum; for the built-in
Opus 5.5 model it reports 512. These are selected-model facts, not universal
thresholds. API caches are isolated by workspace within an organization. Other
platforms/proxies and subscription credentials require their own verification;
a local fixture does not establish their cache identity or accepted TTL. The
SDK's settings types expose `promptCacheTtl` and `subagentPromptCacheTtl`; neither is
set by this feature. The relay narrows credential exposure and routes, but does
not change the upstream account/workspace. No padding is added to reach a cache
minimum. Cache savings remain unclaimed.

## Opt-in measurement procedure

A measurement needs separate authorization naming the provider, model,
credential/billing audience, maximum turns and spend, idle durations and permitted
receipt storage. Use a disposable Odysseus brain and the restricted production
turn path. Do not put credentials, provider request payloads or real content in a
public receipt. Keyless CI must never select this procedure.

1. Record the installed SDK and bundled CLI versions, brain-kit SHA, instruction
   version, hashes of the actual tool/system bytes, selected upstream and model,
   billing mode and sanitized account/workspace scope. Re-check the provider's
   current cache documentation for that exact model/platform, its minimum and
   supported TTL. Record the emitted `cache_control` fields, not just SDK options.
2. For **each** call, use `createInboxBudget(...).claim(...)` with the agreed
   maximum input/output/cache-read/cache-creation tokens, then invoke
   `runAutonomousTurn` with that admitted run's turn/principal, exact approved
   roster, server context and signal. Refusal means stop. Reuse the provider,
   credential scope, model, tool schemas and trusted prefix; vary only per-item
   context. The existing activity recorder settles each physical request through
   the budget meter. Do not call the provider or SDK outside this admission path.
3. Run two turns consecutively, waiting for the first response to finish. Run a
   third after the authorized idle interval within the observed TTL and a fourth
   after the authorized interval beyond it. Keep the actual elapsed durations.
   Do not pin one-hour settings or inject cache flags without authorization for
   the potentially different write price and verification of upstream support.
4. For every physical inference request, retain sanitized cache-read and
   cache-creation usage, uncached input/output usage, settled cost (including
   unknown/unpriced status), run IDs, elapsed times and the actual prefix hash.
   Report consecutive and idle-separated results separately. A zero cache-read
   count is a result, not permission to pad the instructions or spend more.
5. Compare prefix equality before calculating any hit ratio. Record the
   selected-model minimum and actual cacheable token count if the provider makes
   it available. Only a successful authorized receipt supports a savings claim;
   fixture-reported zero usage and SDK type declarations never do.

Executable keyless assembly proof:

```sh
bun run test packages/ui-backend-claude/tests/autonomous-prompt.test.ts
```

The fixture endpoint emits zero cache-read/cache-creation usage intentionally.
No live-provider measurement has been performed for this change.
