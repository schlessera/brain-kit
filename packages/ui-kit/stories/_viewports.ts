/**
 * The viewports the consumer-parity stories are drawn at.
 *
 * A consumer story's `width` arg used to reach only the Vitest runner, where
 * `consumerViewport` resizes the page. Opened by hand, the story rendered at
 * whatever width the canvas had, so `Settings/Storage → Phone` showed the
 * desktop layout and could not be checked at phone width (#3749). The story
 * now also selects the matching Storybook viewport through `atWidth()`, and
 * the runner refuses a story whose width and viewport disagree.
 *
 * The height matches the 800px the runner resizes to.
 */
import { MINIMAL_VIEWPORTS } from "storybook/viewport";

export const CONSUMER_WIDTHS = [320, 390, 900, 1280] as const;
export type ConsumerWidth = (typeof CONSUMER_WIDTHS)[number];

export const consumerViewportKey = (width: number) => `consumer-${width}`;

export const CONSUMER_VIEWPORTS = Object.fromEntries(
  CONSUMER_WIDTHS.map((width) => [
    consumerViewportKey(width),
    {
      name: `${width < 900 ? "Phone" : width < 1280 ? "Laptop" : "Desktop"} ${width}`,
      styles: { width: `${width}px`, height: "800px" },
      type: width < 900 ? "mobile" : "desktop",
    },
  ]),
);

/** Every viewport the toolbar offers: Storybook's defaults plus the consumer widths. */
export const VIEWPORT_OPTIONS = { ...MINIMAL_VIEWPORTS, ...CONSUMER_VIEWPORTS };

/** The `globals` that open a story at `width`. */
export const viewportAt = (width: ConsumerWidth) => ({ viewport: { value: consumerViewportKey(width), isRotated: false } });

/** `args.width` and its viewport together, for a story that only changes width. */
export const atWidth = (width: ConsumerWidth) => ({ args: { width }, globals: viewportAt(width) });
