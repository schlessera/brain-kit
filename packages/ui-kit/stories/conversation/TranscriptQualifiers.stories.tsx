import preview from "#.storybook/preview";
import { expect, userEvent, within } from "storybook/test";
import { TranscriptQualifiers, TranscriptSymbols } from "../../src/conversation/TranscriptQualifiers.js";
import { stage } from "../_stage.js";

const meta = preview.meta({
  title: "Conversation/TranscriptQualifiers", component: TranscriptQualifiers, decorators: [stage],
  parameters: { stageWidth: 320 },
  args: { kind: "recognized", source: "Gemini Live", finish: "unknown", evidenceLabel: "Technical evidence (3 fragments)", children: <p>Unassigned input; speaker unverified. Timing unavailable.</p> },
});
export const Recognized = meta.story({ args: { kind: "recognized", evidenceLabel: "Technical evidence (3 fragments)", children: <p>Unassigned input; speaker unverified. Timing unavailable.</p> }, render: args => <div style={{ width: "100%", padding: 4, overflowWrap: "anywhere" }}><TranscriptSymbols /><p>Find the raft preparation notes and check the launch list.<TranscriptQualifiers {...args} /></p></div>, play: async ({ canvasElement }) => {
  const control = canvasElement.querySelector<HTMLButtonElement>("[data-transcript-qualifiers]")!;
  await expect(control.getAttribute("aria-label")).toContain("Transcript details.");
  await expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  await userEvent.click(control);
  const body = within(canvasElement.ownerDocument.body);
  await expect(body.getByRole("dialog", { name: "Transcript details" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect(control).toHaveFocus();
} });
export const Wide = Recognized.extend({ parameters: { stageWidth: 860 } });
export const Generated = Recognized.extend({ args: { kind: "generated", source: "GPT-Live", playback: "unknown", finish: undefined } });
export const Played = Generated.extend({ args: { playback: "played" } });
export const NotSpoken = Generated.extend({ args: { playback: "not-spoken" } });
export const Unsaved = Generated.extend({ args: { unsaved: true } });
export const UnsavedRecognition = Recognized.extend({ args: { unsaved: true } });
export const Restored = Generated.extend({ args: { restored: true, orderUnknown: true } });
export const SourceUnknown = Generated.extend({ args: { source: undefined } });
export const TaskRequest = Recognized.extend({ args: { kind: "task-request", source: "host task", finish: undefined, evidenceLabel: "Technical evidence (host request)", children: <><p>Submitted host instruction</p><pre>{'{"context":"Find the raft notes."}'}</pre></> } });
export const TaskResult = TaskRequest.extend({ args: { kind: "task-result" } });
export const LargeLongText = Recognized.extend({ render: args => <div style={{ width: "100%", padding: 4, fontSize: "200%", overflowWrap: "anywhere" }}><p>{"Find the raft preparation notes and compare the launch list. ".repeat(12)}<TranscriptQualifiers {...args} /></p></div> });
