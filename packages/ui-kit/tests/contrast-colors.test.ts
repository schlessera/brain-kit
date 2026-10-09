import { expect, test } from "bun:test";
import { parse } from "./_contrast.js";

test("Chromium sRGB color-mix serialization keeps normalized channels and alpha", () => {
  const translucent = parse("color(srgb 1 0.5 0 / 0.8)");
  expect(translucent.rgb).toEqual([255, 127.5, 0]);
  expect(translucent.alpha).toBe(0.8);
  expect(parse("color(srgb 0 0.5 1)")).toEqual({ rgb: [0, 127.5, 255], alpha: 1 });
});
