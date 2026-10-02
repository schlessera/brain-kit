import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useStore } from "zustand";
import { Button, Callout, ScreenHeader, Surface } from "@schlessera/brain-ui-kit";
import type { ModuleSettingsSnapshot } from "@schlessera/brain-ui-sdk";
import { useBrainUiRoot } from "../../root-context.js";
import { ApiRequestError } from "../../lib/api-client.js";
import { SettingsFields } from "./module-settings-fields.js";
import { changedSettingsPaths, replaceAt, savedDraft, settingsDirty, valueAt, type ModuleSettingsSessionStore } from "./module-settings-state.js";

const title = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);
const errorText = (error: unknown) => error instanceof Error ? error.message : "The request failed. Retry when the connection is available.";
const buttonStyle = { minHeight: 44 };

/** Generic module workflow. The session lives above responsive pane/drawer remounts. */
export function ModulesTab({ active, session: store }: { active: boolean; session: ModuleSettingsSessionStore }) {
  const editorRef = useRef<HTMLDivElement>(null);
  const lifecycleRef = useRef<HTMLDivElement>(null);
  const root = useBrainUiRoot();
  const api = root.api;
  const session = useStore(store);
  const dirty = settingsDirty(session);

  const requestLeave = useCallback((leave: () => void) => {
    const current = store.getState();
    if (current.busy) { store.setState({ message: "Wait for this operation to finish before leaving." }); return; }
    if (settingsDirty(current)) store.setState({ leave });
    else leave();
  }, [store]);

  useLayoutEffect(() => {
    root.stores.ui.getState().setSettingsNavigationGuard(dirty || session.busy ? requestLeave : null);
    return () => root.stores.ui.getState().setSettingsNavigationGuard(null);
  }, [root, store, dirty, session.busy, requestLeave]);

  useEffect(() => {
    if (!dirty && !session.busy) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [dirty, session.busy]);

  useEffect(() => {
    if (!session.message?.startsWith("Saved ")) return;
    const message = session.message;
    const timer = setTimeout(() => { if (store.getState().message === message) store.setState({ message: null }); }, 4000);
    return () => clearTimeout(timer);
  }, [session.message, store]);

  useEffect(() => {
    if (!dirty || !session.name || session.busy) { store.setState({ draftNotes: null }); return; }
    store.setState({ draftNotes: null });
    let canceled = false;
    const name = session.name;
    const draft = savedDraft({ draft: session.draft, variants: session.variants });
    const timer = setTimeout(() => {
      void api.moduleSettingsPreview(name, draft).then((result) => {
        if (!canceled) store.setState({ draftNotes: result.notes });
      }).catch(() => { if (!canceled) store.setState({ draftNotes: null }); });
    }, 250);
    return () => { canceled = true; clearTimeout(timer); };
  }, [api, store, session.name, session.draft, session.variants, session.busy, dirty]);

  const reload = useCallback(async () => {
    if (store.getState().busy || settingsDirty(store.getState())) return;
    const generation = store.getState().generation + 1;
    store.setState({ loading: true, error: null, generation });
    try {
      const result = await api.modulesList();
      if (store.getState().generation !== generation) return;
      store.setState({ modules: result.enabled, loading: false });
    } catch (error) { if (store.getState().generation === generation) store.setState({ loading: false, error: errorText(error) }); }
  }, [api, store]);
  useEffect(() => { if (active && !store.getState().loading) void reload(); }, [active, store, reload]);

  function focusFirstError() {
    const editor = editorRef.current;
    const field = editor?.querySelector<HTMLElement>('[data-setting-path][aria-invalid="true"]');
    if (!editor || !field) return;
    for (let parent = field.parentElement; parent && parent !== editor; parent = parent.parentElement) {
      if (parent.tagName === "DETAILS") (parent as HTMLDetailsElement).open = true;
    }
    const control = field.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [role="switch"]:not([aria-disabled="true"])') ?? field;
    control.focus({ preventScroll: true });
    field.scrollIntoView({ block: "center" });
    const error = field.querySelector<HTMLElement>('[role="alert"]');
    const footerTop = lifecycleRef.current?.getBoundingClientRect().top ?? editor.getBoundingClientRect().bottom;
    const bottom = Math.max(control.getBoundingClientRect().bottom, error?.getBoundingClientRect().bottom ?? 0);
    if (bottom > footerTop - 8) editor.scrollTop += bottom - footerTop + 8;
  }
  function reviewConflict() {
    const section = editorRef.current?.querySelector<HTMLElement>('[aria-label="Review conflicting settings"]');
    section?.focus({ preventScroll: true });
    section?.scrollIntoView({ block: "start" });
  }
  async function retry() {
    const name = store.getState().name;
    await reload();
    if (name) await open(name);
  }
  async function open(name: string) {
    const generation = store.getState().generation + 1;
    store.setState({ name, loading: true, error: null, snapshot: null, generation, preview: null, confirm: null, conflict: null, choices: {}, errors: [], localErrors: {}, pendingInputs: {}, variants: {}, leave: null, message: null, draftNotes: null });
    const unavailable = store.getState().modules.find((module) => module.name === name && module.state === "unavailable");
    if (unavailable) {
      store.setState({ loading: false, error: unavailable.error ?? "This module could not be loaded." });
      return;
    }
    try {
      const snapshot = await api.moduleSettings(name);
      if (store.getState().generation !== generation) return;
      store.setState({ snapshot, draft: snapshot.overrides, loading: false });
    } catch (error) { if (store.getState().generation === generation) store.setState({ error: errorText(error), loading: false }); }
  }
  function back() {
    requestLeave(() => store.setState({ name: null, snapshot: null, draft: {}, error: null, message: null, errors: [], localErrors: {}, pendingInputs: {}, variants: {}, preview: null, conflict: null, leave: null, confirm: null, generation: store.getState().generation + 1 }));
  }
  function discard() {
    const current = store.getState();
    if (current.busy || !current.snapshot) return;
    store.setState({ draft: current.snapshot.overrides, variants: {}, pendingInputs: {}, errors: [], localErrors: {}, message: null, leave: null, conflict: null });
    // Clear the installed guard before the explicit leave callback reaches UIStore.
    root.stores.ui.getState().setSettingsNavigationGuard(null);
    current.leave?.();
  }
  function accept(snapshot: ModuleSettingsSnapshot) {
    const leave = store.getState().leave;
    store.setState({ snapshot, draft: snapshot.overrides, busy: null, errors: [], localErrors: {}, pendingInputs: {}, variants: {}, preview: null, conflict: null, choices: {}, confirm: null, leave: null,
      message: `Saved ${snapshot.commit ? `· commit ${snapshot.commit.slice(0, 7)} · ` : ""}settings. Applies on the next run; storage changes need a restart.` });
    root.stores.ui.getState().setSettingsNavigationGuard(null);
    leave?.();
  }
  async function save(values?: Record<string, unknown>, revision?: string) {
    const current = store.getState();
    if (!current.name || !current.snapshot || current.busy) return;
    if (Object.values(current.pendingInputs).some(Boolean)) {
      store.setState({ message: "Add the pending item or clear its input before saving." });
      return;
    }
    if (Object.keys(current.localErrors).length) {
      store.setState({ message: "Review the highlighted settings before saving." });
      requestAnimationFrame(focusFirstError);
      return;
    }
    store.setState({ busy: "Saving settings", message: null, errors: [] });
    try { accept(await api.moduleSettingsSave(current.name, values ?? savedDraft(current), revision ?? current.snapshot.revision)); }
    catch (error) {
      if (error instanceof ApiRequestError && error.status === 422) {
        store.setState({ busy: null, errors: error.errors, message: error.message });
        requestAnimationFrame(focusFirstError);
      } else if (error instanceof ApiRequestError && error.status === 409) {
        try {
          const conflict = await api.moduleSettings(current.name);
          store.setState({ busy: null, conflict, choices: {}, message: "Settings changed elsewhere. Review yours and the saved values before saving again." });
        } catch (readError) { store.setState({ busy: null, message: `${error.message} ${errorText(readError)} Retry Save to load the review.` }); }
      } else store.setState({ busy: null, message: errorText(error) });
    }
  }
  async function preview() {
    const current = store.getState();
    if (!current.name || current.busy || settingsDirty(current)) return;
    store.setState({ busy: "Reading migration preview", message: null });
    try { store.setState({ preview: await api.moduleMigrationPreview(current.name), busy: null }); }
    catch (error) { store.setState({ busy: null, message: errorText(error) }); }
  }
  async function applyMigration() {
    const current = store.getState();
    if (!current.name || !current.preview || current.busy || settingsDirty(current)) return;
    store.setState({ busy: "Moving settings", message: null });
    try { accept(await api.moduleMigrationApply(current.name, current.preview.revision)); }
    catch (error) { store.setState({ busy: null, preview: null, message: `${errorText(error)} Preview the migration again before retrying.` }); }
  }
  async function confirmOperation() {
    const current = store.getState();
    if (!current.snapshot || !current.name || !current.confirm || current.busy || settingsDirty(current)) return;
    const operation = current.confirm;
    store.setState({ busy: operation === "state" ? "Changing module state" : "Running action", message: null });
    try {
      if (operation === "state") {
        const result = await api.moduleState(current.name, current.snapshot.state === "active" ? "dormant" : "active");
        const refreshed = await api.moduleSettings(current.name);
        store.setState({ modules: current.modules.map((m) => m.name === current.name ? { ...m, state: result.state } : m), snapshot: refreshed, draft: refreshed.overrides, busy: null, confirm: null,
          message: `${title(current.name)} is ${result.state}. ${result.context.left.length ? `Left context: ${result.context.left.join(", ")}. ` : ""}${result.context.entered.length ? `Entered context: ${result.context.entered.join(", ")}. ` : ""}Running sessions keep their loaded state.` });
      } else {
        const result = await api.moduleAction(current.name, operation);
        store.setState({ busy: null, confirm: null, message: `Action finished: ${JSON.stringify(result)}` });
      }
    } catch (error) { store.setState({ busy: null, confirm: null, message: errorText(error) }); }
  }

  const snapshot = session.snapshot;
  const conflictPaths = session.conflict ? changedSettingsPaths(savedDraft(session), session.conflict.overrides) : [];
  const removalNotes = Object.entries(session.variants).filter(([, v]) => v.selected !== v.original).map(([path, v]) => `${v.keys.filter((k) => k !== v.selected).join(" and ")} will be removed from ${String(valueAt(snapshot?.values, [...path.split("."), "name"]) ?? path)}`);

  return <div ref={editorRef} data-module-settings-editor className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
    <div className="flex min-w-0 shrink-0 items-center border-b border-border px-3">
      {session.name && <Button label="Back to modules" tone="quiet" size="sm" block={false} style={buttonStyle} onClick={back} />}
      <div className="min-w-0 flex-1"><ScreenHeader variant="nav" title={session.name ? title(session.name) : "Modules"} subtitle={snapshot ? `${snapshot.state} · saved values apply on the next run` : session.name && session.error ? "Unavailable · repair configuration to edit" : "Configure the workflows in your brain"} back={false} divider={false} /></div>
    </div>
    <div className="min-w-0 flex-1 space-y-5 p-4">
      {session.loading && <div role="status" aria-label="Loading modules" className="space-y-3"><div className="h-11 rounded-lg bg-surface-raised" /><div className="h-11 rounded-lg bg-surface-raised" /><span className="text-xs text-muted-foreground">Loading settings…</span></div>}
      {session.error && <div role="alert" className="space-y-3"><p className="break-words text-sm text-destructive">{session.error}</p>{session.name && <p className="text-xs text-muted-foreground">This detail is read-only. Repair the module configuration in brain config, then Retry. Other modules remain available from Modules.</p>}<Button label="Retry" icon="retry" tone="quiet" style={buttonStyle} onClick={() => void retry()} /></div>}
      {!session.name && !session.loading && !session.error && (session.modules.length ? <ul className="space-y-2">{session.modules.map((module) => <li key={module.key}><Surface pad={3}><div className="flex min-w-0 flex-col gap-2"><span className="break-words text-sm font-semibold">{title(module.name)}</span><p className="break-words text-xs text-muted-foreground">{module.description ?? "Module workflow"}</p><span className="font-[family-name:var(--font-mono)] text-[11px] text-muted-foreground">{module.state === "unavailable" ? "unavailable" : !module.settings ? "no settings" : module.state ?? "active"}</span>{module.error && <p className="break-words text-xs text-destructive">{module.error}</p>}<Button label={`${module.state === "unavailable" ? "View" : "Configure"} ${title(module.name)}`} tone="quiet" style={buttonStyle} onClick={() => void open(module.name)} /></div></Surface></li>)}</ul> : <Callout variant="banner" tone="neutral" icon="capability" text="No modules are configured. Add a module in your brain configuration to tune its workflow here." />)}
      {snapshot && !session.loading && <>
        {snapshot.ui.migration && (!snapshot.ui.migration.target || valueAt(snapshot.values, snapshot.ui.migration.target.split(".")) === undefined) && <Surface pad={3}><div className="space-y-3"><h3 className="text-sm font-semibold">{snapshot.ui.migration.label}</h3><p className="text-xs text-muted-foreground">{snapshot.ui.migration.help ?? "Preview the source before moving these settings."}</p><Button label="Preview migration" tone="quiet" disabled={dirty || session.busy !== null} style={buttonStyle} onClick={() => void preview()} /></div></Surface>}
        {session.preview && <section aria-label="Migration preview" className="space-y-3"><h3 className="text-sm font-semibold">Preview from {session.preview.source}</h3><SettingsFields disabled snapshot={{ ...snapshot, values: session.preview.values, inherited: {}, overrides: session.preview.values, notes: [], schema: { ...snapshot.schema, properties: Object.fromEntries(Object.entries((snapshot.schema.properties ?? {}) as Record<string, unknown>).filter(([key]) => Object.hasOwn(session.preview!.values, key))) }, ui: { ...snapshot.ui, fields: snapshot.ui.fields.filter((field) => Object.hasOwn(session.preview!.values, field.key.split(".")[0]!)) } }} session={{ ...session, draft: session.preview.values, variants: {}, draftNotes: null, pendingInputs: {} }} store={store} />
          <details><summary className="min-h-11 cursor-pointer py-3 text-xs">Complete source values</summary><pre className="whitespace-pre-wrap break-words rounded-lg bg-surface-raised p-3 text-xs">{JSON.stringify(session.preview.original ?? session.preview.values, null, 2)}</pre></details>{session.preview.summary && <p className="text-xs text-muted-foreground">{session.preview.summary}</p>}{session.preview.warnings?.map((w) => <p key={w} className="text-xs text-muted-foreground">{w}</p>)}<div className="flex flex-wrap gap-2"><Button label={snapshot.ui.migration?.label ?? "Apply migration"} disabled={dirty || session.busy !== null || session.preview.alreadyMoved} block={false} style={buttonStyle} onClick={() => void applyMigration()} /><Button label="Cancel migration" tone="quiet" block={false} disabled={session.busy !== null} style={buttonStyle} onClick={() => store.setState({ preview: null })} /></div></section>}
        <SettingsFields snapshot={snapshot} session={session} store={store} />
        <section aria-label="Module state" className="space-y-3 border-t border-border pt-4"><h3 className="text-sm font-semibold">Workflow state</h3><p className="text-xs text-muted-foreground">Dormancy keeps content and configuration, while removing this workflow's skills and owned instructions. Running sessions keep their loaded state.</p><Button label={snapshot.state === "active" ? "Make dormant" : "Activate module"} tone="quiet" disabled={dirty || session.busy !== null || (snapshot.state === "active" && !snapshot.canBeDormant)} style={buttonStyle} onClick={() => store.setState({ confirm: "state" })} />{snapshot.dormancyReason && !snapshot.canBeDormant && <p className="text-xs text-muted-foreground">{snapshot.dormancyReason}</p>}</section>
        {snapshot.ui.actions.length > 0 && <section aria-label="Module actions" className="space-y-3 border-t border-border pt-4"><h3 className="text-sm font-semibold">Actions</h3>{snapshot.ui.actions.map((action) => <div key={action.id} className="space-y-2"><p className="text-xs text-muted-foreground">{action.help}</p><Button label={action.label} tone="quiet" disabled={dirty || session.busy !== null || snapshot.state === "dormant"} style={buttonStyle} onClick={() => store.setState({ confirm: action.id })} /></div>)}{dirty && <p className="text-xs text-muted-foreground">Save first · actions use saved settings.</p>}{snapshot.state === "dormant" && <p className="text-xs text-muted-foreground">Activate the module before running its actions.</p>}</section>}
        {session.confirm && <div role="alert" className="space-y-3 rounded-lg bg-surface-raised p-3"><p className="text-sm">{session.confirm === "state" ? `Make ${title(snapshot.module)} ${snapshot.state === "active" ? "dormant" : "active"}?` : snapshot.ui.actions.find((a) => a.id === session.confirm)?.confirm}</p><div className="flex flex-wrap gap-2"><Button label="Confirm" block={false} disabled={session.busy !== null} style={buttonStyle} onClick={() => void confirmOperation()} /><Button label="Keep as is" block={false} tone="quiet" disabled={session.busy !== null} style={buttonStyle} onClick={() => store.setState({ confirm: null })} /></div></div>}
      </>}
      {session.conflict && <section aria-label="Review conflicting settings" tabIndex={-1} className="space-y-4 border-t border-border pt-4"><h3 className="text-sm font-semibold">Review yours and saved elsewhere</h3>{conflictPaths.map((path) => {
        const key = path.join(".") || "All settings";
        return <fieldset key={key} className="min-w-0 space-y-2"><legend className="break-words text-sm font-semibold">{key}</legend><p className="text-xs">Yours</p><pre className="whitespace-pre-wrap break-words bg-surface-raised p-3 text-xs">{JSON.stringify(valueAt(savedDraft(session), path), null, 2) ?? "Not set"}</pre><p className="text-xs">Saved elsewhere</p><pre className="whitespace-pre-wrap break-words bg-surface-raised p-3 text-xs">{JSON.stringify(valueAt(session.conflict!.overrides, path), null, 2) ?? "Not set"}</pre>{(["yours", "saved"] as const).map((choice) => <label key={choice} className="flex min-h-11 items-center gap-2 text-sm"><input type="radio" name={`conflict-${key}`} checked={session.choices[key] === choice} onChange={() => store.setState((s) => ({ choices: { ...s.choices, [key]: choice } }))} />Use {choice === "yours" ? "yours" : "saved elsewhere"} for {key}</label>)}</fieldset>;
      })}<Button label="Save reviewed settings" disabled={session.busy !== null || conflictPaths.some((p) => !session.choices[p.join(".") || "All settings"])} style={buttonStyle} onClick={() => {
        let values = session.conflict!.overrides;
        for (const path of conflictPaths) if (session.choices[path.join(".") || "All settings"] === "yours") {
          const yours = valueAt(savedDraft(session), path);
          values = replaceAt(values, path, yours, yours === undefined) as Record<string, unknown>;
        }
        void save(values, session.conflict!.revision);
      }} /></section>}
    </div>
    {(dirty || session.leave || session.message || session.busy || session.conflict) && <div ref={lifecycleRef} data-module-settings-lifecycle className="sticky bottom-0 z-10 shrink-0 space-y-2 border-t border-border bg-surface p-3">
      {session.busy && <p role="status" className="text-xs text-muted-foreground">{session.busy}…</p>}
      {session.conflict ? <div className="flex flex-wrap items-center gap-2"><p role="status" className="text-xs text-foreground">Settings changed elsewhere</p><Button label="Review" tone="quiet" block={false} style={buttonStyle} onClick={reviewConflict} /></div> : session.message && <p role="status" className="break-words text-xs text-foreground">{session.message}</p>}
      {session.leave ? <div role="alert" className="space-y-2"><p className="text-sm font-semibold">Keep your unsaved changes?</p><div className="flex flex-wrap gap-2"><Button label="Save and leave" block={false} disabled={session.busy !== null || session.conflict !== null} style={buttonStyle} onClick={() => void save()} /><Button label="Discard and leave" tone="quiet" block={false} disabled={session.busy !== null} style={buttonStyle} onClick={discard} /><Button label="Keep editing" tone="quiet" block={false} style={buttonStyle} onClick={() => store.setState({ leave: null })} /></div></div> : dirty && <><p className="text-xs text-muted-foreground">Unsaved changes{removalNotes.length ? ` · ${removalNotes.join("; ")}` : ""}</p><div className="flex gap-2"><Button label="Discard" tone="quiet" disabled={session.busy !== null} style={{ ...buttonStyle, flex: "1 1 0", width: "auto" }} onClick={discard} /><Button label="Save" disabled={session.busy !== null || session.conflict !== null} style={{ ...buttonStyle, flex: "1 1 0", width: "auto" }} onClick={() => void save()} /></div></>}
    </div>}
  </div>;
}
