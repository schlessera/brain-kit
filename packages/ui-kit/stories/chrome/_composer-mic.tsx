import type { ReactElement } from "react";
import { fn } from "storybook/test";

import { Composer, type ComposerProps } from "../../src/chrome/Composer.js";
import { MicButton, type MicButtonProps } from "../../src/voice/MicButton.js";

/**
 * The composer states with a caller's `MicButton` (#3727), built once so the
 * stories and the visual baselines draw the same thing. Odysseus world copy.
 */
export const PROVIDER = "local · 8b";
export const REVIEW = "Ask Calypso about the axe and the sail cloth.";
export const REVIEW_LINES = "Ask Calypso\nabout the axe\nand the sail cloth.";

export type ComposerMicId = "D1" | "S1" | "S1-talk-live" | "D6" | "D6-three-lines" | "offline";

export const COMPOSER_MIC_TITLES: Record<ComposerMicId, string> = {
  D1: "Rest",
  S1: "Holding · hint above the mic",
  "S1-talk-live": "“Talk live…” focused",
  D6: "Review · one line",
  "D6-three-lines": "Review · three lines",
  offline: "Offline · Record on this device",
};

/** The composer as the app draws it, with a caller's `MicButton` in the mic slot. */
export function composerWithMic(id: ComposerMicId, value?: string): ReactElement {
  const composer = (mic: MicButtonProps, props: ComposerProps = {}) => (
    <Composer provider={PROVIDER} onProvider={fn()} onAttach={fn()} onSend={fn()} onChange={fn()} {...props} micControl={<MicButton onClick={fn()} {...mic} />} />
  );
  switch (id) {
    case "D1":
      return composer({ name: "Dictate", onTalkLive: fn() });
    case "S1":
      // Nothing is captured during a hold: the ring fills and the hint explains.
      return composer({ name: "Dictate", onTalkLive: fn(), phase: "holding", progress: 0.6, hint: true });
    case "S1-talk-live":
      return composer({ name: "Dictate", onTalkLive: fn() });
    case "D6":
      // M2: the dictated words are plain editable text, and the hint line is the normal `ready` one.
      return composer({ name: "Dictate more" }, { value: value ?? REVIEW });
    case "D6-three-lines":
      return composer({ name: "Dictate more" }, { value: value ?? REVIEW_LINES });
    case "offline":
      // M1: no `onTalkLive`, no hint and always `idle`, so a hold is a tap.
      return composer({ name: "Record on this device" }, { state: "offline" });
  }
}

