/// <reference types="@vitest/browser/matchers" />
import { expect, test } from "vitest";
import { requirePaintedFont } from "./design-font-checks.js";
import * as stories from "../../stories/rows/RecordingRow.stories.js";

const rows = { Saved: stories.Saved, Recording: stories.Recording, Interrupted: stories.Interrupted, Transcribing: stories.Transcribing, TranscriptReady: stories.TranscriptReady, Failed: stories.Failed, Accepted: stories.Accepted, Offline: stories.Offline };
for (const theme of ["dark", "light"]) for (const [state, story] of Object.entries(rows)) {
  test(`recording row ${state} ${theme}`, async () => {
    await story.run({ globals: { theme } });
    expect(document.documentElement.dataset.theme).toBe(theme);
    const row = document.querySelector<HTMLElement>("[data-recording-row]")!;
    expect(row).toBeTruthy();
    expect(row.querySelector("div:first-child > span:nth-child(2)")?.textContent).toBe("09:12 · 2:14");
    await requirePaintedFont("[data-recording-row] > div:first-child > span:nth-child(2), [data-recording-row] > div:first-child > b", "JetBrains Mono");
    await expect(row).toMatchScreenshot(`recording-${state}-${theme}`);
  });
}
