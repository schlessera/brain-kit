/**
 * Provider request-shaping and response-decoding, with `fetch` stubbed.
 *
 * No network: these assert the exact wire shape each vendor documents, because
 * that is where a silent mistake lives — a header in the wrong place, a mask
 * sent as JSON, or a refusal read as success.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { geminiProvider } from "../src/providers/gemini";
import { openAiCostFromUsage, openaiProvider } from "../src/providers/openai";
import { ImageProviderError, type ImageInput } from "../src/types";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** One-shot fetch stub that records what it was called with. */
function stub(response: unknown, init: { status?: number } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, reqInit?: RequestInit) => {
    calls.push({ url: String(url), init: reqInit ?? {} });
    return new Response(JSON.stringify(response), {
      status: init.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

const SUNBURST = "gpt-image-2.5-sunburst";
const FLARE = "gpt-image-2.5-flare";
const PNG_B64 = Buffer.from("fake-png-bytes").toString("base64");
const ref = (): ImageInput => ({ data: new Uint8Array([1, 2, 3]), mime: "image/png", label: "a.png" });

/**
 * The capability tables are also copy: `brain image models` prints `summary`
 * verbatim, and the skill teaches from it. Both claims guarded here were shipped
 * once, sourced from vendor documentation, and retracted in `evidence.ts` when
 * the public arenas said the opposite. Routing was corrected; these strings and
 * flags were not, so they kept telling users the retracted version for a whole
 * release. That is what this block exists to prevent happening twice.
 */
describe("capability tables agree with the evidence", () => {
  const ALL = [...openaiProvider.models, ...geminiProvider.models];

  test("no summary re-asserts a retracted claim", () => {
    for (const m of ALL) {
      // "Gemini renders text better" — backwards; gpt-image-2 leads the
      // dedicated text-rendering board by ~130-155 Elo.
      if (m.provider === "gemini") expect(m.summary).not.toMatch(/text render/i);
      // "Gemini keeps characters consistent" — no independent benchmark exists
      // and Google's own card is a tie inside the error bars, so a summary may
      // state the documented ceiling but never claim it as a win.
      expect(m.summary).not.toMatch(/consistency/i);
    }
  });

  test("no model inherits the text-rendering lead measured on retired gpt-image-2", () => {
    // The arena lead was measured on gpt-image-2. A successor's name is not a
    // measurement, so no 2.5 model — and no Gemini model — claims it.
    expect(ALL.filter((m) => m.strongTextRendering).map((m) => m.id)).toEqual([]);
  });

  test("no summary claims the retired transparency split", () => {
    for (const m of ALL) expect(m.summary).not.toMatch(/gpt-image-1\.5|gpt-image-2\b(?!\.)/);
  });

  test("the 2.5 models carry no borrowed per-image price", () => {
    // Billed per token, and OpenAI's calculator does not estimate 2.5 token
    // use: the retired per-image table must not stand in for them.
    for (const m of openaiProvider.models) expect(m.approxCostUsd1K).toBeNull();
  });
});

describe("openai provider", () => {
  test("generation posts JSON to /images/generations with a bearer token", async () => {
    const calls = stub({ data: [{ b64_json: PNG_B64 }], usage: { total_tokens: 10 } });
    const result = await openaiProvider.generate(
      SUNBURST,
      { prompt: "a cat", size: "1024x1024", quality: "high", format: "png" },
      "sk-test"
    );

    expect(calls[0].url).toBe("https://api.openai.com/v1/images/generations");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toMatchObject({ model: SUNBURST, prompt: "a cat", size: "1024x1024", quality: "high" });

    expect(result.images).toHaveLength(1);
    expect(Buffer.from(result.images[0].data).toString()).toBe("fake-png-bytes");
    expect(result.model).toBe(SUNBURST);
    // No usable usage in the reply: the cost is unknown, not a table lookup.
    expect(result.costUsd).toBeUndefined();
  });

  test("the cost comes from the reported token usage at the published rates", async () => {
    stub({
      data: [{ b64_json: PNG_B64 }],
      usage: { input_tokens: 100, output_tokens: 1000, input_tokens_details: { text_tokens: 60, image_tokens: 40 } },
    });
    const result = await openaiProvider.generate(FLARE, { prompt: "x" }, "k");
    // 60 text in at $5/M + 40 image in at $8/M + 1000 image out at $30/M.
    expect(result.costUsd).toBeCloseTo((60 * 5 + 40 * 8 + 1000 * 30) / 1_000_000, 10);
    expect(result.costIsEstimate).toBe(true);
    expect(openAiCostFromUsage(SUNBURST, { output_tokens: 1000 })).toBeUndefined();
    expect(openAiCostFromUsage("gpt-image-2", {
      output_tokens: 1, input_tokens_details: { text_tokens: 1, image_tokens: 0 },
    })).toBeUndefined();
  });

  for (const model of [SUNBURST, FLARE]) {
    for (const quality of ["xhigh", "max"] as const) {
      for (const format of ["png", "webp"] as const) {
        test(`${model} sends quality ${quality} and a transparent ${format} unchanged on generation`, async () => {
          const calls = stub({ data: [{ b64_json: PNG_B64 }] });
          const result = await openaiProvider.generate(
            model,
            { prompt: "a logo", quality, transparent: true, format },
            "k"
          );
          const body = JSON.parse(calls[0].init.body as string);
          expect(body.model).toBe(model);
          expect(body.quality).toBe(quality);
          expect(body.background).toBe("transparent");
          expect(body.output_format).toBe(format);
          expect(result.model).toBe(model);
        });

        test(`${model} sends quality ${quality} and a transparent ${format} unchanged on a masked edit`, async () => {
          const calls = stub({ data: [{ b64_json: PNG_B64 }] });
          await openaiProvider.generate(
            model,
            { prompt: "sky", quality, transparent: true, format, references: [ref()], mask: ref() },
            "k"
          );
          expect(calls[0].url).toBe("https://api.openai.com/v1/images/edits");
          const form = calls[0].init.body as FormData;
          expect(form.get("model")).toBe(model);
          expect(form.get("quality")).toBe(quality);
          expect(form.get("background")).toBe("transparent");
          expect(form.get("output_format")).toBe(format);
          expect(form.get("mask")).toBeInstanceOf(Blob);
        });
      }
    }
  }

  test("a transparent edit with no format asks for png explicitly", async () => {
    const calls = stub({ data: [{ b64_json: PNG_B64 }] });
    await openaiProvider.generate(FLARE, { prompt: "x", transparent: true, references: [ref()] }, "k");
    const form = calls[0].init.body as FormData;
    expect(form.get("output_format")).toBe("png");
    expect(form.get("background")).toBe("transparent");
  });

  test("a custom size is sent as exact pixels", async () => {
    const calls = stub({ data: [{ b64_json: PNG_B64 }] });
    await openaiProvider.generate(FLARE, { prompt: "x", size: "1360x768", transparent: true }, "k");
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({ size: "1360x768", background: "transparent" });
  });

  for (const retired of ["gpt-image-2", "gpt-image-1.5"]) {
    test(`retired ${retired} is refused before any request`, async () => {
      const calls = stub({ data: [{ b64_json: PNG_B64 }] });
      await expect(openaiProvider.generate(retired, { prompt: "x" }, "k")).rejects.toThrow(/retired/);
      expect(calls).toHaveLength(0);
    });
  }

  test("a transparent JPEG is refused before any request", async () => {
    const calls = stub({ data: [{ b64_json: PNG_B64 }] });
    await expect(
      openaiProvider.generate(SUNBURST, { prompt: "x", transparent: true, format: "jpeg" }, "k")
    ).rejects.toThrow(/alpha/);
    expect(calls).toHaveLength(0);
  });

  test("`auto` size is omitted rather than sent literally", async () => {
    const calls = stub({ data: [{ b64_json: PNG_B64 }] });
    await openaiProvider.generate(SUNBURST, { prompt: "x", size: "auto" }, "k");
    expect(JSON.parse(calls[0].init.body as string).size).toBeUndefined();
  });

  test("references switch it to multipart /images/edits", async () => {
    const calls = stub({ data: [{ b64_json: PNG_B64 }] });
    await openaiProvider.generate(FLARE, { prompt: "edit it", references: [ref()] }, "k");

    expect(calls[0].url).toBe("https://api.openai.com/v1/images/edits");
    const body = calls[0].init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("model")).toBe(FLARE);
    // Reference images repeat under `image[]`, which is the documented field.
    expect(body.getAll("image[]")).toHaveLength(1);
    // Content-Type must NOT be set by hand — fetch adds the multipart boundary.
    expect((calls[0].init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  test("a mask rides along as a PNG part", async () => {
    const calls = stub({ data: [{ b64_json: PNG_B64 }] });
    await openaiProvider.generate(
      SUNBURST,
      { prompt: "sky", references: [ref()], mask: ref() },
      "k"
    );
    const body = calls[0].init.body as FormData;
    expect(body.get("mask")).toBeInstanceOf(Blob);
  });

  test("a billing 429 is reported as not retryable", async () => {
    stub({ error: { message: "quota", code: "insufficient_quota" } }, { status: 429 });
    try {
      await openaiProvider.generate(SUNBURST, { prompt: "x" }, "k");
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as ImageProviderError;
      expect(err.opts.retryable).toBe(false);
      expect(err.message).toMatch(/retrying will not help/);
    }
  });

  test("a rate-limit 429 is reported as retryable", async () => {
    stub({ error: { message: "slow down", code: "rate_limit_exceeded" } }, { status: 429 });
    await expect(openaiProvider.generate(SUNBURST, { prompt: "x" }, "k")).rejects.toMatchObject({
      opts: { retryable: true },
    });
  });

  test("a moderation refusal names itself", async () => {
    stub(
      { error: { message: "blocked", code: "moderation_blocked", moderation_details: { stage: "prompt" } } },
      { status: 400 }
    );
    await expect(openaiProvider.generate(SUNBURST, { prompt: "x" }, "k")).rejects.toThrow(
      /refused by moderation/
    );
  });

  test("an empty data array is an error, not an empty file", async () => {
    stub({ data: [] });
    await expect(openaiProvider.generate(SUNBURST, { prompt: "x" }, "k")).rejects.toThrow(
      /no image data/
    );
  });
});

describe("gemini provider", () => {
  test("posts to /interactions with the key in a header, not the query string", async () => {
    const calls = stub({
      status: "completed",
      output_image: { data: PNG_B64, mime_type: "image/png" },
      usage: { total_tokens: 5 },
    });
    const result = await geminiProvider.generate(
      "gemini-3.1-flash-image",
      { prompt: "a cat", aspect: "16:9", resolution: "2K", format: "png" },
      "goog-key"
    );

    expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(calls[0].url).not.toContain("goog-key");
    expect((calls[0].init.headers as Record<string, string>)["x-goog-api-key"]).toBe("goog-key");

    const body = JSON.parse(calls[0].init.body as string);
    expect(body.model).toBe("gemini-3.1-flash-image");
    expect(body.input[0]).toEqual({ type: "text", text: "a cat" });
    expect(body.response_format).toMatchObject({
      type: "image",
      aspect_ratio: "16:9",
      image_size: "2K",
    });

    expect(Buffer.from(result.images[0].data).toString()).toBe("fake-png-bytes");
    expect(result.costUsd).toBe(0.101); // flash @ 2K
  });

  test("references become base64 image parts in the same input array", async () => {
    const calls = stub({ output_image: { data: PNG_B64 } });
    await geminiProvider.generate("gemini-3.1-flash-image", { prompt: "x", references: [ref()] }, "k");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.input).toHaveLength(2);
    expect(body.input[1]).toMatchObject({ type: "image", mime_type: "image/png" });
    expect(body.input[1].data).toBe(Buffer.from([1, 2, 3]).toString("base64"));
  });

  test("a refusal arrives as HTTP 200 with no image and must not pass silently", async () => {
    stub({ status: "failed", errors: [{ code: "SAFETY", message: "blocked by policy" }] });
    await expect(
      geminiProvider.generate("gemini-3.1-flash-image", { prompt: "x" }, "k")
    ).rejects.toThrow(/no image.*blocked by policy/s);
  });

  test("the model's words are carried through when it returns text alongside", async () => {
    stub({ output_image: { data: PNG_B64 }, output_text: "here you go" });
    const result = await geminiProvider.generate("gemini-3.1-flash-image", { prompt: "x" }, "k");
    expect(result.note).toBe("here you go");
  });

  test("429 is retryable", async () => {
    stub({ error: { message: "RESOURCE_EXHAUSTED" } }, { status: 429 });
    await expect(
      geminiProvider.generate("gemini-3.1-flash-image", { prompt: "x" }, "k")
    ).rejects.toMatchObject({ opts: { retryable: true } });
  });
});
