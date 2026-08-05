# Extending: completions

The `CompletionProvider` seam is plain (non-agentic) LLM completion. Core uses it
for enrichment (chunk contexts and asset descriptions), note processing, and
briefings — the text-in, text-out work that does not need a full coding agent.

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

1. **Implement `CompletionProvider`:**

   ```ts
   // my-completions.ts
   import type { CompletionProvider } from "@schlessera/brain";

   export function myCompletions(): CompletionProvider {
     return {
       id: "mine:some-model",
       capabilities: { vision: false },
       async complete({ system, prompt, parts, maxTokens }) {
         /* call your API, return the text */
       },
     };
   }
   ```

2. **Reference it by value:**

   ```ts
   import { myCompletions } from "./my-completions";

   export default defineConfig({
     completions: { provider: myCompletions(), fallback: "gemini-flash" },
   });
   ```

3. **(Optional) publish** as `brain-completions-<vendor>`.

## Capability and degradation notes

- **`capabilities.vision: false`** → enrichment degrades to **title-only asset
  descriptions** instead of describing image or PDF contents. Everything else
  works.
- **No completion provider reachable** (missing key, network) → enrichment,
  note-processing, and LLM briefings are skipped; mechanical features (`brain
  briefing`'s deadline/review scanning, heuristic classification) still run.
  This is why Tier 0 works with no keys at all.
- **`parts` are additive.** Providers that ignore `parts` still satisfy the
  interface; they just won't use multimodal input.

## See also

- [embeddings.md](embeddings.md) — the other half of the enrichment pipeline.
- [agent-runners.md](agent-runners.md) — for agentic, tool-using flows.
- [README.md](README.md) — the seam meta-mechanism and degradation model.
- [../configuration.md](../configuration.md#completions) — the `completions` config key.
