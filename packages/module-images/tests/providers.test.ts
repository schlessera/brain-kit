/**
 * Provider request-shaping and response-decoding, with `fetch` stubbed.
 *
 * No network: these assert the exact wire shape each vendor documents, because
 * that is where a silent mistake lives — a header in the wrong place, a mask
 * sent as JSON, or a refusal read as success.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { geminiProvider } from "../src/providers/gemini";
import { openaiProvider } from "../src/providers/openai";
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

const PNG_B64 = Buffer.from("fake-png-bytes").toString("base64");
const ref = (): ImageInput => ({ data: new Uint8Array([1, 2, 3]), mime: "image/png", label: "a.png" });

describe("openai provider", () => {
  test("generation posts JSON to /images/generations with a bearer token", async () => {
    const calls = stub({ data: [{ b64_json: PNG_B64 }], usage: { total_tokens: 10 } });
    const result = await openaiProvider.generate(
      "gpt-image-2",
      { prompt: "a cat", size: "1024x1024", quality: "high", format: "png" },
      "sk-test"
    );

    expect(calls[0].url).toBe("https://api.openai.com/v1/images/generations");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toMatchObject({ model: "gpt-image-2", prompt: "a cat", size: "1024x1024", quality: "high" });

    expect(result.images).toHaveLength(1);
    expect(Buffer.from(result.images[0].data).toString()).toBe("fake-png-bytes");
    expect(result.costUsd).toBe(0.211); // high @ 1024x1024
  });

  test("`auto` size is omitted rather than sent literally", async () => {
    const calls = stub({ data: [{ b64_json: PNG_B64 }] });
    await openaiProvider.generate("gpt-image-2", { prompt: "x", size: "auto" }, "k");
    expect(JSON.parse(calls[0].init.body as string).size).toBeUndefined();
  });

  test("references switch it to multipart /images/edits", async () => {
    const calls = stub({ data: [{ b64_json: PNG_B64 }] });
    await openaiProvider.generate("gpt-image-2", { prompt: "edit it", references: [ref()] }, "k");

    expect(calls[0].url).toBe("https://api.openai.com/v1/images/edits");
    const body = calls[0].init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    // Reference images repeat under `image[]`, which is the documented field.
    expect(body.getAll("image[]")).toHaveLength(1);
    // Content-Type must NOT be set by hand — fetch adds the multipart boundary.
    expect((calls[0].init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  test("a mask rides along as a PNG part", async () => {
    const calls = stub({ data: [{ b64_json: PNG_B64 }] });
    await openaiProvider.generate(
      "gpt-image-2",
      { prompt: "sky", references: [ref()], mask: ref() },
      "k"
    );
    const body = calls[0].init.body as FormData;
    expect(body.get("mask")).toBeInstanceOf(Blob);
  });

  test("a billing 429 is reported as not retryable", async () => {
    stub({ error: { message: "quota", code: "insufficient_quota" } }, { status: 429 });
    try {
      await openaiProvider.generate("gpt-image-2", { prompt: "x" }, "k");
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as ImageProviderError;
      expect(err.opts.retryable).toBe(false);
      expect(err.message).toMatch(/retrying will not help/);
    }
  });

  test("a rate-limit 429 is reported as retryable", async () => {
    stub({ error: { message: "slow down", code: "rate_limit_exceeded" } }, { status: 429 });
    await expect(openaiProvider.generate("gpt-image-2", { prompt: "x" }, "k")).rejects.toMatchObject({
      opts: { retryable: true },
    });
  });

  test("a moderation refusal names itself", async () => {
    stub(
      { error: { message: "blocked", code: "moderation_blocked", moderation_details: { stage: "prompt" } } },
      { status: 400 }
    );
    await expect(openaiProvider.generate("gpt-image-2", { prompt: "x" }, "k")).rejects.toThrow(
      /refused by moderation/
    );
  });

  test("an empty data array is an error, not an empty file", async () => {
    stub({ data: [] });
    await expect(openaiProvider.generate("gpt-image-2", { prompt: "x" }, "k")).rejects.toThrow(
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
