/**
 * Provider adapters for the triage eval.
 *
 * Every model is driven by a raw API call with the same prompt, the same
 * batching and the same parsing. Nothing runs through an agent harness (no Agent
 * SDK, no Codex CLI): a harness contributes its own system prompt and loop, which
 * would measure the harness rather than the model and would not be comparable
 * across vendors.
 *
 * Adding an endpoint is a config entry here, not a code change elsewhere.
 */

export type Provider = "anthropic" | "openai" | "gemini" | "openrouter";

export interface ModelSpec {
  /** Provider-native model id. */
  id: string;
  label: string;
  provider: Provider;
  /** USD per million tokens, list price, for the cost column. */
  inPerMTok: number;
  outPerMTok: number;
  /** Effort levels this endpoint accepts. Probed live, not assumed — see README. */
  efforts: (string | null)[];
  /**
   * OpenRouter only: pin serving backends, most preferred first, with fallbacks
   * disabled.
   *
   * OpenRouter load-balances a model across many backends that differ in
   * quantization and serving config, so an unpinned model is a DISTRIBUTION,
   * not a system under test — one measurement can be spread over five vendors
   * and is not reproducible. Pinning makes a benchmark row mean something. A
   * pinned backend at capacity surfaces as a transport error, which is the
   * honest failure: better a visible gap than a silent substitution.
   */
  providerOrder?: string[];
}

export interface CallResult {
  text: string;
  inTokens: number;
  outTokens: number;
  ms: number;
  /** Backend that served the call, where the gateway reports one. */
  servedBy?: string;
}

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set — required for this provider`);
  return v;
};

/** Thrown when the endpoint rejects the effort level rather than the request. */
export class UnsupportedEffortError extends Error {}

function classify(message: string): never {
  if (/not support|Unsupported|Invalid value|mandatory/i.test(message)) {
    throw new UnsupportedEffortError(message);
  }
  throw new Error(message);
}

async function callAnthropic(m: ModelSpec, effort: string | null, system: string, user: string): Promise<CallResult> {
  const body: Record<string, unknown> = {
    model: m.id,
    // Generous: on models where thinking is always on, thinking tokens count
    // against this budget, and a truncated response loses the whole batch. A
    // 2000 ceiling silently cost one such model 25-30 rows before this was
    // raised, which scored as a model failure and was not one.
    max_tokens: 8000,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
  };
  if (effort) body.output_config = { effort };
  const t0 = Date.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env("ANTHROPIC_API_KEY"),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const j = (await res.json()) as Record<string, any>;
  if (j.error) classify(String(j.error.message ?? j.error));
  const text = (j.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
  return {
    text,
    ms: Date.now() - t0,
    inTokens: (j.usage?.input_tokens ?? 0) + (j.usage?.cache_read_input_tokens ?? 0) +
      (j.usage?.cache_creation_input_tokens ?? 0),
    outTokens: j.usage?.output_tokens ?? 0,
  };
}

async function callChatCompletions(
  m: ModelSpec, effort: string | null, system: string, user: string,
  url: string, key: string, effortShape: "openai" | "openrouter"
): Promise<CallResult> {
  const body: Record<string, unknown> = {
    model: m.id,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  };
  if (effortShape === "openrouter" && m.providerOrder?.length) {
    body.provider = { order: m.providerOrder, allow_fallbacks: false };
  }
  if (effortShape === "openai") {
    body.max_completion_tokens = 8000;
    if (effort) body.reasoning_effort = effort;
  } else {
    body.max_tokens = 8000;
    if (effort) body.reasoning = { effort };
  }
  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = (await res.json()) as Record<string, any>;
  if (j.error) classify(String(j.error.message ?? j.error));
  return {
    text: j.choices?.[0]?.message?.content ?? "",
    ms: Date.now() - t0,
    inTokens: j.usage?.prompt_tokens ?? 0,
    // completion_tokens already includes reasoning tokens, and both are billed.
    outTokens: j.usage?.completion_tokens ?? 0,
    servedBy: typeof j.provider === "string" ? j.provider : undefined,
  };
}

async function callGemini(m: ModelSpec, effort: string | null, system: string, user: string): Promise<CallResult> {
  const t0 = Date.now();
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${m.id}:generateContent?key=${env("GEMINI_API_KEY")}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          maxOutputTokens: 8000,
          ...(effort ? { thinkingConfig: { thinkingLevel: effort } } : {}),
        },
      }),
    }
  );
  const j = (await res.json()) as Record<string, any>;
  if (j.error) classify(String(j.error.message ?? j.error));
  const parts = j.candidates?.[0]?.content?.parts ?? [];
  const u = j.usageMetadata ?? {};
  return {
    text: parts.map((p: any) => p.text ?? "").join(""),
    ms: Date.now() - t0,
    inTokens: u.promptTokenCount ?? 0,
    // Thinking tokens bill as output on Gemini — count them.
    outTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
  };
}

export async function callModel(
  m: ModelSpec, effort: string | null, system: string, user: string
): Promise<CallResult> {
  switch (m.provider) {
    case "anthropic":
      return callAnthropic(m, effort, system, user);
    case "openai":
      return callChatCompletions(m, effort, system, user,
        "https://api.openai.com/v1/chat/completions", env("OPENAI_API_KEY"), "openai");
    case "openrouter":
      return callChatCompletions(m, effort, system, user,
        "https://openrouter.ai/api/v1/chat/completions", env("OPENROUTER_API_KEY"), "openrouter");
    case "gemini":
      return callGemini(m, effort, system, user);
  }
}

/**
 * Retry transient failures instead of scoring them.
 *
 * A prototype counted any thrown request as a batch of item failures. Running
 * several configs concurrently against one provider then produced rate limits
 * that surfaced as "8 schema failures, 4 missed escalations" and were attributed
 * to the model. A dropped batch is worth a whole batch of item scores, so one
 * transient error visibly moves a result.
 */
export async function callWithRetry(
  m: ModelSpec, effort: string | null, system: string, user: string, tries = 4
): Promise<CallResult> {
  let last: Error | undefined;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await callModel(m, effort, system, user);
    } catch (err) {
      if (err instanceof UnsupportedEffortError) throw err;
      last = err as Error;
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
    }
  }
  throw last ?? new Error("unknown provider failure");
}

/**
 * The candidate roster. Effort ladders were probed against each live endpoint;
 * a level absent here was rejected by that provider (see README).
 */
export const MODELS: ModelSpec[] = [
  { id: "claude-haiku-4-5", label: "haiku-4.5", provider: "anthropic", inPerMTok: 1, outPerMTok: 5, efforts: [null] },
  { id: "claude-sonnet-4-6", label: "sonnet-4.6", provider: "anthropic", inPerMTok: 3, outPerMTok: 15, efforts: ["low", "medium", "high"] },
  { id: "claude-sonnet-5", label: "sonnet-5", provider: "anthropic", inPerMTok: 3, outPerMTok: 15, efforts: ["low", "medium", "high"] },
  // The #848 baseline (maintainer ruling on #838, 2026-10-07). Rates as in
  // scripts/measure-sonnet55-cost.ts; the effort ladder is Sonnet 5's and has
  // not been probed against this model yet.
  { id: "claude-sonnet-5-5", label: "sonnet-5.5", provider: "anthropic", inPerMTok: 2, outPerMTok: 10, efforts: ["low", "medium", "high"] },
  { id: "claude-opus-5", label: "opus-5", provider: "anthropic", inPerMTok: 5, outPerMTok: 25, efforts: ["low", "medium", "high"] },
  { id: "gpt-5.6-luna", label: "gpt-5.6-luna", provider: "openai", inPerMTok: 0.2, outPerMTok: 1.2, efforts: ["none", "low", "medium", "high", "xhigh"] },
  { id: "gpt-5.6-terra", label: "gpt-5.6-terra", provider: "openai", inPerMTok: 2, outPerMTok: 12, efforts: ["none", "low", "medium", "high", "xhigh"] },
  { id: "gpt-5.6-sol", label: "gpt-5.6-sol", provider: "openai", inPerMTok: 4, outPerMTok: 20, efforts: ["low", "medium", "high"] },
  { id: "gemini-3.7-flash", label: "gemini-3.7-flash", provider: "gemini", inPerMTok: 0.75, outPerMTok: 3.75, efforts: ["low", "medium", "high"] },
  { id: "z-ai/glm-5.3-flash", label: "glm-5.3-flash", provider: "openrouter", inPerMTok: 0.075, outPerMTok: 0.25, efforts: ["minimal", "low", "medium", "high", "xhigh"], providerOrder: ["Z.AI"] },
];
