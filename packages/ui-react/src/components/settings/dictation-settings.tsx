import { useEffect, useId, useState } from "react";
import { Button, Callout, Placeholder, Toggle } from "@schlessera/brain-ui-kit";
import type { VoiceProvidersResponse } from "@schlessera/brain-ui-sdk/protocol";
import { useBrainUiRoot, useRootStore } from "../../root-context.js";
import { useVoiceStore, type DictationChoice, type DictationSaveState } from "../../voice/voice-store.js";
import { providerLabel, type DictationProvider } from "../../voice/dictation-providers.js";
import { dictationSaveRunning, refreshDictationDiscovery, saveDictationChoice } from "../../voice/dictation-settings-save.js";

type Choice = DictationChoice;
type Status = DictationSaveState["status"];

/**
 * The Dictation group of Settings › Voice (#3709; plan §7, D1, D2).
 *
 * One radio per registered provider, saved brain-wide the moment it is
 * picked, as the Models default is, and the Clean up as I speak switch when
 * the effective provider declares SMART. The writes and their outcome live on
 * the root (`dictation-settings-save.ts`), so closing the pane never drops an
 * accepted choice; this only presents them. It never requests a session, a
 * microphone or a provider. A save changes the next take only: a running take
 * keeps the service it disclosed.
 */
export function DictationSettings({ active }: { active: boolean }) {
  const root = useBrainUiRoot();
  const snapshot = useVoiceStore((s) => s.discovery?.snapshot ?? null);
  const save = useVoiceStore((s) => s.dictationSave);
  const take = useVoiceStore((s) => s.mode === "dictate" ? s.dictationTarget : null);
  // Authority comes before any control is enabled. The authenticated probe
  // names an account only for the owner (or an ambient principal), exactly
  // the principals the settings write accepts; the server still decides.
  const account = useRootStore("connection", (s) => s.accountKey);
  const probed = useRootStore("connection", (s) => s.vpnStatus === "connected");
  // Mounted without the connection gate, nothing has probed yet: ask the
  // same probe the gate would have, and keep its answer to this pane.
  const [ownProbe, setOwnProbe] = useState<{ root: object; owner: boolean } | null>(null);
  useEffect(() => {
    if (!active || account !== null || probed) return;
    let live = true;
    void root.request(root.backendUrl("/api/vpn-check"), { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ accountKey?: unknown }> : null)
      .then((body) => { if (live && body) setOwnProbe({ root, owner: typeof body.accountKey === "string" && body.accountKey !== "" }); })
      .catch(() => { /* Unknown authority keeps the controls disabled. */ });
    return () => { live = false; };
  }, [active, account, probed, root]);
  const probedOwner = account !== null ? true : probed ? false : ownProbe?.root === root ? ownProbe.owner : null;
  const refused = save.refusedAccount !== null && save.refusedAccount === (account ?? "");
  const readOnly = refused || probedOwner === false;
  const canWrite = probedOwner === true && !refused;

  useEffect(() => {
    if (!active) return;
    // Opening Settings reads the current choice; it mints nothing. An earlier
    // outcome is not news any more, unless a write is still on its way.
    if (!dictationSaveRunning(root)) root.stores.voice.setState((s) => ({ dictationSave: { ...s.dictationSave, status: null } }));
    void refreshDictationDiscovery(root);
  }, [active, root]);

  const pending = save.pending;
  return <DictationSettingsView
    snapshot={snapshot}
    loading={active && !snapshot && !save.refreshFailed}
    loadError={save.refreshFailed}
    pending={pending}
    status={save.status}
    readOnly={readOnly}
    disabled={!canWrite}
    take={take}
    onReload={() => void refreshDictationDiscovery(root)}
    onChoose={(id) => { if (snapshot && canWrite) void saveDictationChoice(root, { defaultProvider: id, smart: pending?.smart ?? snapshot.dictation.smart }); }}
    onSmart={(smart) => { if (snapshot && canWrite) void saveDictationChoice(root, { defaultProvider: pending ? pending.defaultProvider : snapshot.dictation.saved, smart }); }}
    onRetry={(choice) => { if (canWrite) void saveDictationChoice(root, choice); }}
  />;
}

interface ViewProps {
  snapshot: VoiceProvidersResponse | null;
  loading: boolean;
  loadError: boolean;
  pending: Choice | null;
  status: Status;
  /** Not the owner: the controls stay disabled and say why. */
  readOnly: boolean;
  /** No write is possible yet (read-only, or authority not established). */
  disabled: boolean;
  /** The service a running take was sent to. */
  take: DictationProvider | null;
  onReload: () => void;
  onChoose: (id: string) => void;
  onSmart: (smart: boolean) => void;
  onRetry: (choice: Choice) => void;
}

function capabilityLine(provider: DictationProvider): string {
  const saved = provider.capabilities.savedAudio ? "Also transcribes saved recordings." : "Can't transcribe saved recordings.";
  return provider.destination ? `${provider.destination} ${saved}` : saved;
}

/** The Dictation group, drawn from props. */
function DictationSettingsView(p: ViewProps) {
  const id = useId();
  const heading = `${id}-heading`;
  const snapshot = p.snapshot;
  const dictation = snapshot?.dictation;
  const providers = snapshot?.providers ?? [];
  // What the radios show: the choice being saved, else the server's effective one.
  const savedChoice = p.pending ? p.pending.defaultProvider : dictation?.saved ?? null;
  const checked = p.pending ? p.pending.defaultProvider ?? dictation?.host ?? null
    : dictation?.source === "saved" || dictation?.source === "host" || dictation?.source === "only" ? dictation.effective : null;
  const effective = providers.find((provider) => provider.id === checked);
  const smart = p.pending?.smart ?? dictation?.smart ?? true;
  const unavailable = !p.pending && dictation?.source === "unavailable" ? dictation.saved : null;
  const single = providers.length === 1 && !unavailable;
  const disabled = p.disabled;

  return <section aria-labelledby={heading} aria-busy={p.loading || undefined} className="flex min-w-0 flex-col gap-3" data-dictation-settings="">
    <div>
      <h3 id={heading} className="text-sm font-semibold text-foreground">Dictation</h3>
      <p className="mt-1 text-xs text-muted-foreground">Where your spoken words are turned into draft text. Live conversation is set separately.</p>
    </div>

    {p.loading && <Placeholder variant="loading" lines={3} />}
    {p.loadError && <div className="flex flex-col gap-2">
      <Callout tone="red" variant="banner" icon="failed" text={snapshot ? "Couldn't check the dictation services just now. What's shown may be out of date." : "Couldn't load the dictation services."} />
      <div><Button label="Try again" icon="retry" tone="ghost" size="sm" block={false} reach onClick={p.onReload} /></div>
    </div>}

    {snapshot && providers.length === 0 && <p className="text-sm text-muted-foreground" data-dictation-empty="">Dictation isn{"'"}t set up on this host.</p>}

    {snapshot && single && <div className="flex min-h-[52px] flex-col justify-center rounded-lg border border-border-subtle bg-surface px-3 py-2.5" data-dictation-only="">
      <span className="text-[13px] font-semibold text-foreground">{providerLabel(providers[0]!)}</span>
      <span className="text-xs text-muted-foreground">The only dictation service on this host. {capabilityLine(providers[0]!)}</span>
    </div>}

    {snapshot && !single && providers.length > 0 && <>
      {!checked && !unavailable && <p className="text-sm font-medium text-foreground" data-dictation-choose="">Choose a dictation service</p>}
      {unavailable && <div className="flex min-h-[52px] flex-col justify-center rounded-lg border border-dashed border-border px-3 py-2.5" data-dictation-unavailable="">
        <span className="text-[13px] font-semibold text-foreground">Saved choice · not available</span>
        <span className="text-xs text-muted-foreground">{unavailable} isn{"'"}t available on this host. Dictation is off until you choose another service.</span>
      </div>}
      <div role="radiogroup" aria-labelledby={heading} aria-describedby={p.readOnly ? `${id}-owner` : undefined} className="flex flex-col gap-2">
        {providers.map((provider) => {
          const isChecked = provider.id === checked;
          const marks = [dictation?.host === provider.id ? "host default" : null, savedChoice === provider.id ? "saved" : null].filter(Boolean).join(" · ");
          return <label key={provider.id} data-dictation-provider={provider.id}
            className={`flex min-h-[52px] cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 ${isChecked ? "border-primary bg-surface-raised" : "border-border-subtle bg-surface"} ${disabled ? "cursor-not-allowed opacity-60" : ""}`}>
            <input type="radio" name={`${id}-provider`} value={provider.id} checked={isChecked} disabled={disabled}
              aria-describedby={`${id}-${provider.id}-detail`}
              onChange={() => p.onChoose(provider.id)} className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--bk-amber-ink)]" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex flex-wrap items-baseline justify-between gap-x-2">
                <span className="text-[13px] font-semibold text-foreground">{providerLabel(provider)}</span>
                {marks && <span className="font-[family-name:var(--font-mono)] text-[10px] text-muted-foreground">{marks}</span>}
              </span>
              <span id={`${id}-${provider.id}-detail`} className="text-xs text-muted-foreground">{capabilityLine(provider)}</span>
            </span>
          </label>;
        })}
      </div>
    </>}

    {snapshot && effective?.capabilities.smartTranscription && <div className="flex min-h-[52px] items-center gap-3 border-t border-border pt-3" data-dictation-smart="">
      <div className="min-w-0 flex-1">
        <p id={`${id}-smart`} className="text-[13px] font-semibold text-foreground">Clean up as I speak</p>
        <p className="text-xs text-muted-foreground">Removes fillers, applies spoken corrections and formats lists. Applies from your next dictation.</p>
      </div>
      <Toggle on={smart} labelledBy={`${id}-smart`} disabled={disabled} onClick={() => p.onSmart(!smart)} />
    </div>}

    {p.take && checked !== p.take.id && <p role="status" className="text-xs text-muted-foreground" data-dictation-take="">Dictating with {providerLabel(p.take)} now. Your change applies to the next take.</p>}
    {p.readOnly && <p id={`${id}-owner`} className="text-xs text-muted-foreground" data-dictation-owner="">Only the owner can change this.</p>}
    <div role="status" className="text-xs text-muted-foreground empty:hidden">{p.status?.kind === "saving" ? "Saving…" : p.status?.kind === "stale" ? p.status.current ? "Changed on another device. Showing the current choice." : "Changed on another device." : ""}</div>
    {p.status?.kind === "failed" && <div role="alert" className="flex flex-col gap-2">
      <Callout tone="red" variant="banner" icon="failed" text={p.status.text} />
      <div><Button label="Try again" icon="retry" tone="ghost" size="sm" block={false} reach onClick={() => p.status?.kind === "failed" && p.onRetry(p.status.retry)} /></div>
    </div>}
  </section>;
}
