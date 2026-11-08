import type { ReactNode } from "react";
import type { IconName } from "../../src/primitives/Icon.js";
import { fn } from "storybook/test";

import { MicButton } from "../../src/voice/MicButton.js";
import { StartCard, type StartCardPersona } from "../../src/voice/StartCard.js";
import { VoiceControlButton } from "../../src/voice/VoiceControlButton.js";
import { VoiceField, VoiceText } from "../../src/voice/VoiceField.js";
import { VoiceNotice } from "../../src/voice/VoiceNotice.js";
import { UncertainWord } from "../../src/voice/SpokenTurn.js";
import type { VoiceMotion } from "../../src/voice/tone.js";

/**
 * The voice redesign's states (#3690, direction 3a), built once from the kit's
 * components so every story, the state sheets, the reduced-motion sheets and
 * the visual baselines draw the same thing. Odysseus world copy: the raft on
 * Ogygia, Calypso's axe, the timber tally.
 */

export const PERSONA_META = "Ithaca steward";

export const PERSONAS: StartCardPersona[] = [
  { id: "standard", name: "Standard", voice: "voice Kore" },
  { id: "steward", name: "Ithaca steward", voice: "voice Kore · calm, brief" },
  { id: "storyteller", name: "Harbour storyteller", voice: "no Gemini voice set" },
];

export const SHARED = [
  "Your microphone audio goes to Gemini Live through this app’s host while the conversation runs.",
  "Bounded earlier text from this chat and completed results are sent when you press Start.",
  "What you say and what brain replies are saved as text with this chat. Audio is not saved.",
  "Speech never approves an action. Approvals stay on screen.",
];

export const CHAT = {
  title: "Raft launch",
  ask: "What’s left before the raft launches?",
  answer: "Two things: the timber tally and a cask for the water. The cask is the one at risk.",
  spoken: "When is Calypso’s axe back?",
  reply: "On the twelfth,",
  replyTail: "two days before the launch tide.",
};

/* ── Small builders ───────────────────────────────────────────────────── */

const mic = (motion?: VoiceMotion) => <MicButton name="Dictate" onClick={fn()} onTalkLive={fn()} motion={motion} />;
const finish = (busy = false) => <VoiceControlButton name={busy ? "Finishing dictation" : "Finish dictation"} icon="confirm" tone="you" busy={busy} onClick={fn()} />;
const send = <VoiceControlButton name="Send" icon="send" tone="you" onClick={fn()} />;

/** Mute, Interrupt and End, as the tall field draws them. */
export function liveControls(o: { muted?: boolean; interrupt?: boolean; connecting?: boolean } = {}) {
  return (
    <>
      <VoiceControlButton name={o.muted ? "Unmute" : "Mute"} icon={o.muted ? "mic-off" : "mic"} pressed={!!o.muted} disabled={o.connecting} onClick={fn()} />
      <VoiceControlButton name="Interrupt" icon="interrupt" disabled={!o.interrupt} onClick={fn()} />
      <VoiceControlButton name="End" icon="dismiss" tone="end" onClick={fn()} />
    </>
  );
}

/* ── Dictation, D1–D8 ─────────────────────────────────────────────────── */

export type DictationId = "D1" | "D2" | "D3" | "D4" | "D5" | "D6" | "D7" | "D8";

export const DICTATION_TITLES: Record<DictationId, string> = {
  D1: "Ready",
  D2: "First use · waiting for access",
  D3: "Listening",
  D4: "Listening · quiet",
  D5: "Finishing",
  D6: "Review",
  D7: "Mic blocked",
  D8: "Dictation stopped",
};

export function dictation(id: DictationId, motion?: VoiceMotion): ReactNode {
  switch (id) {
    case "D1":
      return <VoiceField shape="compact" tone="idle" name="Message" trailing={mic(motion)} motion={motion}><VoiceText placeholder="Message" /></VoiceField>;
    case "D2":
      return <VoiceNotice tone="you" icon="mic" title="Allow the microphone" body="Your browser is asking. You only need to do this once." actions={[{ label: "Cancel", onClick: fn() }]} motion={motion} />;
    case "D3":
      return (
        <VoiceField shape="compact" tone="you" label={{ icon: "mic", word: "Listening" }} meter="level" level={0.8} trailing={finish()} motion={motion}>
          <VoiceText text="Ask Calypso about the axe" partial="and the sail" />
        </VoiceField>
      );
    case "D4":
      return (
        <VoiceField shape="compact" tone="you" label={{ icon: "mic", word: "Listening" }} meter="flat" trailing={finish()} motion={motion}>
          <VoiceText placeholder="Say something…" />
        </VoiceField>
      );
    case "D5":
      return (
        <VoiceField shape="compact" tone="you" label={{ icon: "mic", word: "Finishing" }} meter="sweep" trailing={finish(true)} motion={motion}>
          <VoiceText text="Ask Calypso about the axe and the sail cloth." />
        </VoiceField>
      );
    case "D6":
      return (
        <VoiceField shape="compact" tone="idle" name="Message" trailing={<><MicButton name="Dictate more" onClick={fn()} motion={motion} />{send}</>} motion={motion}>
          <VoiceText>
            <>Ask Calypso about the axe and the <UncertainWord onClick={fn()}>sail</UncertainWord> cloth.</>
          </VoiceText>
        </VoiceField>
      );
    case "D7":
      return <VoiceNotice tone="fail" icon="attention" title="Microphone is blocked" body="Allow it in this site’s browser settings, then tap the mic again." actions={[{ label: "OK", onClick: fn() }]} motion={motion} />;
    case "D8":
      return (
        <VoiceNotice
          tone="idle"
          icon="retry"
          title="Dictation stopped"
          body="Kept so far: “Ask Calypso about the axe…”"
          actions={[{ label: "Dismiss", onClick: fn() }, { label: "Try again", tone: "you", onClick: fn() }]}
          motion={motion}
        />
      );
  }
}

/* ── Start, S1–S5 ─────────────────────────────────────────────────────── */

export type StartId = "S1" | "S2" | "S2+" | "S3" | "S3b" | "S3c" | "S3d" | "S4" | "S5";

export const START_TITLES: Record<StartId, string> = {
  S1: "Holding",
  S2: "Start card · one service",
  "S2+": "Start card · several services",
  S3: "Persona has no voice here",
  S3b: "Saved voice is stale",
  S3c: "Instructions over the cap",
  S3d: "Saved service unavailable",
  S4: "Live not available",
  S5: "Connecting",
};

export function start(id: StartId, motion?: VoiceMotion): ReactNode {
  const card = { service: "Gemini Live", shared: SHARED, personas: PERSONAS, onSelectPersona: fn(), onStart: fn(), onCancel: fn(), motion };
  switch (id) {
    case "S1":
      // The hint floats above the mic, so the field leaves it room.
      return (
        <div style={{ width: "100%", paddingTop: 44 }}>
          <VoiceField shape="compact" tone="idle" name="Message" trailing={<MicButton name="Dictate" phase="holding" progress={0.6} hint onClick={fn()} motion={motion} />} motion={motion}>
            <VoiceText placeholder="Message" />
          </VoiceField>
        </div>
      );
    case "S2":
      return <StartCard {...card} selectedPersona="steward" />;
    case "S2+":
      return <StartCard {...card} selectedPersona="steward" onChangeService={fn()} />;
    case "S3":
      return (
        <StartCard
          {...card}
          onChangeService={fn()}
          selectedPersona="storyteller"
          notice={{ kind: "warn", text: "Harbour storyteller has no Gemini voice. The default voice (Kore) is used this time." }}
        />
      );
    case "S3b":
      return (
        <StartCard
          {...card}
          onChangeService={fn()}
          selectedPersona="steward"
          notice={{ kind: "error", text: "Ithaca steward’s saved voice, Orion, is no longer offered by Gemini Live. Choose another voice to start.", action: { label: "Choose a voice", onClick: fn() } }}
        />
      );
    case "S3c":
      return (
        <StartCard
          {...card}
          service="GPT-Live"
          onChangeService={fn()}
          selectedPersona="storyteller"
          personas={PERSONAS.map((p) => ({ ...p, voice: p.id === "storyteller" ? "voice marin · slow, warm" : "voice marin" }))}
          notice={{ kind: "block", text: "Harbour storyteller’s instructions are 2,400 bytes; GPT-Live takes 2,000. Shorten them or change the service.", action: { label: "Edit persona", onClick: fn() } }}
        />
      );
    case "S3d":
      return (
        <StartCard
          {...card}
          service={null}
          onChangeService={fn()}
          selectedPersona="steward"
          notice={{ kind: "block", text: "Your saved service, GPT-Live, isn’t available here. Choose a service to start." }}
        />
      );
    case "S4":
      return <VoiceNotice tone="idle" icon="fyi" title="Live conversation isn’t set up here" body="Whoever runs this brain can add a live service. Dictation still works." actions={[{ label: "OK", onClick: fn() }]} motion={motion} />;
    case "S5":
      return (
        <VoiceField shape="tall" tone="brain" label={{ icon: "loading", word: "Connecting", meta: "Gemini Live", spin: true }} meter="none" controls={liveControls({ connecting: true })} motion={motion} />
      );
  }
}

/* ── Live, L1–L10 ─────────────────────────────────────────────────────── */

export type LiveId = "L1" | "L2" | "L3" | "L4" | "L5" | "L6" | "L7" | "L8" | "L9" | "L10";

export const LIVE_TITLES: Record<LiveId, string> = {
  L1: "Listening",
  L2: "Thinking",
  L3: "Working",
  L4: "Speaking",
  L5: "Talked over",
  L6: "Needs your tap",
  L7: "Muted",
  L8: "Reconnecting",
  L9: "Stopped",
  L10: "Ended",
};

export function live(id: LiveId, motion?: VoiceMotion): ReactNode {
  const tall = (o: { tone: "you" | "brain" | "idle"; icon: IconName; word: string; time: string; meter: "level" | "sweep" | "flat" | "hatch" | "none"; level?: number; spin?: boolean; outline?: boolean; muted?: boolean; interrupt?: boolean }) => (
    <VoiceField
      shape="tall"
      tone={o.tone}
      outline={o.outline}
      label={{ icon: o.icon, word: o.word, meta: `${PERSONA_META} · ${o.time}`, spin: o.spin }}
      meter={o.meter}
      level={o.level}
      controls={liveControls({ muted: o.muted, interrupt: o.interrupt })}
      motion={motion}
    />
  );
  switch (id) {
    case "L1":
      return tall({ tone: "you", icon: "mic", word: "Listening", time: "0:12", meter: "level", level: 0.85 });
    case "L2":
      return tall({ tone: "brain", icon: "loading", word: "Thinking", time: "0:15", meter: "sweep", spin: true });
    case "L3":
      return tall({ tone: "brain", icon: "working", word: "Working", time: "0:19", meter: "sweep" });
    case "L4":
      return tall({ tone: "brain", icon: "speaker", word: "Speaking", time: "0:24", meter: "level", level: 0.9, interrupt: true });
    case "L5":
      return tall({ tone: "you", icon: "mic", word: "Listening", time: "0:27", meter: "level", level: 0.75 });
    case "L6":
      return tall({ tone: "idle", icon: "hand", word: "Needs your tap", time: "0:41", meter: "none", outline: true });
    case "L7":
      return tall({ tone: "idle", icon: "mic-off", word: "Muted", time: "0:52", meter: "flat", muted: true });
    case "L8":
      return tall({ tone: "idle", icon: "loading", word: "Reconnecting…", time: "1:03", meter: "hatch" });
    case "L9":
      return (
        <VoiceNotice
          tone="fail"
          icon="attention"
          title="Live conversation stopped"
          body="The connection dropped. Everything said so far is in the chat."
          actions={[{ label: "Close", onClick: fn() }, { label: "Start again", tone: "brain", onClick: fn() }]}
          motion={motion}
        />
      );
    case "L10":
      return <VoiceField shape="compact" tone="idle" name="Message" trailing={mic(motion)} motion={motion}><VoiceText placeholder="Message" /></VoiceField>;
  }
}

/* ── The sheet every state is baselined in ─────────────────────────────── */

/**
 * Every state of one group in a grid: one column at 320px, and columns about
 * a desktop composer's width on a desktop. Each cell is captioned with its id and title, so a baseline is
 * reviewable against the mockup sheet on #3690.
 */
export function Sheet<Id extends string>({ ids, titles, render, motion }: { ids: readonly Id[]; titles: Record<Id, string>; render: (id: Id, motion?: VoiceMotion) => ReactNode; motion?: VoiceMotion }) {
  return (
    <div data-motion={motion === "reduce" ? "reduce" : undefined} style={{ width: "100%", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 420px), 1fr))", gap: "26px 18px", alignItems: "end" }}>
      {ids.map((id) => (
        <section key={id} data-state={id} aria-label={`${id} ${titles[id]}`} style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
          <span style={{ font: "600 10px/1.3 'JetBrains Mono',ui-monospace,monospace", color: "var(--bk-color-ink-mute)" }}>
            {id} · {titles[id]}
          </span>
          {render(id, motion)}
        </section>
      ))}
    </div>
  );
}
