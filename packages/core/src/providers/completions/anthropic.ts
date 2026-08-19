/**
 * Anthropic completion provider — built-in CompletionProvider.
 *
 * Plain completions via a direct fetch to the Messages API (no SDK
 * dependency). Call shape derived from whatsup's Anthropic backend, extended
 * with multimodal content blocks and configurable max_tokens.
 */

import { readEnvVar } from "../../config/env.js";
import type { CompletionProvider, ContentPart } from "../../lib/seams.js";
import { withRetry } from "../../lib/llm-util.js";
import { CLAUDE_FAST_MODEL } from "../../lib/llm-defaults.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 1024;

export interface AnthropicCompletionConfig {
  /** Model id (default: claude-haiku-4-5-20251001). */
  model?: string;
  /** Env var holding the API key (default: ANTHROPIC_API_KEY). */
  apiKeyEnv?: string;
  /** Default max_tokens when a request omits maxTokens (default: 1024). */
  maxTokens?: number;
}

/** Convert a neutral ContentPart to an Anthropic content block. */
function toAnthropicBlock(part: ContentPart): Record<string, unknown> {
  switch (part.kind) {
    case "text":
      return { type: "text", text: part.text };
    case "image":
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: part.mimeType,
          data: Buffer.from(part.data).toString("base64"),
        },
      };
    case "pdf":
      return {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: Buffer.from(part.data).toString("base64"),
        },
      };
  }
}

/**
 * Create an Anthropic-backed CompletionProvider. Constructing it makes no
 * network call; the key is read on first complete().
 */
export function anthropicCompletions(config: AnthropicCompletionConfig = {}): CompletionProvider {
  const model = config.model ?? CLAUDE_FAST_MODEL;
  const apiKeyEnv = config.apiKeyEnv ?? "ANTHROPIC_API_KEY";
  const defaultMaxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;

  async function complete(req: {
    system?: string;
    prompt: string;
    parts?: ContentPart[];
    maxTokens?: number;
  }): Promise<string> {
    const apiKey = readEnvVar(apiKeyEnv);
    if (!apiKey) {
      throw new Error(`${apiKeyEnv} environment variable is required for Anthropic completions`);
    }

    // Media blocks precede the prompt text (context before instruction).
    const content = [
      ...(req.parts ?? []).map(toAnthropicBlock),
      { type: "text", text: req.prompt },
    ];

    const body: Record<string, unknown> = {
      model,
      max_tokens: req.maxTokens ?? defaultMaxTokens,
      messages: [{ role: "user", content }],
    };
    if (req.system) body.system = req.system;

    const data = await withRetry(async () => {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        // Attach status so withRetry's classifier can distinguish
        // rate-limit / transient / fatal.
        const err = new Error(`Anthropic API error ${res.status}: ${text}`) as Error & {
          status?: number;
        };
        err.status = res.status;
        throw err;
      }

      return (await res.json()) as { content: Array<{ type: string; text?: string }> };
    });

    return data.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");
  }

  return {
    id: `anthropic:${model}`,
    capabilities: { vision: true },
    complete,
  };
}
