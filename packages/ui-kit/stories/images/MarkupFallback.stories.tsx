import preview from "#.storybook/preview";

import { MarkupFallback } from "../../src/images/MarkupResultCard.js";
import { RAFT_PATH } from "./_raft.js";

const fallback = preview.meta({ title: "Images/Markup fallback", component: MarkupFallback, args: { imagePath: RAFT_PATH, reason: "The user closed the markup editor" } });
export const Closed = fallback.story({});
export const VoiceRefused = fallback.story({ args: { reason: "Markup needs the screen; this is a voice turn" } });
export const SourceChanged = fallback.story({ args: { reason: "photos/raft-at-ithaca.jpg changed while the editor was open" } });
