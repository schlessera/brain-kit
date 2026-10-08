import preview from "#.storybook/preview";
import { fn } from "storybook/test";
import { RecordingRow } from "../../src/rows/RecordingRow.js";
import { stage } from "../_stage.js";
const meta = preview.meta({ title: "Rows/RecordingRow", component: RecordingRow, decorators: [stage], args: {
  time: "09:12", length: "2:14", durationLabel: "2 minutes 14 seconds", state: "saved" as const, onPlay: fn(), onDiscard: fn(),
} });
export const Saved = meta.story({});
export const Recording = meta.story({ args: { state: "recording", onPlay: undefined, onDiscard: undefined } });
export const Interrupted = meta.story({ args: { state: "interrupted", savedThrough: "2:13" } });
export const Transcribing = meta.story({ args: { state: "transcribing" } });
export const TranscriptReady = meta.story({ args: { state: "transcript-ready" } });
export const Failed = meta.story({ args: { state: "failed" } });
export const Accepted = meta.story({ args: { state: "accepted" } });
export const Offline = meta.story({ args: { offline: true } });
