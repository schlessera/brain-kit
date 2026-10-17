/** Offline native/CLI compatibility evidence, without a production metering relay. */
import { expect, test } from "bun:test";
import { mkdtempSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const mode of ["providers", "cli", "images"] as const) {
  test(`paid-provider ${mode} preserves actual transport and accounting boundaries offline`, async () => {
    const home = mkdtempSync(join(tmpdir(), "odysseus-paid-provider-home-"));
    try {
      // Native SDK transports are outside the preload's complete coverage.
      // Isolate the whole tree, replace ambient credentials, then drop the
      // capabilities used only to enable loopback.
      const child = Bun.spawn(
        [
          "unshare",
          "--user",
          "--map-current-user",
          "--keep-caps",
          "--net",
          "sh",
          "-c",
          'ip link set lo up && exec setpriv --inh-caps=-all --ambient-caps=-all --bounding-set=-all "$@"',
          "odysseus-paid-providers",
          process.execPath,
          new URL(
            "./fixtures/paid-provider-qualification-probe.ts",
            import.meta.url
          ).pathname,
          mode,
        ],
        {
          env: {
            PATH: "/usr/bin:/bin",
            HOME: home,
            LANG: "C.UTF-8",
            TZ: "UTC",
            BUN_OPTIONS: "--no-env-file",
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 45_000,
        }
      );
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exit, stderr || stdout).toBe(0);
      expect(stderr).toBe("");
      const result = JSON.parse(stdout);
      expect(
        result.namespace,
        "PAID_PROVIDER_PRIVATE_NETWORK_NAMESPACE"
      ).not.toBe(readlinkSync("/proc/self/ns/net"));
      if (mode === "providers") {
        expect(result.embeddingOperations).toEqual([
          "text-batch",
          "query",
          "image",
          "pdf",
        ]);
        expect(
          result.absentEmbeddingUsage,
          "MISSING_EMBEDDING_USAGE_STAYS_UNKNOWN"
        ).toBeNull();
        expect(
          result.rawEmbeddingUsage,
          "RAW_EMBEDDING_USAGE_BEFORE_SDK_CONVERSION"
        ).toEqual({
          promptTokenCount: 17,
          promptTokenDetails: [{ modality: "TEXT", tokenCount: 17 }],
        });
        expect(
          result.nativeEmbeddingHasRawUsage,
          "INSTALLED_SDK_DROPS_RAW_EMBEDDING_USAGE"
        ).toBe(false);
        expect(result.embeddingBatchSizes).toEqual([100, 1]);
        expect(result.completionResults).toEqual([
          "Odysseus checks Ithaca.",
          "Odysseus checks Ithaca.",
        ]);
        expect(result.reportedCompletionUsage).toEqual({
          google: {
            promptTokenCount: 7,
            candidatesTokenCount: 3,
            totalTokenCount: 10,
          },
          anthropic: { input_tokens: 7, output_tokens: 3 },
        });
        expect(result.completionReturnsUsage).toBe(false);
        expect(
          result.anthropicCredentials,
          "NATIVE_ANTHROPIC_CREDENTIAL_PLACEMENT"
        ).toEqual([true, true, true, true]);
        expect(result.retryAttempts).toBe(2);
        expect(result.invalidResponseRefused).toBe(true);
        expect(result.videoLifecycle).toEqual([
          "upload-start",
          "upload-bytes",
          "poll",
          "generate",
          "delete",
        ]);
        expect(result.cancelledVideoLifecycle).toEqual([
          "upload-start",
          "upload-bytes",
          "poll",
          "generate",
          "delete",
        ]);
        expect(result.cancelled).toBe(true);
        expect(result.googleCredentials).toBe(true);
        expect(result.requestedAnthropicOrigins).toEqual(
          Array(4).fill("https://api.anthropic.com")
        );
        expect(
          result.transport
            .slice(0, 5)
            .every(
              (call: { method: string; model: string }) =>
                call.method === "POST" &&
                call.model.replace(/^models\//, "") === "gemini-embedding-2"
            ),
          "NATIVE_EMBEDDING_MODEL_AND_METHOD"
        ).toBe(true);
        expect(
          result.transport.some(
            (call: { method: string; path: string }) =>
              call.method === "DELETE" && call.path === "/v1beta/files/odysseus"
          )
        ).toBe(true);
      } else if (mode === "cli") {
        expect(Number(result.index.code), String(result.index.stderr)).toBe(0);
        expect(result.index.embeddingRequests).toBeGreaterThan(0);
        expect(result.searches).toHaveLength(2);
        for (const search of result.searches) {
          expect(Number(search.code), String(search.stderr)).toBe(0);
          expect(
            search.embeddingRequests,
            "EACH_REAL_CLI_SEARCH_DISPATCHES_ITS_QUERY"
          ).toBe(1);
          expect(search.keys).toEqual(["results", "warnings"]);
          expect(search.found).toBe(true);
        }
        expect(result.withoutKey).toMatchObject({
          code: 0,
          embeddingRequests: 0,
          found: true,
        });
        expect(result.withoutKey.warnings.length).toBeGreaterThan(0);
        expect(result.process).toMatchObject({
          code: 0,
          action: "keep",
          generationRequests: 1,
        });
        expect(result.process.keys).toEqual([
          "action",
          "operations",
          "reasoning",
        ]);
        expect(result.credentialsWereFictional).toBe(true);
        expect(result.providerMeteringActivated).toBe(false);
      } else {
        expect(result.operations).toEqual([
          "openai-json",
          "openai-multipart",
          "gemini-interactions",
        ]);
        expect(
          result.transport
            .slice(0, 3)
            .map((call: { method: string; path: string }) => [
              call.method,
              call.path,
            ])
        ).toEqual([
          ["POST", "/v1/images/generations"],
          ["POST", "/v1/images/edits"],
          ["POST", "/v1beta/interactions"],
        ]);
        expect(result.transport[1].contentType).toStartWith(
          "multipart/form-data;"
        );
        expect(result.credentials).toEqual([true, true, true, true, true]);
        expect(result.reportedUsage, "NATIVE_IMAGE_USAGE_PRESERVED").toEqual({
          input_tokens: 100,
          output_tokens: 1000,
          input_tokens_details: { text_tokens: 60, image_tokens: 40 },
        });
        expect(result.costIsEstimate).toBe(true);
        expect(result.estimatedCost).toBeCloseTo(
          (60 * 5 + 40 * 8 + 1000 * 30) / 1_000_000,
          10
        );
        expect(
          result.missingUsageCost,
          "MISSING_IMAGE_USAGE_COST_STAYS_UNKNOWN"
        ).toBeNull();
        expect(Number(result.cli.code), String(result.cli.stderr)).toBe(0);
        expect(result.cli.keys).toEqual([
          "bytes",
          "costIsEstimate",
          "costUsd",
          "model",
          "note",
          "output",
          "outputs",
          "provider",
          "reason",
          "renamed",
        ]);
        expect(result.cli.model).toBe("gpt-image-2.5-flare");
        expect(result.cli.costIsEstimate).toBe(true);
        expect(result.cli.outputExists).toBe(true);
        expect(result.cli.exposesRawUsage).toBe(false);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
}
