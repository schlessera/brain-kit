import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useStore } from "zustand";
import { Button, Callout, IconButton, Placeholder, TextButton } from "@schlessera/brain-ui-kit";
import {
  LIVE_PERSONA_LIMITS,
  STANDARD_PERSONA_ID,
  type ConversationProfile,
  type LivePersona,
  type LivePersonaInvalidReason,
  type LivePersonaStatus,
  type LivePersonaSummary,
} from "@schlessera/brain-ui-sdk/protocol";
import { useBrainUiRoot } from "../../root-context.js";
import { ApiRequestError } from "../../lib/api-client.js";
import { conversationService } from "../../voice/conversation-client.js";

/** What Settings says about a persona file that cannot be used. */
const PERSONA_REASON: Record<LivePersonaInvalidReason, string> = {
  front_matter: "its front matter can't be read",
  schema: "it was written for a different version",
  name: "it needs a name of up to 40 characters",
  voices: "a voice entry isn't valid",
  too_long: `its instructions are over ${LIVE_PERSONA_LIMITS.maxInstructionBytes.toLocaleString("en-US")} bytes`,
  encoding: "it isn't UTF-8 text",
  over_count: `only the first ${LIVE_PERSONA_LIMITS.maxPersonas} personas can be used`,
};

const bytes = (text: string): number => new TextEncoder().encode(text.replace(/\r\n?/g, "\n").trim()).byteLength;
const count = (n: number): string => n.toLocaleString("en-US");

interface Draft { name: string; voices: Record<string, string>; instructions: string }
type View =
  | { kind: "list" }
  | { kind: "edit"; base: LivePersona | null; draft: Draft; errors: string[]; conflict: LivePersona | null; saving: boolean; focusName?: boolean };

/** Persona-capable live services on this host, from the connection's profile. */
function personaServices(profile: ConversationProfile | null): ConversationProfile[] {
  return profile && profile.voices && profile.defaultVoice && profile.personaInstructionBytes !== undefined ? [profile] : [];
}

/**
 * The Persona group of Settings › Voice (#3617). Authored personas are
 * Markdown in the brain (`_voice/personas/<id>.md`); the selection is a
 * brain-wide setting with its own revision. Like Dictation beside it, this
 * group never opens the microphone or a provider. Edits, selection and delete
 * apply from the next Start; a running conversation keeps the persona it
 * started with. Instruction text is plain text everywhere, never markup.
 */
export function PersonaSettings({ active }: { active: boolean }) {
  const root = useBrainUiRoot();
  const api = root.api;
  const profile = useStore(root.connection.conversation.state, (s) => s.conversationProfile);
  const pushed = useStore(root.connection.conversation.state, (s) => s.livePersona);
  const services = personaServices(profile);
  const [personas, setPersonas] = useState<LivePersonaSummary[] | null>(null);
  const [selection, setSelection] = useState<{ value: string; revision: number } | null>(null);
  const [status, setStatus] = useState<LivePersonaStatus | null>(null);
  const [load, setLoad] = useState<"idle" | "loading" | "failed" | "forbidden">("idle");
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState("");
  const [view, setView] = useState<View>({ kind: "list" });
  const [confirm, setConfirm] = useState<LivePersonaSummary | null>(null);
  const [leave, setLeave] = useState<(() => void) | null>(null);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    setLoad((current) => current === "idle" || current === "failed" ? "loading" : current);
    try {
      const [list, settings] = await Promise.all([api.livePersonas(), api.voiceSettings()]);
      if (mine !== generation.current) return;
      setPersonas(list.personas); setSelection(settings.persona); setStatus(settings.livePersona); setLoad("idle");
    } catch (error) {
      if (mine !== generation.current) return;
      setLoad(error instanceof ApiRequestError && error.status === 403 ? "forbidden" : "failed");
    }
  }, [api]);

  // Opening the pane, a pushed change and a return to the window read the files again.
  useEffect(() => { if (active) void refresh(); }, [active, refresh, pushed]);
  useEffect(() => {
    if (!active) return;
    const again = () => { if (document.visibilityState !== "hidden") void refresh(); };
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [active, refresh]);

  const editing = view.kind === "edit" ? view : null;
  const dirty = !!editing && JSON.stringify(editing.draft) !== JSON.stringify(editing.base
    ? { name: editing.base.name, voices: editing.base.voices, instructions: editing.base.instructions }
    : { name: "", voices: {}, instructions: "" });
  useLayoutEffect(() => {
    const ui = root.stores.ui.getState();
    ui.setSettingsNavigationGuard(dirty ? (go) => setLeave(() => go) : null);
    return () => root.stores.ui.getState().setSettingsNavigationGuard(null);
  }, [root, dirty]);

  const select = async (value: string) => {
    if (!selection) return;
    setNotice("Saving…"); setFailure("");
    try {
      const saved = await api.saveLivePersonaSelection(value, selection.revision);
      setSelection(saved.persona); setStatus(saved.livePersona); setNotice("");
    } catch (error) {
      if (error instanceof ApiRequestError && error.message === "LIVE_PERSONA_CHANGED") {
        setNotice("Changed on another device. Showing the latest."); await refresh(); return;
      }
      setNotice(""); setFailure(error instanceof ApiRequestError && error.status === 403 ? "Only the owner can change this." : "Couldn't save the persona choice.");
    }
  };

  const openEditor = async (summary: LivePersonaSummary | null, focusName = false) => {
    setFailure("");
    if (!summary) {
      const voices: Record<string, string> = {};
      setView({ kind: "edit", base: null, draft: { name: "", voices, instructions: "" }, errors: [], conflict: null, saving: false, focusName: true });
      return;
    }
    try {
      const base = await api.livePersona(summary.id);
      setView({ kind: "edit", base, draft: { name: base.name, voices: { ...base.voices }, instructions: base.instructions }, errors: [], conflict: null, saving: false, focusName });
    } catch { setFailure("Couldn't open that persona."); void refresh(); }
  };

  const duplicate = async (summary: LivePersonaSummary) => {
    setFailure("");
    try {
      const source = await api.livePersona(summary.id);
      const name = [...`${source.name} (copy)`].slice(0, LIVE_PERSONA_LIMITS.maxNameChars).join("");
      for (let n = 1; n < 50; n++) {
        const id = `${source.id}-copy${n > 1 ? `-${n}` : ""}`.slice(0, LIVE_PERSONA_LIMITS.maxIdChars);
        try { await api.createLivePersona({ id, name, voices: source.voices, instructions: source.instructions }); break; }
        catch (error) { if (!(error instanceof ApiRequestError && error.message === "PERSONA_EXISTS")) throw error; }
      }
      setView({ kind: "list" }); await refresh();
    } catch (error) { setFailure(writeFailure(error)); }
  };

  const remove = async (summary: LivePersonaSummary) => {
    setConfirm(null); setFailure("");
    try {
      await api.deleteLivePersona(summary.id, summary.revision);
      setView({ kind: "list" }); await refresh();
    } catch (error) {
      if (error instanceof ApiRequestError && error.message === "PERSONA_CHANGED") { setNotice("Changed on another device. Showing the latest."); await refresh(); return; }
      setFailure(writeFailure(error));
    }
  };

  const save = async (current: Extract<View, { kind: "edit" }>) => {
    const errors = draftErrors(current.draft);
    if (errors.length) { setView({ ...current, errors }); return; }
    setView({ ...current, errors: [], saving: true });
    try {
      // After a conflict, saving again is the deliberate choice to replace the newer version.
      if (current.base) await api.updateLivePersona(current.base.id, { baseRevision: (current.conflict ?? current.base).revision, ...current.draft });
      else await api.createLivePersona(current.draft);
      setView({ kind: "list" }); await refresh();
    } catch (error) {
      if (error instanceof ApiRequestError && error.message === "PERSONA_CHANGED" && current.base) {
        const newer = await api.livePersona(current.base.id).catch(() => null);
        setView({ ...current, saving: false, conflict: newer ?? current.base, errors: [] });
        return;
      }
      setView({ ...current, saving: false, errors: [writeFailure(error)] });
    }
  };

  const discardAndLeave = () => { const go = leave; setLeave(null); setView({ kind: "list" }); root.stores.ui.getState().setSettingsNavigationGuard(null); go?.(); };

  return <section aria-label="Persona" aria-busy={load === "loading" || undefined} className="flex min-w-0 flex-col gap-3" data-persona-settings="">
    {editing
      ? <PersonaEditor view={editing} services={services} selected={selection?.value ?? null}
          onChange={(draft) => setView({ ...editing, draft })}
          onBack={() => dirty ? setLeave(() => () => setView({ kind: "list" })) : setView({ kind: "list" })}
          onSave={() => void save(editing)}
          onShowNewer={() => editing.conflict && setView({ ...editing, base: editing.conflict, conflict: null,
            draft: { name: editing.conflict.name, voices: { ...editing.conflict.voices }, instructions: editing.conflict.instructions } })}
          onDuplicate={() => editing.base && void duplicate(editing.base)}
          onDelete={() => editing.base && setConfirm(editing.base)} />
      : <PersonaList personas={personas} status={status} selected={selection?.value ?? null} services={services} load={load}
          onReload={() => void refresh()} onSelect={(id) => void select(id)} onNew={() => void openEditor(null)}
          onEdit={(p, rename) => void openEditor(p, rename)} onDuplicate={(p) => void duplicate(p)} onDelete={setConfirm} />}

    {confirm && <div role="alertdialog" aria-labelledby="persona-delete-title" aria-describedby="persona-delete-body" data-persona-delete=""
      className="flex flex-col gap-3 rounded-xl border border-border bg-surface-raised p-4">
      <p id="persona-delete-title" className="text-sm font-semibold text-foreground">Delete “{confirm.name}”?</p>
      <p id="persona-delete-body" className="text-xs text-muted-foreground">
        {selection?.value === confirm.id ? "It's the selected persona. New conversations will use Standard. " : ""}A conversation already running keeps it until it ends.
      </p>
      <div className="flex gap-4">
        <Button label="Delete" tone="danger" block={false} reach onClick={() => void remove(confirm)} />
        <Button label="Keep" tone="quiet" block={false} reach onClick={() => setConfirm(null)} />
      </div>
    </div>}

    {leave && <div role="alertdialog" aria-label="Unsaved persona" className="flex flex-col gap-2 rounded-xl border border-border bg-surface-raised p-3" data-persona-leave="">
      <p className="text-sm font-semibold text-foreground">Keep your unsaved changes?</p>
      <div className="flex flex-wrap gap-4">
        <Button label="Discard and leave" tone="quiet" block={false} reach onClick={discardAndLeave} />
        <Button label="Keep editing" tone="quiet" block={false} reach onClick={() => setLeave(null)} />
      </div>
    </div>}

    <div role="status" className="text-xs text-muted-foreground empty:hidden" data-persona-notice="">{notice}</div>
    {failure && <div role="alert"><Callout tone="red" variant="banner" icon="failed" text={failure} /></div>}
  </section>;
}

function writeFailure(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 403) return "Only the owner can change personas.";
    if (error.message === "PERSONA_LIMIT") return `You can keep up to ${LIVE_PERSONA_LIMITS.maxPersonas} personas. Delete one first.`;
    if (error.message === "PERSONA_EXISTS") return "A persona with that name already exists. Choose another name.";
    if (error.message === "PERSONA_NOT_FOUND") return "That persona was removed on another device.";
  }
  return "Couldn't save the persona. Try again.";
}

function draftErrors(draft: Draft): string[] {
  const errors: string[] = [];
  const name = draft.name.trim();
  if (!name || [...name].length > LIVE_PERSONA_LIMITS.maxNameChars || /\p{Cc}/u.test(name)) errors.push(`Give the persona a name (up to ${LIVE_PERSONA_LIMITS.maxNameChars} characters).`);
  const size = bytes(draft.instructions);
  if (size > LIVE_PERSONA_LIMITS.maxInstructionBytes) errors.push(`Shorten “How it speaks” to ${count(LIVE_PERSONA_LIMITS.maxInstructionBytes)} bytes (now ${count(size)}).`);
  return errors;
}

const ROW = "flex min-h-[52px] items-center gap-3 rounded-lg border px-3 py-2";

function PersonaList(p: {
  personas: LivePersonaSummary[] | null; status: LivePersonaStatus | null; selected: string | null; services: ConversationProfile[];
  load: "idle" | "loading" | "failed" | "forbidden";
  onReload: () => void; onSelect: (id: string) => void; onNew: () => void;
  onEdit: (persona: LivePersonaSummary, rename: boolean) => void; onDuplicate: (persona: LivePersonaSummary) => void; onDelete: (persona: LivePersonaSummary) => void;
}) {
  const id = useId();
  const heading = `${id}-heading`;
  const own = p.personas?.filter((persona) => !persona.builtIn) ?? [];
  const meta = (persona: LivePersonaSummary): string => persona.builtIn ? "built in · default voices"
    : persona.invalid ? `Can't be used: ${PERSONA_REASON[persona.invalid]}`
    : [...p.services.map((service) => persona.voices[service.providerId] ?? "default voice"), `${count(persona.instructionBytes)} bytes`].join(" · ");
  return <>
    <div>
      <h3 id={heading} className="text-sm font-semibold text-foreground">Persona</h3>
      <p className="mt-1 text-xs text-muted-foreground">How live conversation sounds: a voice per service and a speaking style. Used from the next Start; it never changes what brain may do.</p>
    </div>
    {p.load === "loading" && !p.personas && <Placeholder variant="loading" lines={3} />}
    {p.load === "forbidden" && <p className="text-xs text-muted-foreground" data-persona-owner="">Only the owner can see and change personas.</p>}
    {p.load === "failed" && <div className="flex flex-col gap-2">
      <Callout tone="red" variant="banner" icon="failed" text={p.personas ? "Couldn't check the personas just now. What's shown may be out of date." : "Couldn't load the personas."} />
      <div><Button label="Try again" icon="retry" tone="ghost" size="sm" block={false} reach onClick={p.onReload} /></div>
    </div>}
    {p.personas && <>
      {p.status?.selectedMissing && <p className="text-xs text-muted-foreground" data-persona-missing="">The selected persona was removed. New conversations use Standard.</p>}
      <div role="radiogroup" aria-labelledby={heading} className="flex flex-col overflow-visible rounded-lg">
        {p.personas.map((persona) => {
          const checked = persona.builtIn ? p.selected === STANDARD_PERSONA_ID || !!p.status?.selectedMissing : p.selected === persona.id;
          const disabled = !!persona.invalid;
          return <div key={persona.id} data-persona-row={persona.id} className={`${ROW} ${checked ? "border-primary bg-surface-raised" : "border-border-subtle bg-surface"}`}>
            <label className={`flex min-w-0 flex-1 items-center gap-3 ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}>
              <input type="radio" name={`${id}-persona`} value={persona.id} checked={checked} disabled={disabled}
                aria-describedby={`${id}-${persona.id}-meta`} onChange={() => p.onSelect(persona.id)}
                className="h-5 w-5 shrink-0 accent-[var(--bk-amber-ink)]" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13px] font-semibold text-foreground">{persona.name}</span>
                <span id={`${id}-${persona.id}-meta`} className="truncate font-[family-name:var(--font-mono)] text-[10px] text-muted-foreground">{meta(persona)}</span>
              </span>
            </label>
            {!persona.builtIn && <>
              <span className="hidden sm:inline-flex"><TextButton label="Edit" ariaLabel={`Edit ${persona.name}`} onClick={() => p.onEdit(persona, false)} /></span>
              <PersonaMenu name={persona.name} onEdit={() => p.onEdit(persona, false)} onRename={() => p.onEdit(persona, true)}
                onDuplicate={persona.invalid ? undefined : () => p.onDuplicate(persona)} onDelete={() => p.onDelete(persona)} />
            </>}
          </div>;
        })}
      </div>
      {own.length === 0 && <p className="text-xs text-muted-foreground" data-persona-empty="">Only Standard so far. Personas you add appear here.</p>}
      <div><TextButton label="+ New persona" onClick={p.onNew} data-persona-new="" /></div>
    </>}
  </>;
}

function PersonaMenu(p: { name: string; onEdit: () => void; onRename?: () => void; onDuplicate?: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (open) first.current?.focus(); }, [open]);
  const items = [["Edit", p.onEdit], ["Rename", p.onRename], ["Duplicate", p.onDuplicate], ["Delete", p.onDelete]]
    .filter((item): item is [string, () => void] => !!item[1]);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  return <span className="relative inline-flex">
    <IconButton ref={trigger} name={`More for ${p.name}`} icon="more" haspopup="menu" expanded={open} controls={open ? menuId : undefined}
      onClick={() => setOpen((v) => !v)} data-persona-more="" />
    {open && <div id={menuId} role="menu" aria-label={`Actions for ${p.name}`}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); close(); } }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null) && e.relatedTarget !== trigger.current) setOpen(false); }}
      className="bk-focus-clip absolute right-0 top-full z-popover mt-1 w-44 overflow-hidden rounded-xl border border-border bg-surface-raised shadow-2xl">
      {items.map(([label, run], index) => <button
        // raw-button: row — a menu item; ListRow cannot draw the menuitem role
        key={label} ref={index === 0 ? first : undefined} type="button" role="menuitem"
        onClick={() => { setOpen(false); run(); }}
        className="bk-row flex min-h-11 w-full items-center px-3 text-left text-sm text-foreground"
        style={{ "--hv-bg": "var(--bk-hover-veil-strong)" } as CSSProperties}>{label}</button>)}
    </div>}
  </span>;
}

function PersonaEditor(p: {
  view: Extract<View, { kind: "edit" }>; services: ConversationProfile[]; selected: string | null;
  onChange: (draft: Draft) => void; onBack: () => void; onSave: () => void; onShowNewer: () => void; onDuplicate: () => void; onDelete: () => void;
}) {
  const id = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const { draft, base } = p.view;
  useEffect(() => { if (p.view.focusName) nameRef.current?.focus(); }, [p.view.focusName]);
  const size = bytes(draft.instructions);
  const registered = new Set(p.services.map((service) => service.providerId));
  const elsewhere = Object.entries(draft.voices).filter(([provider]) => !registered.has(provider));
  const counters = p.services.map((service) => ({ service, max: service.personaInstructionBytes! }));
  // Announced once at 90% and once when over, not on every keystroke.
  const level = counters.some(({ max }) => size > max) ? "over" : counters.some(({ max }) => size >= max * 0.9) ? "near" : "ok";
  const errorIds = p.view.errors.map((_, index) => `${id}-error-${index}`).join(" ") || undefined;
  const field = "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground";
  return <div className="flex flex-col gap-4" data-persona-editor={base?.id ?? "new"}>
    <div className="flex items-center gap-2">
      <IconButton name="Back to personas" icon="back" onClick={p.onBack} />
      <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{base ? base.name : "New persona"}</h3>
      {base && <PersonaMenu name={base.name} onEdit={() => nameRef.current?.focus()} onDuplicate={p.onDuplicate} onDelete={p.onDelete} />}
    </div>

    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-semibold text-foreground">Name</span>
      <input ref={nameRef} className={field} value={draft.name} maxLength={80} aria-invalid={p.view.errors.some((e) => e.startsWith("Give")) || undefined}
        aria-describedby={errorIds} onChange={(e) => p.onChange({ ...draft, name: e.target.value })} data-persona-name="" />
    </label>

    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1.5 text-[13px] font-semibold text-foreground">Voice</legend>
      {p.services.length === 0 && <p className="text-xs text-muted-foreground">No live service on this host offers a voice choice.</p>}
      {p.services.map((service) => {
        const value = draft.voices[service.providerId] ?? "";
        const stale = value !== "" && !service.voices!.some((voice) => voice.id === value);
        return <label key={service.providerId} className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] items-center gap-3">
          <span className="text-xs text-muted-foreground">{conversationService(service.providerId)}</span>
          <select className={field} value={value} data-persona-voice={service.providerId}
            onChange={(e) => {
              const voices = { ...draft.voices };
              if (e.target.value) voices[service.providerId] = e.target.value; else delete voices[service.providerId];
              p.onChange({ ...draft, voices });
            }}>
            <option value="">Service default ({service.defaultVoice})</option>
            {stale && <option value={value}>{value} (not offered any more)</option>}
            {service.voices!.map((voice) => <option key={voice.id} value={voice.id}>{voice.label}</option>)}
          </select>
        </label>;
      })}
      {elsewhere.map(([provider, voice]) => <p key={provider} className="text-xs text-muted-foreground" data-persona-elsewhere={provider}>
        {conversationService(provider)} (not on this host): {voice}. Kept as saved.
      </p>)}
      <p className="text-xs text-muted-foreground">Each service has its own voices; names aren{"'"}t shared between them.</p>
    </fieldset>

    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-semibold text-foreground">How it speaks</span>
      <textarea className={`${field} min-h-32 whitespace-pre-wrap`} value={draft.instructions} rows={6}
        aria-describedby={`${id}-help ${id}-count${errorIds ? ` ${errorIds}` : ""}`}
        onChange={(e) => p.onChange({ ...draft, instructions: e.target.value })} data-persona-instructions="" />
      <span id={`${id}-help`} className="text-xs text-muted-foreground">Shapes tone and manner only. It can{"'"}t change what brain may do, see or approve.</span>
      <span id={`${id}-count`} className="font-[family-name:var(--font-mono)] text-[11px] text-muted-foreground" data-persona-count="">
        {counters.length
          ? counters.map(({ service, max }) => `${count(size)} / ${count(max)} bytes for ${conversationService(service.providerId)}${size > max ? " (too long)" : ""}`).join(" · ")
          : `${count(size)} / ${count(LIVE_PERSONA_LIMITS.maxInstructionBytes)} bytes`}
      </span>
      <span role="status" className="sr-only">{level === "over" ? "Too long for at least one service." : level === "near" ? "Nearly at the limit." : ""}</span>
    </label>

    {p.view.errors.length > 0 && <div role="alert" className="flex flex-col gap-1" data-persona-errors="">
      {p.view.errors.map((error, index) => <p key={error} id={`${id}-error-${index}`} className="text-xs text-[var(--bk-red-ink,currentColor)]">{error}</p>)}
    </div>}
    {p.view.conflict && <div role="alert" className="flex flex-col gap-2" data-persona-conflict="">
      <p className="text-xs text-foreground">This persona changed on another device. Your text stays in the editor until you choose.</p>
      <div><TextButton label="Show the newer version" onClick={p.onShowNewer} /></div>
    </div>}

    <div className="flex gap-4">
      <Button label={p.view.saving ? "Saving…" : p.view.conflict ? "Save mine instead" : "Save"} block={false} reach disabled={p.view.saving} onClick={p.onSave} />
      <Button label="Cancel" tone="quiet" block={false} reach onClick={p.onBack} />
    </div>
  </div>;
}
