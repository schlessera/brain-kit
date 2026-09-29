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
const picked = (d: ReturnType<typeof route>) => {
  expect(d.kind).toBe("resolved");
  return (d as { model: ModelCapabilities; reason: string });
};
const SUNBURST = "gpt-image-2.5-sunburst";
const FLARE = "gpt-image-2.5-flare";

describe("availability", () => {
  test("no key means no models", () => {
    expect(availableModels(cfg, {} as NodeJS.ProcessEnv)).toEqual([]);
  });

  test("each key unlocks only its own provider", () => {
    expect(new Set(OPENAI_ONLY.map((m) => m.provider))).toEqual(new Set(["openai"]));
    expect(new Set(GEMINI_ONLY.map((m) => m.provider))).toEqual(new Set(["gemini"]));
  });

  test("disabledModels hides a model that would otherwise be available", () => {
    const limited = availableModels(configSchema.parse({ disabledModels: [SUNBURST] }), {
      OPENAI_API_KEY: "x",
    } as NodeJS.ProcessEnv);
    expect(ids(limited)).toEqual([FLARE]);
  });

  test("OpenAI offers exactly the two 2.5 models, and neither retired one", () => {
    expect(ids(OPENAI_ONLY)).toEqual([SUNBURST, FLARE]);
    expect(ids(ALL)).not.toContain("gpt-image-2");
    expect(ids(ALL)).not.toContain("gpt-image-1.5");
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

  test("transparency stays on the default model", () => {
    const d = picked(route({ request: { prompt: "x", transparent: true }, available: ALL }));
    expect(d.model.id).toBe(SUNBURST);
    expect(d.reason).toContain(SUNBURST);
  });

  test("transparency with an explicit Flare stays Flare — pinned or preferred", () => {
    const pinned = route({ request: { prompt: "x", transparent: true }, available: ALL, pinnedModel: FLARE });
    expect(picked(pinned).model.id).toBe(FLARE);
    const preferred = route({
      request: { prompt: "x", transparent: true, format: "webp" },
      available: ALL,
      preferredModels: [FLARE],
    });
    expect(picked(preferred).model.id).toBe(FLARE);
  });

  test("a mask, a custom size or a draft cannot move transparency off the selected model", () => {
    const masked = route({
      request: { prompt: "x", transparent: true, mask: img(), references: [img()] },
      available: ALL,
    });
    expect(picked(masked).model.id).toBe(SUNBURST);
    const sized = route({ request: { prompt: "x", transparent: true, size: "1360x768" }, available: ALL });
    expect(picked(sized).model.id).toBe(SUNBURST);
    const draft = route({ request: { prompt: "x", transparent: true }, available: ALL, intent: { draft: true } });
    expect(picked(draft).model.id).toBe(SUNBURST);
    const flareMask = route({
      request: { prompt: "x", transparent: true, mask: img(), references: [img()] },
      available: ALL,
      preferredModels: [FLARE],
    });
    expect(picked(flareMask).model.id).toBe(FLARE);
  });

  test("with Sunburst disabled, transparency goes to Flare — never to a retired model", () => {
    const flareOnly = availableModels(configSchema.parse({ disabledModels: [SUNBURST] }), {
      OPENAI_API_KEY: "x",
      GEMINI_API_KEY: "y",
    } as NodeJS.ProcessEnv);
    const d = route({ request: { prompt: "x", transparent: true }, available: flareOnly });
    expect(picked(d).model.id).toBe(FLARE);
  });

  test("transparency plus JPEG is refused — JPEG has no alpha channel", () => {
    const d = route({ request: { prompt: "x", transparent: true, format: "jpeg" }, available: ALL });
    expect(d.kind).toBe("impossible");
    expect((d as { reason: string }).reason).toMatch(/no alpha channel/i);
  });

  test("transparent JPEG is refused on an explicit Flare too", () => {
    const d = route({
      request: { prompt: "x", transparent: true, format: "jpeg" },
      available: ALL,
      preferredModels: [FLARE],
    });
    expect(d.kind).toBe("impossible");
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

  test("an exact custom pixel size forces a model that takes arbitrary dimensions", () => {
    const d = picked(route({ request: { prompt: "x", size: "1360x768" }, available: ALL }));
    expect(d.model.arbitraryDimensions).toBe(true);
    expect(d.model.id).toBe(SUNBURST);
  });

  test("a size that breaks OpenAI's custom-size rules is refused before any call", () => {
    for (const size of [
      "1234x768", // not on the 16px grid
      "3840x1072", // wider than 3:1
      "512x512", // under the 655,360-pixel floor
      "3840x3840", // over the 8.3MP ceiling
    ]) {
      const d = route({ request: { prompt: "x", size }, available: ALL });
      expect(d.kind).toBe("impossible");
    }
  });

  test("an aspect ratio wider than 3:1 is refused rather than sent", () => {
    const d = route({ request: { prompt: "x", aspect: "4:1" }, available: ALL });
    expect(d.kind).toBe("impossible");
    expect((d as { reason: string }).reason).toMatch(/3:1/);
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
    // (That lead was measured on gpt-image-2, now retired; the 2.5 default
    // is a maintainer decision, not a successor to the measurement.)
    const d = route({ request: { prompt: "a poster" }, available: ALL, intent: { textInImage: true } });
    expect(picked(d).model.id).toBe(SUNBURST);
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

  test("draft takes the named quick-illustration model", () => {
    const d = route({ request: { prompt: "x" }, available: ALL, intent: { draft: true } });
    expect(d.kind).toBe("resolved");
    expect((d as { model: ModelCapabilities }).model.id).toBe("gemini-3.1-flash-lite-image");
  });

  test("draft falls back to the cheapest that fits when the lite model cannot serve", () => {
    // Lite is 1K-only, so a 2K request removes it before routing gets here.
    const d = route({ request: { prompt: "x", resolution: "2K" }, available: ALL, intent: { draft: true } });
    expect(d.kind).toBe("resolved");
    const picked = (d as { model: ModelCapabilities }).model;
    expect(picked.id).not.toBe("gemini-3.1-flash-lite-image");
    expect((d as { reason: string }).reason).toMatch(/unavailable/);
  });

  test("draft with no priced model left takes the preference order, not a guessed price", () => {
    // Only the 2.5 models take a mask; neither has a published per-image price.
    const d = picked(
      route({ request: { prompt: "x", mask: img(), references: [img()] }, available: ALL, intent: { draft: true } })
    );
    expect(d.model.id).toBe(SUNBURST);
  });

  test("the named cases each land on their model", () => {
    // The policy in one test: default (quality and transparency alike), throwaway.
    const quality = route({ request: { prompt: "a precise product shot" }, available: ALL });
    expect((quality as { model: ModelCapabilities }).model.id).toBe(SUNBURST);

    const transparent = route({ request: { prompt: "a logo", transparent: true }, available: ALL });
    expect((transparent as { model: ModelCapabilities }).model.id).toBe(SUNBURST);

    const quick = route({ request: { prompt: "a doodle" }, available: ALL, intent: { draft: true } });
    expect((quick as { model: ModelCapabilities }).model.id).toBe("gemini-3.1-flash-lite-image");
  });
});

describe("ambiguity", () => {
  test("a plain prompt resolves to Sunburst, as the default — not as an arena ranking", () => {
    const d = picked(route({ request: { prompt: "a nice landscape" }, available: ALL }));
    expect(d.model.id).toBe(SUNBURST);
    expect(d.reason).toMatch(/default image model/);
    // The arena figures were measured on gpt-image-2; they are not quoted
    // as the reason for choosing a 2.5 model.
    expect(d.reason).not.toMatch(/arena/);
  });

  test("with Sunburst disabled, an ordinary request gets Flare", () => {
    const flareOnly = availableModels(configSchema.parse({ disabledModels: [SUNBURST] }), {
      OPENAI_API_KEY: "x",
      GEMINI_API_KEY: "y",
    } as NodeJS.ProcessEnv);
    expect(picked(route({ request: { prompt: "x" }, available: flareOnly })).model.id).toBe(FLARE);
  });

  test("with Gemini only, the default prefers Flash over the pricier Pro", () => {
    // Pro is the more expensive model, not the better-scoring one: Flash is
    // ahead on both arenas (1264 vs 1246 text-to-image).
    const d = picked(route({ request: { prompt: "a nice landscape" }, available: GEMINI_ONLY }));
    expect(d.model.id).toBe("gemini-3.1-flash-image");
    expect(d.reason).toMatch(/arenas/);
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

  test("with only OpenAI, the default is still Sunburst", () => {
    expect(picked(route({ request: { prompt: "x" }, available: OPENAI_ONLY })).model.id).toBe(SUNBURST);
  });
});

describe("pinning", () => {
  test("an explicit model wins over every heuristic", () => {
    const d = route({
      request: { prompt: "x" },
      available: ALL,
      pinnedModel: "gemini-3-pro-image",
      intent: { draft: true, textInImage: true },
    });
    expect(d.kind).toBe("resolved");
    expect((d as { model: ModelCapabilities }).model.id).toBe("gemini-3-pro-image");
  });

  test("a pin does not exempt the request from what the pinned model can do", () => {
    // Pinning used to return before any capability rule, so these reached
    // the provider: Gemini would have ignored the transparency, and OpenAI
    // would have rejected the size after the request was sent.
    const cases: [Parameters<typeof route>[0]["request"], string][] = [
      [{ prompt: "x", transparent: true }, "gemini-3-pro-image"],
      [{ prompt: "x", size: "1234x768" }, FLARE],
      [{ prompt: "x", transparent: true, format: "jpeg" }, FLARE],
      [{ prompt: "x", aspect: "4:1" }, SUNBURST],
      [{ prompt: "x", mask: img(), references: [img()] }, "gemini-3.1-flash-image"],
    ];
    for (const [request, pinnedModel] of cases) {
      expect(route({ request, available: ALL, pinnedModel }).kind).toBe("impossible");
    }
  });

  test("an unknown pinned model lists what is available", () => {
    const d = route({ request: { prompt: "x" }, available: ALL, pinnedModel: "dall-e-2" });
    expect(d.kind).toBe("impossible");
    expect((d as { reason: string }).reason).toContain(SUNBURST);
  });

  test("an explicit Flare stays Flare", () => {
    expect(picked(route({ request: { prompt: "x" }, available: ALL, pinnedModel: FLARE })).model.id).toBe(FLARE);
  });

  for (const retired of ["gpt-image-2", "gpt-image-1.5"]) {
    test(`pinning retired ${retired} is a migration error naming both replacements`, () => {
      const d = route({ request: { prompt: "x", transparent: true }, available: ALL, pinnedModel: retired });
      expect(d.kind).toBe("impossible");
      const reason = (d as { reason: string }).reason;
      expect(reason).toMatch(/retired/);
      expect(reason).toContain(SUNBURST);
      expect(reason).toContain(FLARE);
    });

    test(`${retired} in preferredModels is a migration error, not a silent skip`, () => {
      const d = route({ request: { prompt: "x" }, available: ALL, preferredModels: [retired, FLARE] });
      expect(d.kind).toBe("impossible");
      expect((d as { reason: string }).reason).toMatch(/retired.*preferredModels|preferredModels.*retired/s);
    });
  }

  test("pinning a provider with no key is impossible", () => {
    const d = route({ request: { prompt: "x" }, available: GEMINI_ONLY, pinnedProvider: "openai" });
    expect(d.kind).toBe("impossible");
  });
});
