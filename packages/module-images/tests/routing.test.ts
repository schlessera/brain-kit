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
  test("in-image text routes to Gemini", () => {
    const d = route({ request: { prompt: "a poster" }, available: ALL, intent: { textInImage: true } });
    expect(d.kind).toBe("resolved");
    expect((d as { model: ModelCapabilities }).model.provider).toBe("gemini");
  });

  test("character consistency routes to Gemini and names the guarantee", () => {
    const d = route({
      request: { prompt: "the same knight again" },
      available: ALL,
      intent: { characterConsistency: true },
    });
    expect(d.kind).toBe("resolved");
    const resolved = d as { model: ModelCapabilities; reason: string };
    expect(resolved.model.characterConsistency).toBeGreaterThan(0);
    expect(resolved.reason).toMatch(/characters/);
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
  test("a plain prompt across two providers asks instead of guessing", () => {
    const d = route({ request: { prompt: "a nice landscape" }, available: ALL });
    expect(d.kind).toBe("ambiguous");
    const amb = d as { candidates: ModelCapabilities[]; reason: string };
    expect(amb.candidates.length).toBeGreaterThan(1);
    expect(amb.reason).toMatch(/no vendor benchmark/i);
  });

  test("a plain prompt with one provider resolves to its strongest model", () => {
    const d = route({ request: { prompt: "a nice landscape" }, available: GEMINI_ONLY });
    expect(d.kind).toBe("resolved");
    expect((d as { model: ModelCapabilities }).model.id).toBe("gemini-3-pro-image");
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
