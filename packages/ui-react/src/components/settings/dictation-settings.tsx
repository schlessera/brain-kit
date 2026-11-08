import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button, Callout, Placeholder, Toggle } from "@schlessera/brain-ui-kit";
import type { VoiceProvidersResponse } from "@schlessera/brain-ui-sdk/protocol";
import { useBrainUiRoot } from "../../root-context.js";
import { useVoiceStore } from "../../voice/voice-store.js";
import { ApiRequestError } from "../../lib/api-client.js";
import { loadDiscovery, providerLabel, type DictationProvider } from "../../voice/dictation-providers.js";

type Choice = { defaultProvider: string | null; smart: boolean };
type Status =
  | { kind: "saving" }
  | { kind: "failed"; retry: Choice; text: string }
  | { kind: "stale" }
  | null;

/**
 * The Dictation group of Settings › Voice (#3709; plan §7, D1, D2).
 *
 * One radio per registered provider, saved brain-wide the moment it is
 * picked, as the Models default is, and the Clean up as I speak switch when
 * the effective provider declares SMART. The container reads discovery,
 * serializes writes against the settings revision and reports every
 * outcome; it never requests a session, a microphone or a provider. A save
 * changes the next take only: a running take keeps the service it disclosed.
 */
export function DictationSettings({ active }: { active: boolean }) {
  const root = useBrainUiRoot();
  const stored = useVoiceStore((s) => s.discovery?.snapshot ?? null);
  // A take may drop the cached snapshot (a refused session) while this is
  // open; keep showing the last one read rather than flashing to loading.
  const [shown, setShown] = useState<{ root: object; snapshot: VoiceProvidersResponse } | null>(null);
  const snapshot = stored ?? (shown?.root === root ? shown.snapshot : null);
  const [loadError, setLoadError] = useState(false);
  const [pending, setPending] = useState<Choice | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [readOnly, setReadOnly] = useState(false);
  const take = useVoiceStore((s) => s.mode === "dictate" ? s.dictationTarget : null);
  const lifetime = useRef(0);
  const desired = useRef<Choice | null>(null);
  const writing = useRef(false);

  useEffect(() => { if (stored) setShown({ root, snapshot: stored }); }, [root, stored]);

  const reload = useCallback(async (generation: number) => {
    try {
      await loadDiscovery(root, { force: true });
      if (generation === lifetime.current) setLoadError(false);
    } catch {
      if (generation === lifetime.current) setLoadError(true);
    }
  }, [root]);

  useEffect(() => {
    const generation = ++lifetime.current;
    desired.current = null;
    setPending(null); setStatus(null); setReadOnly(false); setLoadError(false);
    // Opening Settings reads the current choice; it mints nothing.
    if (active) void reload(generation);
    return () => { lifetime.current++; };
  }, [active, root, reload]);

  /** Latest-wins writes, one at a time, each against the newest revision. */
  async function save(next: Choice) {
    const generation = lifetime.current;
    desired.current = next;
    setPending(next);
    setStatus({ kind: "saving" });
    if (writing.current) return;
    writing.current = true;
    try {
      while (desired.current && generation === lifetime.current) {
        const want: Choice = desired.current;
        const base = root.stores.voice.getState().discovery?.snapshot ?? snapshot;
        if (!base) throw new Error("Dictation settings are not loaded");
        try {
          await root.api.saveDictationSettings({ ...want, revision: base.dictation.revision });
        } catch (error) {
          desired.current = null;
          if (generation !== lifetime.current) return;
          const status = error instanceof ApiRequestError ? error.status : 0;
          const code = error instanceof Error ? error.message : "";
          setPending(null);
          if (status === 403) {
            setReadOnly(true);
            setStatus(null);
          } else if (status === 409 || status === 428) {
            // Changed on another device: show what the server holds now.
            setStatus({ kind: "stale" });
            await reload(generation);
          } else if (code === "speech_provider_unknown") {
            setStatus({ kind: "failed", retry: want, text: "That dictation service isn't available on this host." });
            await reload(generation);
          } else {
            setStatus({ kind: "failed", retry: want, text: "Couldn't save. Your dictation service is unchanged." });
          }
          return;
        }
        if (desired.current === want) desired.current = null;
        // The next take reads the confirmed choice, not this optimistic one.
        await loadDiscovery(root, { force: true }).catch(() => { if (generation === lifetime.current) setLoadError(true); });
      }
      if (generation === lifetime.current) { setPending(null); setStatus(null); }
    } finally {
      writing.current = false;
    }
  }

  return <DictationSettingsView
    snapshot={snapshot}
    loading={active && !snapshot && !loadError}
    loadError={loadError && !snapshot}
    pending={pending}
    status={status}
    readOnly={readOnly}
    take={take}
    onReload={() => void reload(lifetime.current)}
    onChoose={(id) => { if (snapshot) void save({ defaultProvider: id, smart: pending?.smart ?? snapshot.dictation.smart }); }}
    onSmart={(smart) => { if (snapshot) void save({ defaultProvider: pending ? pending.defaultProvider : snapshot.dictation.saved, smart }); }}
    onRetry={(choice) => void save(choice)}
  />;
}

interface ViewProps {
  snapshot: VoiceProvidersResponse | null;
  loading: boolean;
  loadError: boolean;
  pending: Choice | null;
  status: Status;
  readOnly: boolean;
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
  const disabled = p.readOnly;

  return <section aria-labelledby={heading} aria-busy={p.loading || undefined} className="flex min-w-0 flex-col gap-3" data-dictation-settings="">
    <div>
      <h3 id={heading} className="text-sm font-semibold text-foreground">Dictation</h3>
      <p className="mt-1 text-xs text-muted-foreground">Where your spoken words are turned into draft text. Live conversation is set separately.</p>
    </div>

    {p.loading && <Placeholder variant="loading" lines={3} />}
    {p.loadError && <div className="flex flex-col gap-2">
      <Callout tone="red" variant="banner" icon="failed" text="Couldn't load the dictation services." />
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
    <div role="status" className="text-xs text-muted-foreground empty:hidden">{p.status?.kind === "saving" ? "Saving…" : p.status?.kind === "stale" ? "Changed on another device. Showing the current choice." : ""}</div>
    {p.status?.kind === "failed" && <div role="alert" className="flex flex-col gap-2">
      <Callout tone="red" variant="banner" icon="failed" text={p.status.text} />
      <div><Button label="Try again" icon="retry" tone="ghost" size="sm" block={false} reach onClick={() => p.status?.kind === "failed" && p.onRetry(p.status.retry)} /></div>
    </div>}
  </section>;
}
