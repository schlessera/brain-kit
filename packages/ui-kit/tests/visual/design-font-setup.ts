import { afterEach, beforeAll, beforeEach, expect } from "vitest";
import { commands } from "vitest/browser";
import { loadDesignFonts, verifyDesignFonts } from "./design-font-checks.js";

let requiredFaces: string[];
let fontStyle: HTMLStyleElement;
let pinnedCss: string;

const faceManifest = () => [...document.fonts].map(face => `${face.family}|${face.weight}|${face.style}`).sort();

beforeAll(async () => {
  // Data URLs contain checksum-verified cache bytes; no browser font downloads.
  fontStyle = document.createElement("style");
  fontStyle.dataset.designFonts = "";
  fontStyle.textContent = pinnedCss = await commands.designFonts();
  document.head.append(fontStyle);
  await loadDesignFonts();
  requiredFaces = faceManifest();
  await verifyDesignFonts();
});

function stableFontInputs() {
  expect(fontStyle.isConnected, "shared design-font stylesheet stays installed").toBe(true);
  expect(fontStyle.textContent, "shared stylesheet retains the verified bytes").toBe(pinnedCss);
  expect(faceManifest(), "only the pinned faces remain; no aliases or duplicate stylesheets").toEqual(requiredFaces);
}
beforeEach(async () => {
  stableFontInputs();
  // Chromium may invalidate unused FontFace load states when a fixture adds
  // consumer CSS. Re-load the same verified faces before the next render.
  await loadDesignFonts();
});
afterEach(stableFontInputs);
