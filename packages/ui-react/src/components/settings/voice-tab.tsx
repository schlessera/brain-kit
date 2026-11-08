import { ScreenHeader } from "@schlessera/brain-ui-kit";
import { DictationSettings } from "./dictation-settings.js";

/**
 * Settings › This brain › Voice (#3709, plan §7). The pane is a frame of
 * independent groups: Dictation here, and the live-conversation service
 * (#3616) beside it later. Each group owns its own route, revision and state,
 * so saving one never touches the other, and nothing in the pane opens the
 * microphone, mints a credential or sends audio.
 */
export function VoiceTab({ active }: { active: boolean }) {
  return <div className="min-h-0 flex-1 overflow-y-auto" data-voice-settings="">
    <ScreenHeader variant="nav" title="Voice" subtitle="dictation · where your spoken words go" back={false} divider={false} />
    <div className="flex min-w-0 flex-col gap-6 px-4 pb-6">
      <DictationSettings active={active} />
    </div>
  </div>;
}
