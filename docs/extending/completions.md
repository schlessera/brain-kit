# Extending: completions

The `CompletionProvider` seam is plain (non-agentic) LLM completion. Core uses it
for enrichment (chunk contexts and asset descriptions) and note processing —
the text-in, text-out work that does not need a full coding agent.
`brain briefing` itself is mechanical; `/whatsup` adds an agent's interpretation.

## The interface

From `@schlessera/brain` (`src/lib/seams.ts`):

```ts
export type ContentPart =
  | { kind: "text"; text: string }
  | { kind: "image"; data: Uint8Array; mimeType: string }
  | { kind: "pdf"; data: Uint8Array };

export interface CompletionProvider {
  id: string;
  capabilities: { vision: boolean };
  complete(req: {
    system?: string;
    prompt: string;
    parts?: ContentPart[];
    maxTokens?: number;
  }): Promise<string>;
}
```

`complete` takes an optional system prompt, a user prompt, optional multimodal
`parts`, and an optional token cap, and returns text. `capabilities.vision`
declares whether the provider can look at image/PDF parts.

## Built-ins

| Name              | Model                        | Key                  | Vision |
| ----------------- | ---------------------------- | -------------------- | ------ |
| `gemini-flash`    | `gemini-3-flash-preview`     | `GEMINI_API_KEY`     | yes    |
| `anthropic-haiku` | `claude-haiku-4-5-20251001`  | `ANTHROPIC_API_KEY`  | yes    |

`gemini-flash` is the default when `completions` is omitted.

```ts
completions: { provider: "gemini-flash", fallback: "anthropic-haiku" }
```

### Fallback

A configured `fallback` wraps the primary: `complete` tries the primary and, on
any error, retries with the fallback. The wrapper advertises the **primary's**
capabilities, so pair it with a fallback that is at least as capable (e.g. don't
fall back from a vision model to a text-only one if you rely on vision).

## Add your own (≤3 steps)

1. **Implement `CompletionProvider`.** This sketch throws until you implement
   the provider call and return its text:

   ```ts
   // my-completions.ts
   import type { CompletionProvider } from "@schlessera/brain";

   export function myCompletions(): CompletionProvider {
     return {
       id: "mine:some-model",
       capabilities: { vision: false },
       async complete({ system, prompt, parts, maxTokens }) {
         throw new Error("Implement the provider call and return its text");
       },
     };
   }
   ```

2. **Reference it by value:**

   ```ts
   import { defineConfig } from "@schlessera/brain";
   import { myCompletions } from "./my-completions";

   export default defineConfig({
     completions: { provider: myCompletions(), fallback: "gemini-flash" },
   });
   ```

3. **(Optional) publish** as `brain-completions-<vendor>`.

## Test it against the contract

`@schlessera/brain/testing` exports `runCompletionProviderContract`, the suite
`gemini-flash` and `anthropic-haiku` run in
`packages/core/tests/seam-contracts.test.ts`. It asserts that `complete`
resolves to the model's answer with or without `system`, `maxTokens` and
`parts`, and that `capabilities.vision` is honest about what core does with
it: with `false`, asset enrichment returns `null` without calling `complete`.
Empty/whitespace replies also produce `null`, while a non-empty reply may
equal the title. Give it a provider whose fake model answers with the text it
is handed:

```ts
import { describe, expect, test } from "bun:test";
import { runCompletionProviderContract } from "@schlessera/brain/testing";

runCompletionProviderContract(
  { name: "mine", answering: (text) => myCompletions({ fetch: fakeVendorAnswering(text) }) },
  { describe, expect, test }
);
```

`fakeVendorAnswering` stands for however your provider reaches its vendor in
a test: an injected `fetch`, a local stub server. The suite never needs a key.

## Capability and degradation notes

- **`capabilities.vision: false`** → `describeAsset` returns `null` without a
  completion call. The indexer retains the asset's placeholder and searchable
  title, omits it from description caches and embeddings, and retries on a
  later `--embeddings` run. Empty/whitespace model output has the same result.
- **No completion provider reachable** (missing key, network) → enrichment
  and note-processing use their degraded paths; mechanical features (`brain
  briefing`'s deadline/review scanning, heuristic classification) still run.
  This is why Tier 0 works with no keys at all.
- **`parts` are additive.** Providers that ignore `parts` still satisfy the
  interface; they just won't use multimodal input.

## Migrating asset enrichment

**Approved pre-1.0 breaking change (#411):** the exported `Enrichment` type's
`describeAsset(buffer, mimeType, context)` returns `Promise<string | null>`.
`createEnrichment` no longer substitutes the title when it cannot produce a
description. Completion providers still return `Promise<string>` from
`complete`; `generateChunkContext` is unchanged.

Callers must handle `null` before storing or embedding a description:

```ts
const description = await enrichment.describeAsset(bytes, mimeType, title);
if (description !== null) {
  await saveDescription(description);
}
```

Custom `Enrichment` implementations return `null` for an undescribed asset
and a non-empty string for success. Implementations that always succeed may
keep their narrower `Promise<string>` return type. Preserve thrown errors as
errors; the indexer continues to warn and retry. Do not use title equality to
decide whether a non-empty answer is real, and do not infer a particular
failure cause from `null`.

Run the updated `runCompletionProviderContract` suite with your fake runtime;
its no-vision assertions now expect `null` and zero completion calls.
This prevents new title fallback entries. Existing descriptions remain valid
cache inputs; see [targeted cache regeneration](../concepts.md#sidecar-caches)
for historical entries you have identified as bad.

## See also

- [embeddings.md](embeddings.md) — the other half of the enrichment pipeline.
- [agent-runners.md](agent-runners.md) — for agentic, tool-using flows.
- [README.md](README.md) — the seam meta-mechanism and degradation model.
- [../configuration.md](../configuration.md#completions) — the `completions` config key.
