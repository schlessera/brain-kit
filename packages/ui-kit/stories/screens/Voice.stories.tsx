import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { MessageBubble } from "../../src/chrome/MessageBubble.js";
import { ScreenBody } from "../../src/chrome/ScreenBody.js";
import { ScreenHeader } from "../../src/chrome/ScreenHeader.js";
import { MicButton } from "../../src/voice/MicButton.js";
import { StartCard } from "../../src/voice/StartCard.js";
import { SpokenTurn, UncertainWord, UnplayedText, VoiceToolChip } from "../../src/voice/SpokenTurn.js";
import { VoiceControlButton } from "../../src/voice/VoiceControlButton.js";
import { VoiceField, VoiceText } from "../../src/voice/VoiceField.js";
import { phone } from "../_phone.js";
import { overflowing } from "../_stage.js";

/**
 * The voice redesign assembled (#3692, direction 3a on #3690): a chat plus
 * the voice field, one representative state per group, matching the mockup
 * sheets. Pure composition, like every screen: only kit components and
 * layout. The field sits where the composer does, so each state can be read
 * in place: dictation (D3), the Start card (S2) and live speaking (L4).
 */
const meta = preview.meta({
  title: "Screens/Voice",
  component: VoiceField,
  decorators: [phone()],
  parameters: { layout: "centered" },
});

const header = <ScreenHeader variant="nav" title="Raft launch" back />;

const ask = "What’s left before the raft launches?";
const answer = "Two things: the timber tally and a cask for the water. The cask is the one at risk.";

/** D3: the field fills amber and the words land in it. */
export const Dictating = meta.story({
  render: () => (
    <>
      {header}
      <ScreenBody padding="14px 16px 10px" gap={12} overflow="auto" style={{ justifyContent: "flex-end" }}>
        <MessageBubble role="user" text={ask} actions={false} />
        <MessageBubble role="brain" text={answer} actions={false} />
      </ScreenBody>
      <div style={{ padding: "6px 12px 18px" }}>
        <VoiceField
          shape="compact"
          tone="you"
          label={{ icon: "mic", word: "Listening" }}
          meter="level"
          level={0.8}
          trailing={<VoiceControlButton name="Finish dictation" icon="confirm" tone="you" onClick={fn()} />}
        >
          <VoiceText text="Ask Calypso about the axe" partial="and the sail" />
        </VoiceField>
      </div>
    </>
  ),
  play: async ({ canvasElement }) => {
    await expect(overflowing(canvasElement.firstElementChild as HTMLElement)).toEqual([]);
  },
});

/** S2: the held mic opens the field into the Start card. */
export const Starting = meta.story({
  render: () => (
    <>
      {header}
      <ScreenBody padding="14px 16px 10px" gap={12} overflow="auto" style={{ justifyContent: "flex-end" }}>
        <MessageBubble role="brain" text={answer} actions={false} />
      </ScreenBody>
      <div style={{ padding: "6px 12px 18px" }}>
        <StartCard
          service="Gemini Live"
          onChangeService={fn()}
          personas={[
            { id: "standard", name: "Standard", voice: "voice Kore" },
            { id: "steward", name: "Ithaca steward", voice: "voice Kore · calm, brief" },
            { id: "storyteller", name: "Harbour storyteller", voice: "no Gemini voice set" },
          ]}
          selectedPersona="steward"
          onSelectPersona={fn()}
          shared={["Your microphone audio goes to Gemini Live through this app’s host while the conversation runs."]}
          onStart={fn()}
          onCancel={fn()}
        />
      </div>
    </>
  ),
  play: async ({ canvasElement }) => {
    await expect(overflowing(canvasElement.firstElementChild as HTMLElement)).toEqual([]);
  },
});

/** L4: brain speaking, its reply brightening as it plays, Interrupt live. */
export const LiveSpeaking = meta.story({
  render: () => (
    <>
      {header}
      <ScreenBody padding="14px 16px 10px" gap={12} overflow="auto" style={{ justifyContent: "flex-end" }}>
        <MessageBubble role="user" text={ask} actions={false} />
        <MessageBubble role="brain" text={answer} actions={false} />
        <SpokenTurn speaker="you">When is <UncertainWord>Calypso’s</UncertainWord> axe back?</SpokenTurn>
        <div style={{ display: "flex" }}>
          <VoiceToolChip state="done" label="Read the timber tally" />
        </div>
        <SpokenTurn speaker="brain">On the twelfth, <UnplayedText>two days before the launch tide.</UnplayedText></SpokenTurn>
      </ScreenBody>
      <div style={{ padding: "6px 12px 18px" }}>
        <VoiceField
          shape="tall"
          tone="brain"
          label={{ icon: "speaker", word: "Speaking", meta: "Ithaca steward · 0:24" }}
          meter="level"
          level={0.9}
          controls={
            <>
              <VoiceControlButton name="Mute" icon="mic" pressed={false} onClick={fn()} />
              <VoiceControlButton name="Interrupt" icon="interrupt" onClick={fn()} />
              <VoiceControlButton name="End" icon="dismiss" tone="end" onClick={fn()} />
            </>
          }
        />
      </div>
    </>
  ),
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole("button", { name: "Interrupt" })).toBeEnabled();
    await expect(overflowing(canvasElement.firstElementChild as HTMLElement)).toEqual([]);
  },
});

/** At rest the composer is the field with its one mic. */
export const Ready = meta.story({
  render: () => (
    <>
      {header}
      <ScreenBody padding="14px 16px 10px" gap={12} overflow="auto" style={{ justifyContent: "flex-end" }}>
        <MessageBubble role="user" text={ask} actions={false} />
        <MessageBubble role="brain" text={answer} actions={false} />
      </ScreenBody>
      <div style={{ padding: "6px 12px 18px" }}>
        <VoiceField shape="compact" tone="idle" name="Message" trailing={<MicButton onClick={fn()} onTalkLive={fn()} />}>
          <VoiceText placeholder="Message" />
        </VoiceField>
      </div>
    </>
  ),
});
