import { describe, expect, test } from "bun:test";

import {
  isValidOpenAiSize,
  aspectToOpenAiSize,
  GEMINI_ASPECTS,
  isGeminiAspect,
  OPENAI_LIMITS,
  parseAspect,
  sizeToNearestGeminiAspect,
} from "../src/shape";
import { route } from "../src/routing";
import { availableModels } from "../src/providers/index";
import { configSchema } from "../src/module";
import type { ModelCapabilities } from "../src/types";

const cfg = configSchema.parse({});
const ALL = availableModels(cfg, { OPENAI_API_KEY: "x", GEMINI_API_KEY: "y" } as NodeJS.ProcessEnv);
const GEMINI_ONLY = availableModels(cfg, { GEMINI_API_KEY: "y" } as NodeJS.ProcessEnv);

function dims(size: string) {
  const [w, h] = size.split("x").map(Number);
  return { w, h, total: w * h };
}

describe("parseAspect", () => {
  test("accepts W:H", () => expect(parseAspect("16:9")).toEqual({ w: 16, h: 9 }));
  test("rejects nonsense", () => {
    for (const bad of ["16-9", "16:", "a:b", "0:1", "", "16:9:2"]) {
      expect(parseAspect(bad)).toBeNull();
    }
  });
});

describe("aspectToOpenAiSize", () => {
  test("every Gemini-legal ratio maps to a size OpenAI accepts", () => {
    for (const aspect of GEMINI_ASPECTS) {
      for (const res of ["512px", "1K", "2K", "4K"] as const) {
        const size = aspectToOpenAiSize(aspect, res);
        expect(size).not.toBeNull();
        const { w, h, total } = dims(size!);
        // Every published constraint, asserted for every combination.
        expect(w % OPENAI_LIMITS.grid).toBe(0);
        expect(h % OPENAI_LIMITS.grid).toBe(0);
        expect(Math.max(w, h)).toBeLessThanOrEqual(OPENAI_LIMITS.maxEdge);
        expect(total).toBeGreaterThanOrEqual(OPENAI_LIMITS.minTotalPixels);
        expect(total).toBeLessThanOrEqual(OPENAI_LIMITS.maxTotalPixels);
      }
    }
  });

  test("keeps the requested ratio within a few percent", () => {
    for (const aspect of ["16:9", "9:16", "4:3", "1:1", "21:9"]) {
      const { w, h } = dims(aspectToOpenAiSize(aspect, "1K")!);
      const want = parseAspect(aspect)!;
      const drift = Math.abs(w / h - want.w / want.h) / (want.w / want.h);
      expect(drift).toBeLessThan(0.05);
    }
  });

  test("512px is scaled UP to OpenAI's floor rather than rejected", () => {
    // 512x512 is 262,144 pixels — below the 655,360 minimum.
    const { total } = dims(aspectToOpenAiSize("1:1", "512px")!);
    expect(total).toBeGreaterThanOrEqual(OPENAI_LIMITS.minTotalPixels);
  });

  test("4K at an extreme ratio stays inside both the edge and pixel caps", () => {
    const { w, h, total } = dims(aspectToOpenAiSize("21:9", "4K")!);
    expect(Math.max(w, h)).toBeLessThanOrEqual(3840);
    expect(total).toBeLessThanOrEqual(8_294_400);
  });

  test("a malformed ratio yields null", () => {
    expect(aspectToOpenAiSize("wide", "1K")).toBeNull();
  });
});

describe("isValidOpenAiSize", () => {
  test("accepts sizes inside every published rule", () => {
    for (const [w, h] of [[1024, 1024], [1360, 768], [3840, 2160], [2400, 800], [816, 816]]) {
      expect(isValidOpenAiSize(w, h)).toBe(true);
    }
  });
  test("refuses off-grid, too wide, too small, too large and too long", () => {
    for (const [w, h] of [[1234, 768], [2448, 800], [800, 800], [3840, 3840], [3856, 1024]]) {
      expect(isValidOpenAiSize(w, h)).toBe(false);
    }
  });
});

describe("sizeToNearestGeminiAspect", () => {
  test("snaps to the closest legal ratio", () => {
    expect(sizeToNearestGeminiAspect("1920x1080")).toBe("16:9");
    expect(sizeToNearestGeminiAspect("1024x1024")).toBe("1:1");
    expect(sizeToNearestGeminiAspect("1080x1920")).toBe("9:16");
  });
  test("rejects a non-size", () => expect(sizeToNearestGeminiAspect("big")).toBeNull());
});

describe("isGeminiAspect", () => {
  test("accepts the documented ten", () => {
    for (const a of GEMINI_ASPECTS) expect(isGeminiAspect(a)).toBe(true);
  });
  test("rejects anything else", () => {
    for (const a of ["7:3", "1:2", "5:1"]) expect(isGeminiAspect(a)).toBe(false);
  });
});

describe("routing on shape", () => {
  test("an off-list ratio forces a model that takes exact pixels", () => {
    const d = route({ request: { prompt: "x", aspect: "7:3" }, available: ALL });
    expect(d.kind).toBe("resolved");
    // Gemini offers ten fixed ratios; only an OpenAI model can express an
    // arbitrary one as exact pixels.
    expect((d as { model: ModelCapabilities }).model.provider).toBe("openai");
  });

  test("a preset size with transparency stays on the default model", () => {
    const d = route({ request: { prompt: "x", size: "1024x1024", transparent: true }, available: ALL });
    expect(d.kind).toBe("resolved");
    expect((d as { model: ModelCapabilities }).model.id).toBe("gpt-image-2.5-sunburst");
  });

  test("a custom size plus transparency is served — both 2.5 models take custom sizes", () => {
    const d = route({ request: { prompt: "x", size: "1360x768", transparent: true }, available: ALL });
    expect(d.kind).toBe("resolved");
    expect((d as { model: ModelCapabilities }).model.id).toBe("gpt-image-2.5-sunburst");
  });

  test("an illegal custom size says what the rules are", () => {
    const d = route({ request: { prompt: "x", size: "1234x768" }, available: ALL });
    expect(d.kind).toBe("impossible");
    expect((d as { reason: string }).reason).toMatch(/multiples of 16/);
  });

  test("an off-list ratio with only Gemini explains the legal set", () => {
    const d = route({ request: { prompt: "x", aspect: "7:3" }, available: GEMINI_ONLY });
    expect(d.kind).toBe("impossible");
    expect((d as { reason: string }).reason).toContain("21:9");
  });

  test("2K drops the 1K-only model", () => {
    const d = route({ request: { prompt: "x", resolution: "2K" }, available: GEMINI_ONLY });
    expect(d.kind).toBe("resolved");
    expect((d as { model: ModelCapabilities }).model.id).not.toBe("gemini-3.1-flash-lite-image");
  });

  test("a legal ratio leaves both providers in play, and the default decides", () => {
    const d = route({ request: { prompt: "x", aspect: "16:9" }, available: ALL });
    expect(d.kind).toBe("resolved");
    expect((d as { model: ModelCapabilities }).model.id).toBe("gpt-image-2.5-sunburst");
  });
});
