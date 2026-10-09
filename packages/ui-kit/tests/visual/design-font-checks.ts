import { expect } from "vitest";
import { commands } from "vitest/browser";

export const previewFaces = [
  { family: "DM Serif Text", weight: 400, style: "normal" },
  { family: "DM Serif Text", weight: 400, style: "italic" },
  ...[400, 500, 600, 700].map(weight => ({ family: "JetBrains Mono", weight, style: "normal" })),
  ...[400, 500, 600, 700].map(weight => ({ family: "Plus Jakarta Sans", weight, style: "normal" })),
];

// Internal names read from the checksum-locked TTF name tables (not CSS aliases).
const identities: Record<string, Record<string, string>> = {
  "DM Serif Text": { "DMSerifText-Regular": "DM Serif Text", "DMSerifText-Italic": "DM Serif Text" },
  "JetBrains Mono": { "JetBrainsMono-Regular": "JetBrains Mono", "JetBrainsMono-Medium": "JetBrains Mono Medium", "JetBrainsMono-SemiBold": "JetBrains Mono SemiBold" },
  "Plus Jakarta Sans": { "PlusJakartaSans-Regular": "Plus Jakarta Sans", "PlusJakartaSans-Medium": "Plus Jakarta Sans Medium", "PlusJakartaSans-SemiBold": "Plus Jakarta Sans SemiBold", "PlusJakartaSans-Bold": "Plus Jakarta Sans" },
};

export async function loadDesignFonts() {
  for (const { family, weight, style } of previewFaces) {
    const faces = await document.fonts.load(`${style} ${weight} 16px '${family}'`, "Odysseus 09:12 accepted");
    expect(faces.length, `required preview face: ${family} ${style} ${weight}`).toBeGreaterThan(0);
    expect(faces.every(face => face.status === "loaded")).toBe(true);
  }
  await document.fonts.ready;
}

export async function requirePaintedFont(selector: string, family: string) {
  const targets = await commands.designFontUsage(selector);
  expect(targets.length, `nonempty ${family} targets`).toBeGreaterThan(0);
  for (const fonts of targets) {
    const painted = fonts.filter(font => font.glyphCount > 0);
    expect(painted.length, `nonempty ${family} painted glyphs`).toBeGreaterThan(0);
    expect(painted.every(font => font.isCustomFont && identities[family]?.[font.postScriptName] === font.familyName),
      `painted ${family} glyphs: ${JSON.stringify(painted)}`).toBe(true);
  }
  return targets;
}

/** Every locked weight/style, including the host's synthesized 700 mono status. */
export async function verifyDesignFonts() {
  const host = document.createElement("div");
  host.dataset.designFontChecks = "";
  host.style.cssText = "position:fixed;left:0;top:0;pointer-events:none;background:white;color:black";
  for (const { family, weight, style } of previewFaces) {
    const probe = document.createElement("span");
    probe.dataset.fontFamily = family;
    probe.style.font = `${style} ${weight} 16px '${family}'`;
    probe.textContent = "Odysseus 09:12 accepted";
    host.append(probe);
  }
  document.body.append(host);
  try {
    const observations: Record<string, Awaited<ReturnType<typeof requirePaintedFont>>> = {};
    for (const family of ["DM Serif Text", "JetBrains Mono", "Plus Jakarta Sans"]) {
      observations[family] = await requirePaintedFont(`[data-design-font-checks] [data-font-family="${family}"]`, family);
    }
    return observations;
  } finally { host.remove(); }
}
