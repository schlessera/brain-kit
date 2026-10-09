import { expect } from "vitest";
import { rankingJourneys } from "../../fixtures/ranking.js";

export const initial = rankingJourneys.slice(0, 5).map((item) => item.id);
export const order = () => [...document.querySelectorAll<HTMLElement>("[data-rank-row]")].map((row) => row.dataset.rankRow);

export async function previewFonts() {
  const faces = ["400 12px 'DM Serif Text'", "italic 400 12px 'DM Serif Text'",
    ...[400, 500, 600].map((weight) => `${weight} 11px 'JetBrains Mono'`),
    ...[400, 500, 600, 700].map((weight) => `${weight} 13px 'Plus Jakarta Sans'`)];
  for (const face of faces) {
    const loaded = await document.fonts.load(face, "Odysseus");
    expect(loaded.length, `required preview face: ${face}`).toBeGreaterThan(0);
    expect(loaded.every((font) => font.status === "loaded")).toBe(true);
  }
  await document.fonts.ready;
}

export function containedActions(names: string[]) {
  const footer = document.querySelector<HTMLElement>("[data-rank-actions]")!;
  const card = document.querySelector<HTMLElement>(".bk-askrank")!.getBoundingClientRect();
  const buttons = [...footer.querySelectorAll<HTMLElement>('button, [role="button"]')];
  expect(buttons.map((button) => button.textContent?.trim())).toEqual(names);
  for (const button of buttons) {
    const bounds = button.getBoundingClientRect();
    expect(bounds.width).toBeGreaterThan(0); expect(bounds.height).toBeGreaterThan(0);
    expect(bounds.left).toBeGreaterThanOrEqual(card.left);
    expect(bounds.right).toBeLessThanOrEqual(card.right);
    expect(bounds.top).toBeGreaterThanOrEqual(card.top);
    expect(bounds.bottom).toBeLessThanOrEqual(card.bottom);
    expect(button.getAttribute("aria-disabled")).not.toBe("true");
  }
}
