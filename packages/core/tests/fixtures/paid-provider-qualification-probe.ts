/** Fictional loopback upstreams; this is compatibility evidence, not a host relay. */
import { GoogleGenAI } from "@google/genai";
import { strict as assert } from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readlinkSync,
  symlinkSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { geminiEmbeddings } from "../../src/providers/embeddings/gemini.js";
import { geminiCompletions } from "../../src/providers/completions/gemini.js";
import { anthropicCompletions } from "../../src/providers/completions/anthropic.js";
import { openaiProvider } from "../../../module-images/src/providers/openai.js";
import { geminiProvider } from "../../../module-images/src/providers/gemini.js";

const mode = process.argv[2];
assert(["providers", "cli", "images"].includes(mode!));
const root = mkdtempSync(join(tmpdir(), "odysseus-paid-provider-"));
const key = "odysseus-fictional-provider-key",
  answer = "Odysseus checks Ithaca.";
const googleUsage = {
  promptTokenCount: 7,
  candidatesTokenCount: 3,
  totalTokenCount: 10,
};
const embeddingUsage = {
  promptTokenCount: 17,
  promptTokenDetails: [{ modality: "TEXT", tokenCount: 17 }],
};
const anthropicUsage = { input_tokens: 7, output_tokens: 3 };
const imageUsage = {
  input_tokens: 100,
  output_tokens: 1000,
  input_tokens_details: { text_tokens: 60, image_tokens: 40 },
};
const image = Buffer.from("Odysseus fictional image bytes").toString("base64");
type Call = {
  method: string;
  path: string;
  key: string | null;
  body: Record<string, any> | null;
  format: string;
  usage: unknown;
};
const calls: Call[] = [];
let retry = false,
  malformed = false,
  hangGeneration = false,
  processAnswer = false,
  missingImageUsage = false,
  missingEmbeddingUsage = false;
let generationStarted: (() => void) | undefined;
const json = (value: unknown, headers: Record<string, string> = {}) =>
  Response.json(value, { headers });
const activeFile = () => ({
  name: "files/odysseus",
  uri: `${server.url.origin}/v1beta/files/odysseus`,
  mimeType: "video/mp4",
  state: "ACTIVE",
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request): Promise<Response> {
    const path = new URL(request.url).pathname,
      format = request.headers.get("content-type") ?? "";
    let body: Record<string, any> | null = null;
    if (path === "/upload-bytes") await request.arrayBuffer();
    else if (request.body && format.includes("application/json"))
      body = (await request.json()) as Record<string, any>;
    else if (format.includes("multipart/form-data")) {
      const form = await request.formData();
      body = {
        model: form.get("model"),
        prompt: form.get("prompt"),
        references: form.getAll("image[]").length,
        mask: form.has("mask"),
      };
    } else await request.arrayBuffer();
    const call: Call = {
      method: request.method,
      path,
      body,
      format,
      key:
        request.headers.get("x-goog-api-key") ??
        request.headers.get("x-api-key") ??
        request.headers.get("authorization"),
      usage: null,
    };
    calls.push(call);
    if (path.endsWith(":batchEmbedContents"))
      return json({
        ...(!missingEmbeddingUsage ? { usageMetadata: embeddingUsage } : {}),
        embeddings: (body?.requests ?? []).map(() => ({
          values: Array(16).fill(0.25),
        })),
      });
    if (path.endsWith(":embedContent"))
      return json({
        embedding: { values: Array(16).fill(0.25) },
        ...(!missingEmbeddingUsage ? { usageMetadata: embeddingUsage } : {}),
      });
    if (path === "/upload/v1beta/files")
      return json(
        {},
        { "x-goog-upload-url": `${server.url.origin}/upload-bytes` }
      );
    if (path === "/upload-bytes")
      return json(
        { file: { ...activeFile(), state: "PROCESSING" } },
        { "x-goog-upload-status": "final" }
      );
    if (path === "/v1beta/files/odysseus")
      return request.method === "DELETE" ? json({}) : json(activeFile());
    if (path.endsWith(":generateContent")) {
      if (hangGeneration) {
        generationStarted?.();
        return new Promise<Response>((resolve) => {
          request.signal.addEventListener(
            "abort",
            () => resolve(new Response(null, { status: 499 })),
            { once: true }
          );
        });
      }
      call.usage = googleUsage;
      return json({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  text: processAnswer
                    ? JSON.stringify({
                        action: "keep",
                        reasoning: "Odysseus keeps the route.",
                        operations: [],
                      })
                    : answer,
                },
              ],
            },
          },
        ],
        usageMetadata: googleUsage,
        modelVersion: body?.model,
      });
    }
    if (path === "/anthropic/v1/messages") {
      if (retry) {
        retry = false;
        return Response.json(
          { error: { message: "Odysseus transient fixture" } },
          { status: 503 }
        );
      }
      if (malformed)
        return new Response('{"content":', {
          headers: { "content-type": "application/json" },
        });
      call.usage = anthropicUsage;
      return json({
        model: body?.model,
        content: [{ type: "text", text: answer }],
        usage: anthropicUsage,
      });
    }
    if (path === "/v1/images/generations" || path === "/v1/images/edits") {
      call.usage = missingImageUsage ? null : imageUsage;
      return json({
        data: [{ b64_json: image }],
        ...(!missingImageUsage ? { usage: imageUsage } : {}),
      });
    }
    if (path === "/v1beta/interactions")
      return json({
        output_image: { data: image, mime_type: "image/jpeg" },
        usage: { total_tokens: 5 },
      });
    return new Response("Unexpected fictional provider route", { status: 404 });
  },
});

const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch")!;
const warnDescriptor = Object.getOwnPropertyDescriptor(console, "warn")!;
const originalFetch = fetch;
const retryWarnings: string[] = [];
const wireEmbeddingUsage: unknown[] = [];
// Anthropic's built-in URL is fixed. Redirect only this test transport to
// loopback and retain the requested destination separately; no host relay or
// new production endpoint option is implied.
const requestedAnthropicOrigins: string[] = [];
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === "https://api.anthropic.com") {
      requestedAnthropicOrigins.push(url.origin);
      return originalFetch(
        `${server.url.origin}/anthropic${url.pathname}`,
        init
      );
    }
    assert.equal(
      url.origin,
      server.url.origin,
      "OFFLINE_PROVIDER_UNEXPECTED_RECIPIENT"
    );
    const response = await originalFetch(input, init);
    if (/:batchEmbedContents$|:embedContent$/.test(url.pathname)) {
      const raw = (await response.clone().json()) as {
        usageMetadata?: unknown;
      };
      wireEmbeddingUsage.push(raw.usageMetadata ?? null);
    }
    return response;
  },
  { preconnect: originalFetch.preconnect }
) as typeof fetch;
console.warn = (...values) => {
  retryWarnings.push(values.join(" "));
};
process.env.GEMINI_API_KEY = key;
process.env.OPENAI_API_KEY = key;
process.env.ODYSSEUS_PROVIDER_KEY = key;
process.env.GOOGLE_GEMINI_BASE_URL = server.url.origin;
process.env.GOOGLE_GENAI_USE_VERTEXAI = "false";
process.env.GOOGLE_GENAI_USE_ENTERPRISE = "false";
process.env.OPENAI_BASE_URL = `${server.url.origin}/v1`;
process.env.GEMINI_BASE_URL = `${server.url.origin}/v1beta`;
const namespace = readlinkSync("/proc/self/ns/net");
const transport = () =>
  calls.map((call) => ({
    method: call.method,
    path: call.path,
    contentType: call.format,
    model:
      call.body?.model ??
      call.body?.requests?.[0]?.model ??
      /\/models\/([^/:]+)/.exec(call.path)?.[1] ??
      null,
  }));
const cli = async (args: string[], keys = true) => {
  const child = Bun.spawn(
    [
      process.execPath,
      new URL("../../src/cli/brain.ts", import.meta.url).pathname,
      ...args,
    ],
    {
      cwd: root,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: process.env.HOME!,
        BRAIN_ROOT: root,
        LANG: "C.UTF-8",
        TZ: "UTC",
        BUN_OPTIONS: "--no-env-file",
        GOOGLE_GEMINI_BASE_URL: server.url.origin,
        GOOGLE_GENAI_USE_VERTEXAI: "false",
        GOOGLE_GENAI_USE_ENTERPRISE: "false",
        OPENAI_BASE_URL: `${server.url.origin}/v1`,
        GEMINI_BASE_URL: `${server.url.origin}/v1beta`,
        ...(keys
          ? {
              GEMINI_API_KEY: key,
              OPENAI_API_KEY: key,
              ODYSSEUS_PROVIDER_KEY: key,
            }
          : {}),
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(code, 0, stderr || stdout);
  return { stdout, stderr, code };
};
const configure = (value: unknown) =>
  writeFileSync(join(root, "brain.config.json"), JSON.stringify(value));
const videoEvents = (entries: Call[]) =>
  entries.map((call) =>
    call.path === "/upload/v1beta/files"
      ? "upload-start"
      : call.path === "/upload-bytes"
      ? "upload-bytes"
      : call.path.endsWith(":generateContent")
      ? "generate"
      : call.method === "DELETE"
      ? "delete"
      : "poll"
  );
try {
  if (mode === "providers") {
    const embeddings = geminiEmbeddings({
      dimensions: 16,
      apiKeyEnv: "ODYSSEUS_PROVIDER_KEY",
    });
    const vectors = await embeddings.embed(
      Array.from({ length: 101 }, (_, i) => `Odysseus route ${i}`)
    );
    assert.equal(vectors.length, 101);
    assert(
      vectors.every(
        (vector) => vector instanceof Float32Array && vector.length === 16
      )
    );
    const batches = calls.map((call) => call.body?.requests.length);
    await embeddings.embedQuery("Ithaca");
    assert(
      embeddings.embedImage && embeddings.embedPdf,
      "BUILTIN_MULTIMODAL_EMBEDDINGS_AVAILABLE"
    );
    await embeddings.embedImage(
      new Uint8Array([1, 2]),
      "image/png",
      "Ithaca harbour"
    );
    await embeddings.embedPdf(new Uint8Array([3, 4]), "Ithaca map");
    const embeddingCalls = [...calls];
    assert.equal(
      embeddingCalls.length,
      5,
      "NATIVE_EMBEDDING_OPERATION_REQUEST_COUNT"
    );
    assert.equal(
      embeddingCalls[2]!.body?.requests[0].content.parts[0].text,
      "task: search result | query: Ithaca"
    );
    assert.equal(
      embeddingCalls[3]!.body?.requests[0].content.parts[1].inlineData.mimeType,
      "image/png"
    );
    assert.equal(
      embeddingCalls[4]!.body?.requests[0].content.parts[1].inlineData.mimeType,
      "application/pdf"
    );
    // The Developer API documents raw usageMetadata. The installed SDK's
    // converter drops it; observe the actual HTTP response before conversion.
    const sdk = new GoogleGenAI({ apiKey: key });
    const nativeEmbedding = await sdk.models.embedContent({
      model: "gemini-embedding-2",
      contents: "Odysseus SDK accounting control",
    });
    const rawEmbeddingUsage = wireEmbeddingUsage.at(-1);
    missingEmbeddingUsage = true;
    await sdk.models.embedContent({
      model: "gemini-embedding-2",
      contents: "Odysseus absent usage control",
    });
    const absentEmbeddingUsage = wireEmbeddingUsage.at(-1);
    missingEmbeddingUsage = false;
    const google = geminiCompletions({ apiKeyEnv: "ODYSSEUS_PROVIDER_KEY" });
    const anthropic = anthropicCompletions({
      apiKeyEnv: "ODYSSEUS_PROVIDER_KEY",
    });
    const completionResults = [
      await google.complete({
        prompt: "Ithaca",
        parts: [
          { kind: "image", mimeType: "image/png", data: new Uint8Array([1]) },
        ],
      }),
      await anthropic.complete({
        prompt: "Ithaca",
        parts: [{ kind: "pdf", data: new Uint8Array([2]) }],
      }),
    ];
    retry = true;
    const startRetry = calls.length;
    assert.equal(
      await anthropic.complete({ prompt: "Odysseus retries" }),
      answer
    );
    const retryAttempts = calls.length - startRetry;
    malformed = true;
    await assert.rejects(
      anthropic.complete({ prompt: "Odysseus incomplete fixture" })
    );
    malformed = false;
    const local = {
      kind: "video" as const,
      data: new Uint8Array([1, 2, 3]),
      mimeType: "video/mp4",
    };
    const videoStart = calls.length;
    assert.equal(
      await google.complete({ prompt: "Watch the harbour", parts: [local] }),
      answer
    );
    const videoLifecycle = videoEvents(calls.slice(videoStart));
    const cancelStart = calls.length,
      controller = new AbortController();
    const started = new Promise<void>((resolve) => {
      generationStarted = resolve;
    });
    hangGeneration = true;
    const pending = google.complete({
      prompt: "Cancel the harbour watch",
      parts: [local],
      signal: controller.signal,
    });
    void pending.catch(() => {});
    await started;
    controller.abort(new Error("Odysseus cancellation"));
    await assert.rejects(pending);
    hangGeneration = false;
    assert.deepEqual(
      requestedAnthropicOrigins,
      Array(4).fill("https://api.anthropic.com")
    );
    console.log(
      JSON.stringify({
        namespace,
        embeddingOperations: ["text-batch", "query", "image", "pdf"],
        nativeEmbeddingHasRawUsage: Object.hasOwn(
          nativeEmbedding,
          "usageMetadata"
        ),
        rawEmbeddingUsage,
        absentEmbeddingUsage,
        transport: transport(),
        requestedAnthropicOrigins,
        embeddingBatchSizes: batches,
        completionResults,
        completionReturnsUsage: completionResults.some(
          (value) => typeof value !== "string"
        ),
        reportedCompletionUsage: {
          google: calls.find((call) => call.usage === googleUsage)?.usage,
          anthropic: calls.find((call) => call.usage === anthropicUsage)?.usage,
        },
        anthropicCredentials: calls
          .filter((call) => call.path === "/anthropic/v1/messages")
          .map((call) => call.key === key),
        retryAttempts,
        invalidResponseRefused: true,
        videoLifecycle,
        cancelledVideoLifecycle: videoEvents(calls.slice(cancelStart)),
        cancelled: true,
        googleCredentials: embeddingCalls.every((call) => call.key === key),
      })
    );
  } else if (mode === "cli") {
    symlinkSync(
      resolve(import.meta.dir, "../../../../node_modules"),
      join(root, "node_modules")
    );
    mkdirSync(join(root, "notes"));
    writeFileSync(
      join(root, "notes/odysseus.md"),
      "---\ntype: note\ntitle: Ithaca harbour\ncreated: 2026-07-12\nupdated: 2026-07-12\n---\n" +
        "Odysseus checks the harbour at Ithaca. ".repeat(120)
    );
    const embeddingConfig = {
      embeddings: {
        provider: "gemini",
        dimensions: 16,
        apiKeyEnv: "ODYSSEUS_PROVIDER_KEY",
      },
      completions: {
        provider: "anthropic-haiku",
        apiKeyEnv: "ODYSSEUS_ABSENT_COMPLETION",
      },
    };
    configure(embeddingConfig);
    const indexed = await cli(["index", "--embeddings", "--json"]);
    const indexCalls = calls.length;
    const searches = [];
    for (let i = 0; i < 2; i++) {
      const before = calls.length,
        result = await cli(["search", "Ithaca", "--json"]),
        parsed = JSON.parse(result.stdout);
      searches.push({
        code: result.code,
        stderr: result.stderr,
        keys: Object.keys(parsed).sort(),
        found: parsed.results.some(
          (value: { path: string }) => value.path === "notes/odysseus.md"
        ),
        embeddingRequests: calls.length - before,
      });
    }
    const beforeMissing = calls.length,
      missing = await cli(["search", "Ithaca", "--json"], false),
      fallback = JSON.parse(missing.stdout);
    configure({
      ...embeddingConfig,
      completions: {
        provider: "gemini-flash",
        apiKeyEnv: "ODYSSEUS_PROVIDER_KEY",
      },
    });
    processAnswer = true;
    const beforeProcess = calls.length,
      processed = await cli(["process", "notes/odysseus.md", "--json"]),
      parsed = JSON.parse(processed.stdout);
    console.log(
      JSON.stringify({
        namespace,
        index: {
          code: indexed.code,
          stderr: indexed.stderr,
          embeddingRequests: indexCalls,
        },
        searches,
        withoutKey: {
          code: missing.code,
          found: fallback.results.some(
            (value: { path: string }) => value.path === "notes/odysseus.md"
          ),
          warnings: fallback.warnings,
          embeddingRequests: beforeProcess - beforeMissing,
        },
        process: {
          code: processed.code,
          action: parsed.action,
          keys: Object.keys(parsed).sort(),
          generationRequests: calls
            .slice(beforeProcess)
            .filter((call) => call.path.endsWith(":generateContent")).length,
        },
        transport: transport(),
        credentialsWereFictional: calls.every((call) => call.key === key),
        providerMeteringActivated: false,
      })
    );
  } else {
    const request = {
      prompt: "Odysseus charts Ithaca",
      format: "png" as const,
    };
    const generated = await openaiProvider.generate(
      "gpt-image-2.5-flare",
      request,
      key
    );
    await openaiProvider.generate(
      "gpt-image-2.5-flare",
      {
        ...request,
        references: [{ data: new Uint8Array([1]), mime: "image/png" }],
        mask: { data: new Uint8Array([2]), mime: "image/png" },
      },
      key
    );
    await geminiProvider.generate(
      "gemini-3.1-flash-image",
      { prompt: "Odysseus harbour", format: "jpeg" },
      key
    );
    assert.equal(calls[1]!.body?.references, 1);
    assert.equal(calls[1]!.body?.mask, true);
    missingImageUsage = true;
    const unpriced = await openaiProvider.generate(
      "gpt-image-2.5-flare",
      request,
      key
    );
    missingImageUsage = false;
    symlinkSync(
      resolve(import.meta.dir, "../../../../node_modules"),
      join(root, "node_modules")
    );
    configure({ modules: { "@schlessera/brain-module-images": {} } });
    const result = await cli([
        "image",
        "Odysseus harbour",
        "--model",
        "gpt-image-2.5-flare",
        "--out",
        "harbour.png",
        "--json",
      ]),
      parsed = JSON.parse(result.stdout);
    console.log(
      JSON.stringify({
        namespace,
        operations: ["openai-json", "openai-multipart", "gemini-interactions"],
        credentials: calls.map(
          (call) => call.key === key || call.key === `Bearer ${key}`
        ),
        transport: transport(),
        reportedUsage: generated.usage,
        costIsEstimate: generated.costIsEstimate,
        estimatedCost: generated.costUsd,
        missingUsageCost: unpriced.costUsd ?? null,
        cli: {
          code: result.code,
          stderr: result.stderr,
          keys: Object.keys(parsed).sort(),
          model: parsed.model,
          costIsEstimate: parsed.costIsEstimate,
          outputExists: existsSync(join(root, parsed.output)),
          exposesRawUsage: Object.hasOwn(parsed, "usage"),
        },
      })
    );
  }
} finally {
  Object.defineProperty(globalThis, "fetch", fetchDescriptor);
  Object.defineProperty(console, "warn", warnDescriptor);
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
}
