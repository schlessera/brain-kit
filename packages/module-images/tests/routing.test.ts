import { describe, expect, test } from "bun:test";

import { route } from "../src/routing";
import { availableModels } from "../src/providers/index";
import { configSchema } from "../src/module";
import type { ImageInput, ModelCapabilities } from "../src/types";

const cfg = configSchema.parse({});
const ALL = availableModels(cfg, { OPENAI_API_KEY: "x", GEMINI_API_KEY: "y" } as NodeJS.ProcessEnv);
const OPENAI_ONLY = availableModels(cfg, { OPENAI_API_KEY: "x" } as NodeJS.ProcessEnv);
const GEMINI_ONLY = availableModels(cfg, { GEMINI_API_KEY: "y" } as NodeJS.ProcessEnv);

const img = (): ImageInput => ({ data: new Uint8Array([1]), mime: "image/png" });
const ids = (models: ModelCapabilities[]) => models.map((m) => m.id);

describe("availability", () => {
  test("no key means no models", () => {
    expect(availableModels(cfg, {} as NodeJS.ProcessEnv)).toEqual([]);
  });

  test("each key unlocks only its own provider", () => {
    expect(new Set(OPENAI_ONLY.map((m) => m.provider))).toEqual(new Set(["openai"]));
    expect(new Set(GEMINI_ONLY.map((m) => m.provider))).toEqual(new Set(["gemini"]));
  });

  test("disabledModels hides a model that would otherwise be available", () => {
    const limited = availableModels(configSchema.parse({ disabledModels: ["gpt-image-2"] }), {
      OPENAI_API_KEY: "x",
    } as NodeJS.ProcessEnv);
    expect(ids(limited)).not.toContain("gpt-image-2");
  });

  test("with no provider at all, routing explains rather than throwing", () => {
    const d = route({ request: { prompt: "x" }, available: [] });
    expect(d.kind).toBe("impossible");
    expect((d as { reason: string }).reason).toContain("OPENAI_API_KEY");
  });
});

describe("hard capability rules", () => {
  test("a mask forces OpenAI", () => {
    const d = route({ request: { prompt: "x", mask: img(), references: [img()] }, available: ALL });
    expect(d.kind).toBe("resolved");
    expect((d as { model: ModelCapabilities }).model.provider).toBe("openai");
  });

  test("a mask with only Gemini available is impossible, and says why", () => {
    const d = route({ request: { prompt: "x", mask: img() }, available: GEMINI_ONLY });
    expect(d.kind).toBe("impossible");
    expect((d as { reason: string }).reason).toMatch(/no mask concept/i);
  });

  test("transparency forces gpt-image-1.5, never gpt-image-2", () => {
    const d = route({ request: { prompt: "x", transparent: true }, available: ALL });
    expect(d.kind).toBe("resolved");
    expect((d as { model: ModelCapabilities }).model.id).toBe("gpt-image-1.5");
  });

  test("transparency plus JPEG is refused — JPEG has no alpha channel", () => {
    const d = route({ request: { prompt: "x", transparent: true, format: "jpeg" }, available: ALL });
    expect(d.kind).toBe("impossible");
    expect((d as { reason: string }).reason).toMatch(/no alpha channel/i);
  });

  test("transparency plus PNG resolves to the model that supports both", () => {
    const d = route({ request: { prompt: "x", transparent: true, format: "png" }, available: ALL });
    expect(d.kind).toBe("resolved");
    const m = (d as { model: ModelCapabilities }).model;
    expect(m.transparentBackground).toBe(true);
    expect(m.outputFormats).toContain("png");
  });

  test("transparency without OpenAI is impossible", () => {
    const d = route({ request: { prompt: "x", transparent: true }, available: GEMINI_ONLY });
    expect(d.kind).toBe("impossible");
    expect((d as { reason: string }).reason).toMatch(/transparent/i);
  });

  test("an exact odd pixel size forces a model that takes arbitrary dimensions", () => {
    const d = route({ request: { prompt: "x", size: "1234x768" }, available: ALL });
    expect(d.kind).toBe("resolved");
    expect((d as { model: ModelCapabilities }).model.arbitraryDimensions).toBe(true);
  });

  test("a size beyond every model's limits is impossible", () => {
    const d = route({ request: { prompt: "x", size: "6000x6000" }, available: ALL });
    expect(d.kind).toBe("impossible");
  });

  test("more references than any model accepts is impossible, and reports the best available", () => {
    const many = Array.from({ length: 20 }, img);
    const d = route({ request: { prompt: "x", references: many }, available: ALL });
    expect(d.kind).toBe("impossible");
    expect((d as { reason: string }).reason).toContain("16");
  });

  test("twelve references drops OpenAI, which tops out lower", () => {
    const twelve = Array.from({ length: 12 }, img);
    const d = route({ request: { prompt: "x", references: twelve }, available: GEMINI_ONLY });
    expect(d.kind).toBe("resolved");
    expect((d as { model: ModelCapabilities }).model.maxReferenceImages).toBeGreaterThanOrEqual(12);
  });
});

describe("documented-strength preferences", () => {
  test("in-image text routes to OpenAI, not Gemini", () => {
    // This module originally routed text to Gemini, reasoning that Google
    // documents text rendering as a strength and OpenAI documents nothing.
    // arena.ai's dedicated text-rendering board says the opposite: gpt-image-2
    // leads it by ~130 Elo, its widest category margin. Vendor silence is not
    // weakness, and this test exists so that inference is not made again.
    const d = route({ request: { prompt: "a poster" }, available: ALL, intent: { textInImage: true } });
    expect(d.kind).toBe("resolved");
    expect((d as { model: ModelCapabilities }).model.id).toBe("gpt-image-2");
  });

  test("stylization is the documented Gemini exception", () => {
    // Google's own model card is the source: 1054 vs 1030 for gpt-image-2.
    const d = route({ request: { prompt: "restyle this" }, available: ALL, intent: { stylize: true } });
    expect(d.kind).toBe("resolved");
    expect((d as { model: ModelCapabilities }).model.id).toBe("gemini-3-pro-image");
  });

  test("character consistency narrows to models that claim it, but picks no winner", () => {
    // No independent benchmark for identity preservation exists, and Google's
    // own card scores character editing as a tie inside the error bars. So the
    // rule filters and then defers, rather than asserting a winner.
    const d = route({
      request: { prompt: "the same knight again" },
      available: ALL,
      intent: { characterConsistency: true },
    });
    expect(d.kind).toBe("resolved");
    const resolved = d as { model: ModelCapabilities };
    expect(resolved.model.characterConsistency).toBeGreaterThan(0);
    // Flash outranks Pro on both public arenas at a fraction of the cost.
    expect(resolved.model.id).toBe("gemini-3.1-flash-image");
  });

  test("no-watermark routes to OpenAI", () => {
    const d = route({ request: { prompt: "x" }, available: ALL, intent: { noWatermark: true } });
    expect(d.kind).toBe("resolved");
    expect((d as { model: ModelCapabilities }).model.watermarked).toBe(false);
  });

  test("no-watermark with only Gemini is impossible — SynthID has no opt-out", () => {
    const d = route({ request: { prompt: "x" }, available: GEMINI_ONLY, intent: { noWatermark: true } });
    expect(d.kind).toBe("impossible");
    expect((d as { reason: string }).reason).toMatch(/SynthID/);
  });

  test("draft takes the cheapest available model", () => {
    const d = route({ request: { prompt: "x" }, available: ALL, intent: { draft: true } });
    expect(d.kind).toBe("resolved");
    const picked = (d as { model: ModelCapabilities }).model;
    expect(picked.approxCostUsd1K).toBe(Math.min(...ALL.map((m) => m.approxCostUsd1K)));
  });
});

describe("ambiguity", () => {
  test("a plain prompt resolves to the highest-ranked available model", () => {
    const d = route({ request: { prompt: "a nice landscape" }, available: ALL });
    expect(d.kind).toBe("resolved");
    const resolved = d as { model: ModelCapabilities; reason: string };
    expect(resolved.model.id).toBe("gpt-image-2");
    expect(resolved.reason).toMatch(/arenas/);
  });

  test("with Gemini only, the default prefers Flash over the pricier Pro", () => {
    // Pro is the more expensive model, not the better-scoring one: Flash is
    // ahead on both arenas (1264 vs 1246 text-to-image).
    const d = route({ request: { prompt: "a nice landscape" }, available: GEMINI_ONLY });
    expect(d.kind).toBe("resolved");
    expect((d as { model: ModelCapabilities }).model.id).toBe("gemini-3.1-flash-image");
  });

  test("a configured preference beats the evidence-based default", () => {
    const d = route({
      request: { prompt: "a nice landscape" },
      available: ALL,
      preferredModels: ["gemini-3-pro-image"],
    });
    expect(d.kind).toBe("resolved");
    const resolved = d as { model: ModelCapabilities; reason: string };
    expect(resolved.model.id).toBe("gemini-3-pro-image");
    expect(resolved.reason).toMatch(/configured preference/);
  });

  test("a preference never overrides a capability rule", () => {
    const d = route({
      request: { prompt: "x", mask: img(), references: [img()] },
      available: ALL,
      preferredModels: ["gemini-3-pro-image"],
    });
    expect(d.kind).toBe("resolved");
    expect((d as { model: ModelCapabilities }).model.provider).toBe("openai");
  });

  test("quality is the bias, not cost — the strongest model wins a tie", () => {
    const d = route({ request: { prompt: "x" }, available: OPENAI_ONLY });
    expect(d.kind).toBe("resolved");
    expect((d as { model: ModelCapabilities }).model.id).toBe("gpt-image-2");
  });
});

describe("pinning", () => {
  test("an explicit model wins over every heuristic", () => {
    const d = route({
      request: { prompt: "x", transparent: true },
      available: ALL,
      pinnedModel: "gemini-3-pro-image",
    });
    expect(d.kind).toBe("resolved");
    expect((d as { model: ModelCapabilities }).model.id).toBe("gemini-3-pro-image");
  });

  test("an unknown pinned model lists what is available", () => {
    const d = route({ request: { prompt: "x" }, available: ALL, pinnedModel: "dall-e-2" });
    expect(d.kind).toBe("impossible");
    expect((d as { reason: string }).reason).toContain("gpt-image-2");
  });

  test("pinning a provider with no key is impossible", () => {
    const d = route({ request: { prompt: "x" }, available: GEMINI_ONLY, pinnedProvider: "openai" });
    expect(d.kind).toBe("impossible");
  });
});
