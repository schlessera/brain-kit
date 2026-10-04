import { useState } from "react";
import { ArrowDown, ArrowUp, Minus, Plus, X } from "lucide-react";
import { Button, Surface, Toggle } from "@schlessera/brain-ui-kit";
import type { ModuleSettingsField, ModuleSettingsSnapshot } from "@schlessera/brain-ui-sdk";
import { mergeSettings, record, replaceAt, sameSettings, valueAt, type ModuleSettingsSession, type ModuleSettingsSessionStore, type SettingsPath } from "./module-settings-state.js";

const INPUT = "min-h-11 w-full min-w-0 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-60";
const META = "break-words font-[family-name:var(--font-mono)] text-[11px] text-muted-foreground";
const joinPath = (base: SettingsPath, key: string): SettingsPath => [...base, ...key.split(".").filter(Boolean)];

function schemaAt(schema: Record<string, unknown>, path: SettingsPath): Record<string, unknown> {
  let current = schema;
  for (const key of path) current = record(typeof key === "number" ? current.items : record(current.properties) ? current.properties[key] : current.additionalProperties) ? (typeof key === "number" ? current.items : record(current.properties) ? current.properties[key] : current.additionalProperties) as Record<string, unknown> : {};
  return current;
}

/** Metadata enriches the schema; schema fields and complete unsupported values never disappear. */
export function settingsFields(schema: Record<string, unknown>, described: ModuleSettingsField[], value: unknown): ModuleSettingsField[] {
  const result = [...described];
  const covered = new Set(described.flatMap((f) => f.kind === "variant" ? f.variants?.flatMap((v) => v.fields.map((child) => child.key)) ?? [] : [f.key]));
  const properties = record(schema.properties) ? schema.properties : {};
  const keys = [...new Set([...Object.keys(properties), ...Object.keys(record(value) ? value : {})])];
  for (const key of keys) {
    if (covered.has(key)) continue;
    const childSchema = record(properties[key]) ? properties[key] : {};
    const nested = described.filter((f) => f.key.startsWith(key + "."));
    if (nested.length) {
      for (const child of settingsFields(childSchema, nested.map((f) => ({ ...f, key: f.key.slice(key.length + 1) })), record(value) ? value[key] : undefined)) {
        const path = `${key}.${child.key}`;
        if (!covered.has(path)) result.push({ ...child, key: path, group: key });
      }
    } else result.push({ key, label: key, group: "Other settings" });
  }
  return result.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function kindFor(schema: Record<string, unknown>, field: ModuleSettingsField): ModuleSettingsField["kind"] | "unsupported" {
  if (field.kind) return field.kind;
  if (Array.isArray(schema.enum)) return "choice";
  if (schema.type === "string") return "text";
  if (schema.type === "number" || schema.type === "integer") return "number";
  if (schema.type === "boolean") return "toggle";
  if (schema.type === "array" && record(schema.items)) return schema.items.type === "string" ? "tags" : schema.items.type === "object" ? "list" : "unsupported";
  if (schema.type === "object") return record(schema.additionalProperties) && schema.additionalProperties.type === "number" && !schema.properties ? "weights" : "record";
  return "unsupported";
}

function seed(schema: Record<string, unknown>, field: ModuleSettingsField): unknown {
  if (Object.hasOwn(field, "default")) return field.default;
  if (Object.hasOwn(schema, "default")) return schema.default;
  const kind = kindFor(schema, field);
  if (kind === "list" || kind === "tags" || kind === "multichoice") return [];
  if (kind === "record") {
    let value: unknown = {};
    for (const child of settingsFields(schema, field.fields ?? [], {})) {
      if (child.optional) continue;
      const children = child.kind === "variant" ? child.variants?.[0]?.fields ?? [] : [child];
      for (const leaf of children) value = replaceAt(value, leaf.key.split("."), seed(schemaAt(schema, leaf.key.split(".")), leaf));
    }
    return value;
  }
  if (kind === "weights") return {};
  if (kind === "number") return field.min ?? (typeof schema.minimum === "number" ? schema.minimum : 1);
  if (kind === "toggle") return false;
  if (kind === "choice") return field.options?.[0]?.value ?? (Array.isArray(schema.enum) ? schema.enum[0] : "");
  return "";
}

export function SettingsFields({ snapshot, session, store, disabled = false }: { snapshot: ModuleSettingsSnapshot; session: ModuleSettingsSession; store: ModuleSettingsSessionStore; disabled?: boolean }) {
  const effective = mergeSettings(snapshot.inherited, session.draft);
  const groups = new Map<string, ModuleSettingsField[]>();
  for (const field of settingsFields(snapshot.schema, snapshot.ui.fields, effective)) {
    const group = field.group ?? "Settings";
    groups.set(group, [...groups.get(group) ?? [], field]);
  }
  return <div className="flex min-w-0 flex-col gap-6">{[...groups].map(([group, fields]) => <section key={group} aria-label={group} className="min-w-0">
    <h3 className="mb-3 text-sm font-semibold text-foreground">{group}</h3>
    <div className="flex min-w-0 flex-col gap-4">{fields.map((field) => <SettingsField key={field.key} field={field} base={[]} snapshot={snapshot} session={session} store={store} disabled={disabled} />)}</div>
  </section>)}</div>;
}

interface FieldProps { field: ModuleSettingsField; base: SettingsPath; snapshot: ModuleSettingsSnapshot; session: ModuleSettingsSession; store: ModuleSettingsSessionStore; disabled?: boolean }

function SettingsField({ field, base, snapshot, session, store, disabled = false }: FieldProps) {
  const path = joinPath(base, field.key);
  const key = path.join(".");
  const id = `module-setting-${key}`;
  const schema = schemaAt(snapshot.schema, path);
  const kind = kindFor(schema, field);
  const effective = mergeSettings(snapshot.inherited, session.draft);
  const value = valueAt(effective, path);
  const own = valueAt(session.draft, path) !== undefined;
  const source = own ? sameSettings(valueAt(session.draft, path), valueAt(snapshot.overrides, path)) ? snapshot.provenance[key] ?? "saved" : "saved" : snapshot.inheritedProvenance?.[key] ?? "default";
  const readOnly = Boolean(field.readOnly && (!field.readOnly.whenInherited || source === "brain-config"));
  const locked = disabled || session.busy !== null || readOnly || source === "brain-config";
  const present = value !== undefined && value !== null;
  const display = present ? value : field.default ?? schema.default;
  const errors = [...session.errors.filter((e) => e.path === key || !["list", "record"].includes(kind ?? "") && e.path.startsWith(key + ".")).map((e) => e.message), ...(session.localErrors[key] ? [session.localErrors[key]!] : [])];
  const describedBy = `${id}-help${errors.length ? ` ${id}-error` : ""}`;
  const adding = session.pendingInputs[key] ?? "";
  const setAdding = (value: string) => store.setState((state) => ({ pendingInputs: { ...state.pendingInputs, [key]: value } }));
  function change(next: unknown, remove = false) {
    store.setState((s) => {
      let draft = s.draft;
      for (let i = 0; i < path.length; i++) if (typeof path[i] === "number" && !Array.isArray(valueAt(draft, path.slice(0, i)))) {
        draft = replaceAt(draft, path.slice(0, i), structuredClone(valueAt(effective, path.slice(0, i)))) as Record<string, unknown>;
      }
      return { draft: replaceAt(draft, path, next, remove) as Record<string, unknown>, errors: s.errors.filter((e) => e.path !== key), message: null, localErrors: Object.fromEntries(Object.entries(s.localErrors).filter(([k]) => k !== key)) };
    });
  }
  if (kind === "variant") return <VariantField {...{ field, base, snapshot, session, store }} disabled={disabled || session.busy !== null} />;
  if (field.key === snapshot.ui.migration?.target && value === undefined) return null;
  return <div className="min-w-0" data-setting-path={key} role="group" aria-label={field.label} aria-invalid={errors.length > 0 || undefined} aria-describedby={errors.length ? `${id}-error` : undefined} tabIndex={errors.length ? -1 : undefined}>
    <div className={`${field.label === field.group && kind === "record" ? "sr-only" : "mb-1 flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1"}`}>
      <label htmlFor={id} className="text-[13px] font-semibold text-foreground">{field.label}</label>
      {field.optional && <Toggle label={field.optional.label} on={present} disabled={locked} onClick={() => change(present ? undefined : seed(schema, field), present)} />}
    </div>
    <p id={`${id}-help`} className="mb-2 text-xs text-muted-foreground">{field.help}{field.appliesAt === "restart" ? " Applies after a restart." : ""}</p>
    {errors.length > 0 && <p id={`${id}-error`} role="alert" className="mt-2 break-words text-xs text-destructive">{errors.join(" · ")}</p>}
    <div className="min-w-0">
      {kind === "unsupported" || readOnly ? <div className="space-y-1"><p className={META}>{readOnly ? field.readOnly?.reason : "Edited outside Settings"}</p><pre className="whitespace-pre-wrap break-words rounded-lg bg-surface-raised p-3 text-xs text-foreground">{JSON.stringify(value, null, 2) ?? "Not set"}</pre></div>
        : kind === "record" ? <fieldset disabled={locked || Boolean(field.optional && !present)} className="min-w-0 space-y-4 border-l border-border pl-3">
          {settingsFields(schema, field.fields ?? [], value).map((child) => <SettingsField key={child.key} field={child} base={path} snapshot={snapshot} session={session} store={store} disabled={locked || Boolean(field.optional && !present)} />)}
        </fieldset>
        : kind === "list" ? <ListField {...{ field, path, schema, snapshot, session, store }} value={value} disabled={locked} onChange={change} />
        : kind === "tags" ? <TagsField id={id} label={field.label} value={Array.isArray(display) ? display as string[] : []} disabled={locked || Boolean(field.optional && !present)} onChange={change} describedBy={describedBy} invalid={errors.length > 0} adding={adding} setAdding={setAdding} />
        : kind === "weights" ? <WeightsField id={id} label={field.label} value={record(display) ? display : {}} disabled={locked} onChange={change} term={adding} setTerm={setAdding} />
        : kind === "multichoice" ? <MultiChoiceField id={id} field={field} value={Array.isArray(display) ? display as string[] : []} disabled={locked} onChange={change} />
        : kind === "toggle" ? <Toggle label={field.label} on={Boolean(display)} disabled={locked} onClick={() => change(!display)} />
        : kind === "choice" ? <ChoiceField {...{ id, field, schema, display, describedBy }} disabled={locked} invalid={errors.length > 0} onChange={change} />
        : kind === "number" ? <div className="flex min-w-0 flex-wrap items-center gap-2">
          <NumberField {...{ id, display, field, describedBy }} disabled={locked || Boolean(field.optional && !present)} invalid={errors.length > 0} onChange={change} onError={(error) => store.setState((s) => ({ localErrors: { ...s.localErrors, [key]: error } }))} />
          <span className="text-xs text-muted-foreground">{field.currency} {field.unit}</span>
        </div>
        : <input id={id} className={INPUT} value={typeof display === "string" ? display : ""} disabled={locked || Boolean(field.optional && !present)} aria-describedby={describedBy} aria-invalid={errors.length > 0} onChange={(e) => change(e.target.value)} />}
    </div>
    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
      <span className={META}>{source === "brain-config" ? "from brain config" : source}{!present && display !== undefined ? " · absent until edited" : ""}</span>
      {own && <Button label="Reset" tone="quiet" size="sm" block={false} disabled={disabled || session.busy !== null} style={{ minHeight: 44 }} onClick={() => change(undefined, true)} />}
      {source === "brain-config" && !readOnly && kind !== "unsupported" && <Button label={`Override ${field.label}`} tone="quiet" size="sm" block={false} disabled={disabled || session.busy !== null} style={{ minHeight: 44 }} onClick={() => change(structuredClone(value))} />}
    </div>
    {(session.draftNotes ?? snapshot.notes)?.filter((note) => note.key === key).map((note) => <p key={note.text} className="mt-2 text-xs text-muted-foreground">{session.draft !== snapshot.overrides && !session.draftNotes ? "Saved settings: " : ""}{note.text}</p>)}
  </div>;
}

function ChoiceField({ id, field, schema, display, describedBy, disabled, invalid, onChange }: { id: string; field: ModuleSettingsField; schema: Record<string, unknown>; display: unknown; describedBy: string; disabled: boolean; invalid: boolean; onChange: (value: unknown) => void }) {
  const options = field.options ?? (Array.isArray(schema.enum) ? schema.enum.map((value) => ({ value, label: String(value), disabled: false })) : []);
  const known = options.some((option) => option.value === display);
  if (options.length <= 4 && known) return <div role="radiogroup" id={id} aria-label={field.label} aria-describedby={describedBy} aria-invalid={invalid} className="flex flex-wrap gap-2">{options.map((option) => <label key={String(option.value)} className={`flex min-h-11 min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-sm ${option.value === display ? "bg-primary text-primary-foreground" : "bg-surface-raised text-foreground"}`}><input type="radio" name={id} checked={option.value === display} disabled={disabled || option.disabled} onChange={() => onChange(option.value)} />{option.label}</label>)}</div>;
  return <select id={id} aria-describedby={describedBy} aria-invalid={invalid} disabled={disabled} value={String(display ?? "")} className={INPUT} onChange={(event) => onChange(options.find((option) => String(option.value) === event.target.value)?.value ?? event.target.value)}>
    {!known && display !== undefined && <option value={String(display)}>{String(display)} · engine uses its existing fallback</option>}
    {options.map((option) => <option key={String(option.value)} value={String(option.value)} disabled={option.disabled}>{option.label}</option>)}
  </select>;
}

function NumberField({ id, display, field, disabled, invalid, describedBy, onChange, onError }: { id: string; display: unknown; field: ModuleSettingsField; disabled: boolean; invalid: boolean; describedBy: string; onChange: (v: unknown) => void; onError: (v: string) => void }) {
  const numeric = typeof display === "number" ? display : typeof display === "string" && display.trim() ? Number(display) : NaN;
  const fractionalLegacy = field.minorUnits && !invalid && Number.isFinite(numeric) && !Number.isInteger(numeric);
  const text = field.minorUnits && !invalid && Number.isFinite(numeric) && !fractionalLegacy ? (numeric / 100).toFixed(2) : display === undefined || display === null ? "" : String(display);
  function enter(raw: string) {
    if (field.minorUnits) {
      if (!/^\d+(?:\.\d{0,2})?$/.test(raw)) { onChange(raw); onError("Use at most 2 decimals (whole cents)"); return; }
      const [whole, fraction = ""] = raw.split(".");
      onChange(Number(whole) * 100 + Number(fraction.padEnd(2, "0")));
    } else onChange(raw.trim() && Number.isFinite(Number(raw)) ? Number(raw) : raw);
  }
  if (fractionalLegacy || (display !== undefined && display !== null && typeof display !== "number" && typeof display !== "string")) return <div className="w-full"><p className={META}>Edited outside Settings · stored value preserved</p><pre className="whitespace-pre-wrap break-words text-xs">{JSON.stringify(display, null, 2)}</pre></div>;
  return <div className="flex min-w-0 flex-1 items-center gap-1">
    {!field.minorUnits && <button type="button" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50" aria-label={`Decrease ${field.label}`} disabled={disabled} onClick={(e) => onChange((Number.isFinite(numeric) ? numeric : 0) - (field.step ?? 1) * (e.shiftKey ? 5 : 1))}><Minus size={16} /></button>}
    <input id={id} className={INPUT} inputMode="decimal" value={text} disabled={disabled} aria-invalid={invalid} aria-describedby={describedBy} onChange={(e) => enter(e.target.value)} onKeyDown={(e) => { if (!field.minorUnits && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); onChange((Number.isFinite(numeric) ? numeric : 0) + (e.key === "ArrowUp" ? 1 : -1) * (field.step ?? 1) * (e.shiftKey ? 5 : 1)); } }} />
    {!field.minorUnits && <button type="button" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50" aria-label={`Increase ${field.label}`} disabled={disabled} onClick={(e) => onChange((Number.isFinite(numeric) ? numeric : 0) + (field.step ?? 1) * (e.shiftKey ? 5 : 1))}><Plus size={16} /></button>}
  </div>;
}

function TagsField({ id, label, value, disabled, onChange, describedBy, invalid, adding, setAdding }: { id: string; label: string; value: string[]; disabled: boolean; onChange: (v: string[]) => void; describedBy: string; invalid: boolean; adding: string; setAdding: (value: string) => void }) {
  const add = () => { if (adding.trim()) { onChange([...value, adding.trim()]); setAdding(""); } };
  return <div className="space-y-2"><ul className="flex min-w-0 flex-wrap gap-1">{value.map((tag, i) => <li key={i} className="flex max-w-full items-center rounded-lg bg-surface-raised pl-3 text-xs text-foreground"><span className="min-w-0 break-words">{tag}</span><button type="button" aria-label={`Remove ${tag}`} disabled={disabled} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50" onClick={() => onChange(value.filter((_, at) => at !== i))}><X size={16} /></button></li>)}</ul><div className="flex min-w-0 gap-2"><input id={id} aria-label={`Add ${label}`} className={INPUT} disabled={disabled} aria-invalid={invalid} aria-describedby={describedBy} value={adding} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} /><Button label="Add" tone="quiet" block={false} disabled={disabled || !adding.trim()} style={{ minHeight: 44 }} onClick={add} /></div></div>;
}

function WeightsField({ id, label, value, disabled, onChange, term, setTerm }: { id: string; label: string; value: Record<string, unknown>; disabled: boolean; onChange: (v: Record<string, unknown>) => void; term: string; setTerm: (value: string) => void }) {
  return <div className="space-y-2">{Object.entries(value).map(([key, weight]) => <div key={key} className="flex min-w-0 flex-wrap items-center gap-2"><span className="min-w-0 flex-1 break-words text-sm">{key}</span><input aria-label={`${key} weight`} className={`${INPUT} basis-24 max-w-32`} inputMode="decimal" value={String(weight)} disabled={disabled} onChange={(e) => onChange(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === key ? Number(e.target.value) : v])))} /><Button label={`Remove ${key}`} icon="dismiss" tone="quiet" block={false} disabled={disabled} style={{ minHeight: 44 }} onClick={() => onChange(Object.fromEntries(Object.entries(value).filter(([k]) => k !== key)))} /></div>)}<div className="flex gap-2"><input id={id} aria-label={`Add ${label} key`} className={INPUT} value={term} disabled={disabled} onChange={(e) => setTerm(e.target.value)} /><Button label="Add" tone="quiet" block={false} disabled={disabled || !term.trim() || Object.hasOwn(value, term.trim())} style={{ minHeight: 44 }} onClick={() => { onChange(Object.fromEntries([...Object.entries(value), [term.trim(), 1]])); setTerm(""); }} /></div></div>;
}

function MultiChoiceField({ id, field, value, disabled, onChange }: { id: string; field: ModuleSettingsField; value: string[]; disabled: boolean; onChange: (v: string[]) => void }) {
  const [filter, setFilter] = useState("");
  const options = field.options ?? [];
  return <div className="space-y-1">{options.length > 8 && <input aria-label={`Filter ${field.label}`} placeholder={`Filter ${field.label}`} className={INPUT} value={filter} onChange={(e) => setFilter(e.target.value)} />}{options.filter((o) => o.label.toLowerCase().includes(filter.toLowerCase())).map((option, i) => <label key={option.value} className="flex min-h-11 items-start gap-3 rounded-lg px-2 py-2 hover:bg-surface-raised"><input id={i === 0 ? id : undefined} type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-primary" checked={value.includes(option.value)} disabled={disabled || Boolean(option.disabled && !value.includes(option.value))} onChange={(e) => onChange(e.target.checked ? [...value, option.value] : value.filter((v) => v !== option.value))} /><span className="min-w-0 text-sm"><span className="block break-words">{option.label}</span><span className="block text-xs text-muted-foreground">{option.disabled && value.includes(option.value) ? "saved but not run: " : ""}{option.help}</span></span></label>)}{value.filter((v) => !options.some((o) => o.value === v)).map((v) => <div key={v} className="flex min-w-0 flex-wrap items-center gap-2"><p className="min-w-0 break-words text-xs text-muted-foreground">{v} · saved source is unavailable</p><Button label={`Remove ${v}`} tone="quiet" block={false} disabled={disabled} style={{ minHeight: 44 }} onClick={() => onChange(value.filter((saved) => saved !== v))} /></div>)}</div>;
}

function ListField({ field, path, schema, value, snapshot, session, store, disabled, onChange }: Omit<FieldProps, "base"> & { path: SettingsPath; schema: Record<string, unknown>; value: unknown; onChange: (v: unknown[]) => void }) {
  const [removing, setRemoving] = useState<number | null>(null);
  const items = Array.isArray(value) ? value : [];
  const itemSchema = record(schema.items) ? schema.items : { type: "object" };
  const fields = field.fields ?? [];
  const titleKey = field.itemTitle ?? Object.entries(record(itemSchema.properties) ? itemSchema.properties : {}).find(([, s]) => record(s) && s.type === "string")?.[0];
  function remapVariants(mapIndex: (index: number) => number | null) {
    const prefix = path.join(".") + ".";
    const remap = <T,>(entries: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(entries).flatMap(([key, value]) => {
      if (!key.startsWith(prefix)) return [[key, value]];
      const rest = key.slice(prefix.length).split(".");
      const index = mapIndex(Number(rest[0]));
      return index === null ? [] : [[prefix + [index, ...rest.slice(1)].join("."), value]];
    }));
    store.setState((state) => ({
      variants: remap(state.variants), pendingInputs: remap(state.pendingInputs), localErrors: remap(state.localErrors),
      errors: state.errors.flatMap((error) => Object.keys(remap({ [error.path]: true })).map((path) => ({ ...error, path }))),
    }));
  }
  function move(index: number, delta: number) {
    const next = [...items];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    onChange(next);
    remapVariants((at) => at === index ? index + delta : at === index + delta ? index : at);
  }
  return <div className="min-w-0 space-y-3">{items.map((item, index) => {
    const title = String(titleKey && record(item) ? item[titleKey] ?? `Item ${index + 1}` : `Item ${index + 1}`) || "Untitled item";
    const content = <><div className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2">{!field.collapsible && <h4 className="min-w-0 break-words text-sm font-semibold">{title || "Untitled item"}</h4>}<div className="flex flex-wrap items-center gap-1">{field.orderMatters && <><button type="button" className="flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface disabled:opacity-50" aria-label={`Move ${title} up`} disabled={disabled || index === 0} onClick={() => move(index, -1)}><ArrowUp size={16} /></button><button type="button" className="flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface disabled:opacity-50" aria-label={`Move ${title} down`} disabled={disabled || index === items.length - 1} onClick={() => move(index, 1)}><ArrowDown size={16} /></button></>}<Button label={`Remove ${title}`} icon="dismiss" tone="quiet" block={false} disabled={disabled} style={{ minHeight: 44, maxWidth: "100%", overflowWrap: "anywhere" }} onClick={() => setRemoving(index)} /></div></div>
      {removing === index && <div className="mb-3 flex flex-wrap items-center gap-2" role="alert"><span className="text-xs">Remove {title}?</span><Button label="Remove" tone="quiet" block={false} disabled={disabled} style={{ minHeight: 44 }} onClick={() => { onChange(items.filter((_, i) => i !== index)); remapVariants((at) => at === index ? null : at > index ? at - 1 : at); setRemoving(null); }} /><Button label="Keep" tone="quiet" block={false} style={{ minHeight: 44 }} onClick={() => setRemoving(null)} /></div>}
      <div className="min-w-0 space-y-3">{settingsFields(itemSchema, fields, item).map((child) => <SettingsField key={child.key} field={child} base={[...path, index]} snapshot={snapshot} session={session} store={store} disabled={disabled} />)}</div>
    </>;
    const note = (session.draftNotes ?? snapshot.notes).find((n) => n.key === [...path, index].join("."));
    return field.collapsible ? <Surface key={index} pad={3}><details open={!disabled && index === 0}><summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold focus-visible:ring-2 focus-visible:ring-primary"><span className="break-words">{title || "Untitled item"}</span>{note && <span className="mt-1 block text-xs font-normal text-muted-foreground">{note.text}</span>}</summary>{content}</details></Surface> : <div key={index} className="min-w-0 border-t border-border pt-3">{content}</div>;
  })}<Button label={field.addLabel ?? `Add ${field.label} item`} icon="add" tone="quiet" disabled={disabled} style={{ minHeight: 44 }} onClick={() => {
    const described = { ...field, kind: "record" as const };
    const item = seed(itemSchema, described);
    onChange([...items, item]);
  }} /></div>;
}

function VariantField({ field, base, snapshot, session, store, disabled }: FieldProps) {
  const path = base;
  const key = path.join(".");
  const value = valueAt(mergeSettings(snapshot.inherited, session.draft), path);
  const variants = field.variants ?? [];
  const detected = variants.find((v) => Array.isArray(valueAt(value, [v.key])))?.key ?? variants.find((v) => valueAt(value, [v.key]) !== undefined)?.key ?? variants[0]?.key ?? "";
  const selection = session.variants[key];
  const selected = selection?.selected ?? detected;
  return <div className="min-w-0 space-y-3"><label className="block text-[13px] font-semibold">{field.label}</label><div role="group" aria-label={field.label} className="flex flex-wrap gap-2">{variants.map((variant) => <button key={variant.key} type="button" disabled={disabled} aria-pressed={variant.key === selected} className={`min-h-11 rounded-lg px-3 py-2 text-xs focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 ${variant.key === selected ? "bg-primary text-primary-foreground" : "bg-surface-raised text-foreground hover:bg-surface"}`} onClick={() => {
    store.setState((s) => {
      const original = s.variants[key] ?? { original: detected, selected: detected, keys: variants.map((v) => v.key), originallyPresent: variants.filter((v) => valueAt(value, [v.key]) !== undefined).map((v) => v.key) };
      let draft = s.draft;
      for (const child of variant.fields) if (valueAt(mergeSettings(snapshot.inherited, draft), joinPath(path, child.key)) === undefined) draft = replaceAt(draft, joinPath(path, child.key), seed(schemaAt(snapshot.schema, joinPath(path, child.key)), child)) as Record<string, unknown>;
      return { draft, variants: { ...s.variants, [key]: { ...original, selected: variant.key } }, message: null };
    });
  }}>{variant.label}</button>)}</div>{variants.map((variant) => <div key={variant.key} className={variant.key === selected ? "space-y-3" : "space-y-3 opacity-60"}>
    {variant.key !== selected && valueAt(value, [variant.key]) !== undefined && <p className={META}>{variant.label} · not used · preserved until an explicit style change is saved</p>}
    {variant.key === selected ? variant.fields.map((child) => <SettingsField key={child.key} field={child} base={path} snapshot={snapshot} session={session} store={store} disabled={disabled} />) : valueAt(value, [variant.key]) !== undefined ? <pre className="whitespace-pre-wrap break-words text-xs">{JSON.stringify(valueAt(value, [variant.key]), null, 2)}</pre> : null}
  </div>)}</div>;
}
