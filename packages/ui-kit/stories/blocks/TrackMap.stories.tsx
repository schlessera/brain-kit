import preview from "#.storybook/preview";
import { expect } from "storybook/test";
import { ithacaTrack, partialTrack, polarTrack, wideTrack } from "../../fixtures/tracks.js";
import { TrackMap } from "../../src/blocks/TrackMap.js";
import { overflowing, stage, wide } from "../_stage.js";

const meta = preview.meta({ title: "Blocks/TrackMap", component: TrackMap, decorators: [stage], args: ithacaTrack });
export const Loop = meta.story({
  play: async ({ canvasElement }) => {
    await expect(canvasElement.textContent).toContain("10.00 km");
    await expect(canvasElement.textContent).toContain("Raft timber stand");
    await expect(canvasElement.querySelectorAll("polyline")).toHaveLength(1);
    await expect(canvasElement.querySelector('[data-track-marker="start_end"]')).not.toBeNull();
    await expect(overflowing(canvasElement)).toEqual([]);
  },
});
export const Phone = Loop.extend({ parameters: { stageWidth: 288 } });
export const Wide = Loop.extend({ parameters: wide });
export const Partial = meta.story({ args: partialTrack, play: async ({ canvasElement }) => {
  await expect(canvasElement.querySelectorAll("polyline")).toHaveLength(2);
  await expect(canvasElement.textContent).toContain("latitude out of range: 1");
  await expect(canvasElement.textContent).toContain("usable sections only");
  await expect(overflowing(canvasElement)).toEqual([]);
} });
export const WidePlain = meta.story({ args: wideTrack, play: async ({ canvasElement }) => {
  await expect(canvasElement.textContent).toContain("Track only");
  await expect(canvasElement.querySelector('[data-track-marker="start"]')).not.toBeNull();
  await expect(canvasElement.querySelector('[data-track-marker="end"]')).not.toBeNull();
  await expect(overflowing(canvasElement)).toEqual([]);
} });
export const UnsupportedProjection = meta.story({ args: polarTrack, play: async ({ canvasElement }) => {
  await expect(canvasElement.querySelector("polyline")).toBeNull();
  await expect(canvasElement.textContent).toContain("Coordinates are preserved");
  await expect(canvasElement.textContent).toContain("Original:");
  await expect(canvasElement.textContent).toContain("Raft timber stand");
  await expect(overflowing(canvasElement)).toEqual([]);
} });
