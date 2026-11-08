/**
 * Files the user marks untrusted (#2673): the toolbar control, the cue, the
 * `Marked untrusted` list and its dialogs. The approved design is revision 3
 * plus the unchanged parts of revision 2 on the issue.
 *
 * The host owns every fact. Nothing here changes optimistically: a cue, a
 * pressed control or a list row appears only from a host reply. Who may clear
 * comes from the host's `canClear`, and a reader's replies carry neither
 * missing records nor the marker's identity, so this code has nothing to hide.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Button, Callout, Icon, IconButton, Overlay, Placeholder, TextButton } from "@schlessera/brain-ui-kit";
import { ChevronLeft } from "lucide-react";
import type { BrainUiRoot } from "../../root.js";
import { useBrainUiRoot } from "../../root-context.js";

interface MarkedBy { label: string | null; you: boolean }
type MarkDetail =
  | { path: string; marked: false; canClear: boolean }
  | { path: string; marked: true; markedAt: number; missing: boolean; markedBy?: MarkedBy; canClear: boolean };
interface MarkRow { path: string; marked: true; markedAt: number; missing: boolean; markedBy?: MarkedBy }

/** What one host request came back as. `uncertain`: it may or may not have applied. */
type Failure = "unsupported" | "not-found" | "forbidden" | "owner-required" | "unreachable" | "uncertain" | "signed-out";
type Reply<T> = { ok: true; value: T } | { ok: false; failure: Failure };

const PURPLE = "var(--bk-purple-ink)";

async function call<T>(root: BrainUiRoot, path: string, init?: RequestInit, valid: (body: unknown) => boolean = () => true): Promise<Reply<T>> {
  // A request never sent changed nothing; one whose reply was lost may have.
  if (init?.method && init.method !== "GET" && typeof navigator !== "undefined" && navigator.onLine === false) return { ok: false, failure: "unreachable" };
  let response: Response;
  try { response = await root.request(`${root.apiBase()}${path}`, { credentials: "include", cache: "no-store", ...init }); }
  catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return { ok: false, failure: "signed-out" };
    return { ok: false, failure: !init?.method || init.method === "GET" ? "unreachable" : "uncertain" };
  }
  const body = await response.json().catch(() => null) as ({ error?: string } & T) | null;
  // A success that isn't this route's shape is a server that doesn't have it.
  if (response.ok) return body && valid(body) ? { ok: true, value: body } : { ok: false, failure: "unsupported" };
  // A server without the feature answers its generic not-found, never this route's own JSON error.
  if (response.status === 404) return { ok: false, failure: body?.error === "not_found" ? "not-found" : "unsupported" };
  if (response.status === 405) return { ok: false, failure: "unsupported" };
  if (response.status === 403) return { ok: false, failure: body?.error === "owner_required" ? "owner-required" : "forbidden" };
  if (response.status === 400) return { ok: false, failure: "forbidden" };
  if (response.status === 401) return { ok: false, failure: "signed-out" };
  return { ok: false, failure: !init?.method || init.method === "GET" ? "unreachable" : "uncertain" };
}
const query = (path: string) => `?path=${encodeURIComponent(path)}`;
const record = (body: unknown): body is Record<string, unknown> => typeof body === "object" && body !== null;
const isDetail = (body: unknown) => record(body) && typeof body.path === "string" && typeof body.marked === "boolean" && typeof body.canClear === "boolean"
  && (!body.marked || (typeof body.markedAt === "number" && typeof body.missing === "boolean"));
const readMark = (root: BrainUiRoot, path: string) => call<MarkDetail>(root, `/files/untrusted${query(path)}`, undefined, isDetail);
const readList = (root: BrainUiRoot) => call<{ marks: MarkRow[]; canClear: boolean }>(root, "/files/untrusted/list", undefined,
  body => record(body) && typeof body.canClear === "boolean" && Array.isArray(body.marks) && body.marks.every(isRow));
const isRow = (row: unknown) => record(row) && typeof row.path === "string" && typeof row.markedAt === "number" && typeof row.missing === "boolean";
const sendMark = (root: BrainUiRoot, path: string) => call<{ status: "marked" | "already_marked"; mark: MarkDetail }>(root, "/files/untrusted",
  { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) },
  body => record(body) && (body.status === "marked" || body.status === "already_marked") && isDetail(body.mark));
const sendClear = (root: BrainUiRoot, path: string) => call<{ status: "cleared" | "already_cleared" }>(root, `/files/untrusted${query(path)}`, { method: "DELETE" },
  body => record(body) && (body.status === "cleared" || body.status === "already_cleared"));

/** `12 Jul`: the design's mark date. */
function markDate(at: number): string {
  return new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
/** Who marked, for the owner only: the host sends no `markedBy` to anyone else. */
function byLine(markedBy: MarkedBy | undefined): string {
  if (!markedBy) return "";
  return markedBy.you ? " by you" : markedBy.label ? ` by ${markedBy.label}` : "";
}
function baseName(path: string): string { return path.split("/").pop() ?? path; }

// ── The Files surface's shared state ───────────────────────────────────────

type ListState =
  | { status: "loading" }
  | { status: "ready"; marks: MarkRow[]; canClear: boolean }
  | { status: "refused" } | { status: "offline" } | { status: "unsupported" };

interface MarksContext {
  list: ListState;
  /** Paths the host lists as present and marked, for the tree's cues. */
  present: ReadonlySet<string>;
  /** Bumped after every mark or clear, so a path's detail reads again. */
  revision: number;
  refresh(): Promise<void>;
  /** Settles once the refetched list is in. */
  changed(): Promise<void>;
  announce(text: string): void;
}
const Marks = createContext<MarksContext | null>(null);
export function useUntrustedMarks(): MarksContext | null { return useContext(Marks); }

/**
 * One per Files surface: the host's list, refetched on entry, after a mark or
 * clear and when the window regains focus, and the surface's one polite live
 * region. A viewer rendered without a Files surface makes its own.
 */
export function UntrustedMarksProvider({ children }: { children: ReactNode }) {
  const root = useBrainUiRoot();
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    const reply = await readList(root);
    if (mine !== generation.current) return;
    setList(reply.ok ? { status: "ready", marks: reply.value.marks, canClear: reply.value.canClear }
      : reply.failure === "unsupported" ? { status: "unsupported" }
      : reply.failure === "forbidden" || reply.failure === "owner-required" ? { status: "refused" }
      : reply.failure === "signed-out" ? { status: "loading" } : { status: "offline" });
  }, [root]);
  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => { window.removeEventListener("focus", onFocus); generation.current++; };
  }, [refresh]);
  // After sign-in the host state is read again (revision 2 §3, auth lock).
  useEffect(() => root.authLock.state.subscribe((state, previous) => {
    if (state.phase === "active" && previous.phase !== "active") { setRevision(value => value + 1); void refresh(); }
  }), [root, refresh]);
  const announce = useCallback((text: string) => {
    // Clear first so the same sentence twice is announced twice.
    setMessage("");
    queueMicrotask(() => setMessage(text));
  }, []);
  const changed = useCallback(() => { setRevision(value => value + 1); return refresh(); }, [refresh]);
  const present = useMemo(() => new Set(list.status === "ready" ? list.marks.filter(row => !row.missing).map(row => row.path) : []), [list]);
  const value = useMemo(() => ({ list, present, revision, refresh, changed, announce }), [list, present, revision, refresh, changed, announce]);
  return (
    <Marks.Provider value={value}>
      {children}
      {/* A polite live region without the status role: the viewer's own `File status` stays the surface's one status. */}
      <span className="sr-only" aria-live="polite" aria-atomic="true" data-untrusted-announcer="">{message}</span>
    </Marks.Provider>
  );
}
/** A provider unless one is already above. */
export function UntrustedMarksScope({ children }: { children: ReactNode }) {
  return useUntrustedMarks() ? <>{children}</> : <UntrustedMarksProvider>{children}</UntrustedMarksProvider>;
}

// ── One path's mark: the toolbar control, cue and rail ─────────────────────

type DetailState =
  | { status: "checking" } | { status: "unsupported" } | { status: "unknown" } | { status: "absent" }
  | { status: "ready"; mark: MarkDetail };

/** The mark of the open file, read from the host whenever the path or the surface's revision changes. */
function useMarkDetail(path: string | null): [DetailState, () => void, (mark: MarkDetail) => void] {
  const root = useBrainUiRoot();
  const marks = useUntrustedMarks();
  const [state, setState] = useState<{ path: string | null; detail: DetailState }>({ path, detail: { status: "checking" } });
  const [retry, setRetry] = useState(0);
  const revision = marks?.revision ?? 0;
  useEffect(() => {
    if (!path) return;
    let live = true;
    setState(current => current.path === path && current.detail.status === "ready" ? current : { path, detail: { status: "checking" } });
    void readMark(root, path).then(reply => {
      if (!live) return;
      setState({ path, detail: reply.ok ? { status: "ready", mark: reply.value }
        : reply.failure === "unsupported" ? { status: "unsupported" }
        : reply.failure === "not-found" || reply.failure === "forbidden" ? { status: "absent" }
        : reply.failure === "signed-out" ? { status: "checking" } : { status: "unknown" } });
    });
    return () => { live = false; };
  }, [root, path, revision, retry]);
  const detail = state.path === path ? state.detail : { status: "checking" as const };
  return [detail, () => setRetry(value => value + 1), (mark: MarkDetail) => setState({ path, detail: { status: "ready", mark } })];
}

/** `◆ untrusted · marked 12 Jul` (+ ` by …` for the owner): glyph and word, never colour alone. */
function MarkCue({ mark }: { mark: Extract<MarkDetail, { marked: true }> }) {
  return (
    <div className="mt-0.5 flex items-start gap-1 text-[10px] [overflow-wrap:anywhere]" style={{ color: PURPLE }} data-untrusted-cue="">
      <span className="mt-px shrink-0" aria-hidden="true"><Icon icon="unverified" size={11} color={PURPLE} /></span>
      <span>untrusted · marked {markDate(mark.markedAt)}{byLine(mark.markedBy)}</span>
    </div>
  );
}

type Intent = "mark" | "clear";
type DialogPhase =
  | { kind: "confirm" } | { kind: "busy" }
  | { kind: "failed"; text: string; retry: boolean }
  | { kind: "checking" } | { kind: "still-unknown" };

const COPY = {
  forbidden: "You don't have access to this file any more. Nothing was marked.",
  owner: "Only the owner can clear this mark. Nothing changed.",
  gone: "There's no file at this path any more. Nothing was marked.",
  unreachable: "Couldn't reach your brain. Nothing has changed yet.",
  checking: "Couldn't confirm the change. Checking…",
  stillUnknown: "Still couldn't check. Try again.",
  proxy: "On turns that run through the egress proxy, web access is limited to the untrusted allow-list and sites this chat already contacted. Your other web rules still apply.",
} as const;

/**
 * Send one intent for one captured path, and settle it from the host.
 * Returns the host's mark after success, the failure copy otherwise. An
 * uncertain reply is resolved by a fresh read, never assumed.
 */
async function settle(root: BrainUiRoot, intent: Intent, path: string, onChecking: () => void):
  Promise<{ done: true; mark: MarkDetail | null; already: boolean } | { done: false; phase: DialogPhase; signedOut?: boolean; gone?: boolean }> {
  const reply = intent === "mark" ? await sendMark(root, path) : await sendClear(root, path);
  if (reply.ok) {
    if ("mark" in reply.value) return { done: true, mark: reply.value.mark, already: reply.value.status === "already_marked" };
    return { done: true, mark: null, already: reply.value.status === "already_cleared" };
  }
  switch (reply.failure) {
    case "forbidden": return { done: false, phase: { kind: "failed", text: intent === "mark" ? COPY.forbidden : COPY.owner, retry: false } };
    case "owner-required": return { done: false, phase: { kind: "failed", text: COPY.owner, retry: false } };
    case "not-found": return { done: false, gone: true, phase: { kind: "failed", text: COPY.gone, retry: false } };
    case "unreachable": return { done: false, phase: { kind: "failed", text: COPY.unreachable, retry: true } };
    case "signed-out": return { done: false, signedOut: true, phase: { kind: "confirm" } };
    case "unsupported": case "uncertain": {
      onChecking();
      const check = await readMark(root, path);
      if (!check.ok) return { done: false, phase: { kind: "still-unknown" } };
      const applied = intent === "mark" ? check.value.marked : !check.value.marked;
      // The host shows the intent applied: that is the result. Otherwise nothing changed.
      return applied ? { done: true, mark: check.value, already: false } : { done: false, phase: { kind: "failed", text: COPY.unreachable, retry: true } };
    }
  }
}

/** The dialog body's actions, stacked where they don't fit side by side at 320px. */
function Actions({ cancelRef, children }: { cancelRef: RefObject<HTMLDivElement | null>; children: ReactNode }) {
  return <div className="mt-4 flex flex-wrap-reverse justify-end gap-2 any-pointer-coarse:gap-y-4 [&>*]:min-w-[120px] [&>*]:flex-1 tablet:[&>*]:flex-none" ref={cancelRef}>{children}</div>;
}
/** The kit Button is a `role="button"` element, not a native button. */
const CONTROL = '[role="button"], button';
/** A ref whose current is the first control inside `wrap`: Cancel, for the Overlay's initial focus. */
function firstButton(wrap: RefObject<HTMLElement | null>): RefObject<HTMLElement | null> {
  return { get current() { return wrap.current?.querySelector<HTMLElement>(CONTROL) ?? null; } } as RefObject<HTMLElement | null>;
}

function PhaseLine({ phase }: { phase: DialogPhase }) {
  const text = phase.kind === "failed" ? phase.text : phase.kind === "checking" ? COPY.checking : phase.kind === "still-unknown" ? COPY.stillUnknown : null;
  if (!text) return null;
  return <div className="mt-3" role="alert"><Callout tone="red" variant="banner" icon="failed" text={text} /></div>;
}

/**
 * The mark or clear confirmation. `path` is captured when it opened; the
 * caller closes it, sending nothing, if the viewer moves to another file.
 */
function ConfirmDialog({ intent, path, missing, reader, returnTo, onCancel, onDone, onGone, onSignedOut }: {
  intent: Intent; path: string; missing?: boolean; reader: boolean;
  /** Read by the Overlay as it closes, once the background is live again: the focus table's destination. */
  returnTo: () => HTMLElement | null;
  onCancel(): void; onDone(mark: MarkDetail | null, already: boolean): void; onGone(): void; onSignedOut(): void;
}) {
  const root = useBrainUiRoot();
  const [phase, setPhase] = useState<DialogPhase>({ kind: "confirm" });
  const wrap = useRef<HTMLDivElement>(null);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  const busy = phase.kind === "busy" || phase.kind === "checking";
  const run = async () => {
    setPhase({ kind: "busy" });
    const result = await settle(root, intent, path, () => { if (live.current) setPhase({ kind: "checking" }); });
    if (!live.current) return;
    if (result.done) return onDone(result.mark, result.already);
    if (result.signedOut) return onSignedOut();
    if (result.gone) onGone();
    setPhase(result.phase);
  };
  const title = intent === "mark" ? "Mark this file untrusted?" : missing ? "Clear the old mark?" : "Clear the untrusted mark?";
  const action = intent === "mark" ? "Mark untrusted" : missing ? "Clear old mark" : "Clear mark";
  const retry = phase.kind === "still-unknown" || (phase.kind === "failed" && phase.retry);
  const refused = phase.kind === "failed" && !phase.retry;
  return (
    <Overlay open variant="dialog" size="md" title={title} closedBy={busy ? "none" : "any"} initialFocus={firstButton(wrap)}
      onClose={() => { if (!busy) onCancel(); }} returnFocus={returnTo} data-untrusted-dialog={intent}>
      <div className="text-sm text-foreground" aria-busy={busy || undefined} data-untrusted-body="">
        <p className="font-[family-name:var(--font-mono)] text-xs text-muted-foreground [overflow-wrap:anywhere]">{path}</p>
        {intent === "mark" ? <>
          <p className="mt-3">From now on, a chat that opens this file with its file tools is treated as handling untrusted content until the chat ends:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Every outward action asks you first, even ones your policy allows.</li>
            <li>Changes to skills, instructions or memory are flagged in the journal.</li>
            <li data-proxy-bullet="">{COPY.proxy}</li>
          </ul>
          <p className="mt-3">The agent can still read the file. Chats that already opened it don't change. If the file moves, the mark stays with this path.{reader ? " Only the owner can see or clear it then." : ""}</p>
          {reader ? <p className="mt-3">Only the owner can clear a mark.</p> : null}
        </> : missing ? (
          <p className="mt-3">This removes the record for <span className="font-[family-name:var(--font-mono)] [overflow-wrap:anywhere]">{path}</span> only. If the file was moved, its new location isn't marked. Mark it there separately. Chats that already opened it stay untrusted until they end.</p>
        ) : <>
          <p className="mt-3">New chats that open this file won't be treated as untrusted because of it.</p>
          <p className="mt-3">Chats that already opened it stay untrusted until they end. A chat can still be untrusted for other reasons.</p>
        </>}
        <PhaseLine phase={phase} />
        <Actions cancelRef={wrap}>
          <Button tone="ghost" size="md" block={false} reach label="Cancel" onClick={onCancel} disabled={busy} />
          {refused ? null : <Button tone={intent === "mark" ? "primary" : "danger"} size="md" block={false} reach
            label={retry ? "Try again" : action} onClick={() => void run()} disabled={busy} />}
        </Actions>
      </div>
    </Overlay>
  );
}

/**
 * The toolbar's slot between Copy path and Share, and the cue under the
 * path. `focusTitle` puts focus on the file title when a reader's mark
 * removes the button that held it.
 */
export function useUntrustedToolbar(filePath: string | null, loaded: boolean, fileName: string, focusTitle: () => void): { control: ReactNode; cue: ReactNode } {
  const root = useBrainUiRoot();
  const marks = useUntrustedMarks();
  const path = loaded ? filePath : null;
  const [detail, retry, apply] = useMarkDetail(path);
  const [dialog, setDialog] = useState<{ intent: Intent; path: string } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  // Where focus lands when the dialog closes: the button (now Mark or Clear), or the title when it went away.
  const landing = useRef<"button" | "title">("button");
  const titleOf = () => { focusTitle(); return null; };
  const returnTo = () => landing.current === "button" && button.current?.isConnected ? button.current : titleOf();

  // Switching files closes the dialog and sends nothing. A reload of the same file keeps it.
  useEffect(() => { if (dialog && dialog.path !== filePath) setDialog(null); }, [filePath, dialog]);
  const announce = (text: string) => marks?.announce(text);

  let control: ReactNode = null, cue: ReactNode = null;
  if (!path) {}
  else if (detail.status === "unknown") {
    cue = (
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground" data-untrusted-unknown="">
        <span>Couldn't check the untrusted mark</span>
        <TextButton tone="link" label="Retry" onClick={retry} />
      </div>
    );
  } else if (detail.status === "ready") {
    const mark = detail.mark;
    if (!mark.marked) {
      control = <IconButton ref={button} size="md" name="Mark untrusted" haspopup="dialog" glyph={<Icon icon="unverified" size={14} />}
        onClick={() => setDialog({ intent: "mark", path })} data-untrusted-control="mark" />;
    } else {
      cue = <MarkCue mark={mark} />;
      if (mark.canClear) control = <IconButton ref={button} size="md" name="Untrusted: clear mark" haspopup="dialog"
        glyph={<Icon icon="unverified" size={14} color={PURPLE} />} onClick={() => setDialog({ intent: "clear", path })}
        style={{ color: PURPLE, background: "var(--bk-callout-tint-purple, transparent)" }} data-untrusted-control="clear" data-pressed="" />;
    }
  }
  const reader = detail.status === "ready" ? !detail.mark.canClear : true;
  const dialogNode = dialog ? (
    <ConfirmDialog intent={dialog.intent} path={dialog.path} reader={reader}
      returnTo={returnTo}
      onCancel={() => { landing.current = "button"; setDialog(null); }}
      onSignedOut={() => setDialog(null)}
      onGone={() => { void root.stores.file.getState().openFile(dialog.path); }}
      onDone={(mark, already) => {
        setDialog(null);
        if (mark) apply(mark);
        if (dialog.intent === "mark") {
          announce(already ? "This file was already marked untrusted." : `${fileName} marked untrusted`);
          landing.current = mark?.canClear ? "button" : "title";
        } else {
          announce(already ? "This mark was already cleared." : "Untrusted mark cleared");
          if (!mark) apply({ path: dialog.path, marked: false, canClear: true });
          landing.current = "button";
        }
        void marks?.changed();
      }} />
  ) : null;
  return { control: control || dialogNode ? <>{control}{dialogNode}</> : null, cue };
}

// ── The `Marked untrusted` list ────────────────────────────────────────────

/** The entry row that replaces the disabled `Untrusted only` filter. Hidden on a server without marks. */
export function MarkedUntrustedEntry({ onOpen, entryRef }: { onOpen(): void; entryRef?: RefObject<HTMLButtonElement | null> }) {
  const marks = useUntrustedMarks();
  // Drawn once the host answered with marks or a refusal: a row that appeared
  // and then vanished on an unsupported server would take focus with it. An
  // unreachable host draws no row until a refetch (on focus) reaches it.
  if (!marks || (marks.list.status !== "ready" && marks.list.status !== "refused")) return null;
  const count = marks.list.status === "ready" ? marks.list.marks.length : null;
  const name = count === null ? "Marked untrusted" : `Marked untrusted, ${count === 0 ? "no files" : count === 1 ? "1 file" : `${count} files`}`;
  return (
    <button /* raw-button: row — full-width entry row with glyph, count and chevron, focus target for All files */ ref={entryRef} type="button" aria-label={name} onClick={onOpen} data-untrusted-entry=""
      className="flex min-h-[44px] w-full items-center gap-2 px-4 text-left text-xs text-foreground hover:bg-surface-raised">
      {count ? <span aria-hidden="true"><Icon icon="unverified" size={12} color={PURPLE} /></span> : null}
      <span className="flex-1">Marked untrusted{count === null ? "" : count === 0 ? " · none" : ` · ${count}`}</span>
      <span aria-hidden="true" className="text-muted-foreground">›</span>
    </button>
  );
}

/**
 * The flat list of host records that replaces the tree area. Present rows
 * open their file; the owner's missing rows open the `Missing file` dialog.
 */
export function MarkedUntrustedList({ onAllFiles, onFind }: { onAllFiles(): void; onFind(): void }) {
  const root = useBrainUiRoot();
  const marks = useUntrustedMarks();
  const heading = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [missing, setMissing] = useState<MarkRow | null>(null);
  const [clearing, setClearing] = useState<MarkRow | null>(null);
  const returnRow = useRef<string | null>(null);
  // A finished clear names the row to focus once the dialog's close has committed.
  const [cleared, setCleared] = useState<{ next: string | null } | null>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); void marks?.refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const toRow = (path: string | null) => {
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-mark-row]") ?? [])];
    (rows.find(row => row.dataset.markRow === path) ?? heading.current)?.focus({ preventScroll: true });
  };
  // The clear settles after awaits, outside any discrete event, so its
  // `setClearing(null)` commits in a later task. Until then the modal dialog
  // keeps the list inert, and a frame can come first: focus after the commit
  // instead (#3665, the #3657 class).
  useEffect(() => { if (cleared) toRow(cleared.next); }, [cleared]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!marks) return null;
  const list = marks.list;
  const owner = list.status === "ready" && list.canClear;
  // Discrete clicks and Escape commit in a microtask, before any frame.
  const focusRow = (path: string | null) => requestAnimationFrame(() => toRow(path));
  const open = async (row: MarkRow) => {
    // A stale row (the mark was cleared or the file left) refreshes the list instead.
    const check = await readMark(root, row.path);
    if (!check.ok || !check.value.marked || check.value.missing !== row.missing) {
      await marks.refresh();
      marks.announce("The list was out of date and has been refreshed.");
      return;
    }
    if (row.missing) { returnRow.current = row.path; setMissing(row); }
    else void root.stores.file.getState().openFile(row.path);
  };
  return (
    <div className="flex flex-col" data-untrusted-list="">
      <div className="px-2 pt-1"><TextButton tone="meta" label="All files" glyph={<ChevronLeft className="h-3.5 w-3.5" />} onClick={onAllFiles} /></div>
      <div className="border-b border-border px-4 pb-3">
        <h3 ref={heading} tabIndex={-1} className="text-sm font-medium text-foreground" data-untrusted-heading="">Marked untrusted</h3>
        {list.status === "ready" ? <p className="mt-1 text-xs text-muted-foreground">{owner
          ? "Files you or others marked. Doesn't list other untrusted sources."
          : "Files marked by you or others. Doesn't list other untrusted sources. Marks on moved or deleted files are shown to the owner."}</p> : null}
      </div>
      {list.status === "loading" ? <div className="px-3 py-2" role="group" aria-label="Loading marked files"><Placeholder variant="loading" lines={3} bordered={false} pad={4} /></div>
        : list.status === "refused" ? <p className="px-4 py-4 text-sm text-foreground">This list isn't available with your current access.</p>
        : list.status === "offline" || list.status === "unsupported" ? <div className="px-4 py-4">
            <p className="text-sm text-foreground">Can't reach your brain right now.</p>
            <div className="mt-3"><Button label="Try again" tone="ghost" size="md" block={false} reach onClick={() => void marks.refresh()} /></div>
          </div>
        : list.marks.length === 0 ? <div className="px-4 py-4" data-untrusted-empty="">
            <p className="text-sm text-foreground">{owner ? "No files are marked untrusted." : "No files you can open are marked untrusted."}</p>
            <p className="mt-1 text-xs text-muted-foreground">Open a file and use Mark untrusted.</p>
          </div>
        : <ul ref={listRef} role="list" className="py-1">
            {list.marks.map(row => {
              const folder = row.path.includes("/") ? row.path.slice(0, row.path.lastIndexOf("/") + 1) : "";
              return (
                <li key={row.path}>
                  <button /* raw-button: row — composite list row (glyph, wrapped name, path meta) that opens a file or the missing dialog */ type="button" data-mark-row={row.path} onClick={() => void open(row)} aria-description={row.path}
                    className="flex min-h-[44px] w-full items-start gap-2 px-4 py-2 text-left hover:bg-surface-raised">
                    <span className="mt-0.5 shrink-0" aria-hidden="true">{row.missing
                      ? <span style={{ color: PURPLE }}>◇</span> : <Icon icon="unverified" size={12} color={PURPLE} />}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-foreground [overflow-wrap:anywhere]">{baseName(row.path)}</span>
                      <span className="block font-[family-name:var(--font-mono)] text-[10px] text-muted-foreground [overflow-wrap:anywhere]">
                        {folder}{folder ? " · " : ""}{row.missing ? "missing · " : ""}marked {markDate(row.markedAt)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>}
      {missing ? <MissingFileDialog row={missing} owner={owner}
        onClose={() => { setMissing(null); focusRow(returnRow.current); }}
        onFind={() => { setMissing(null); onFind(); }}
        onClear={() => { setClearing(missing); setMissing(null); }} /> : null}
      {clearing ? <ConfirmDialog intent="clear" path={clearing.path} missing reader={false} returnTo={() => null}
        onCancel={() => { setClearing(null); focusRow(clearing.path); }}
        onSignedOut={() => setClearing(null)} onGone={() => {}}
        onDone={async (_mark, already) => {
          const rows = list.status === "ready" ? list.marks : [];
          const next = rows[rows.findIndex(row => row.path === clearing.path) + 1]?.path ?? null;
          setClearing(null);
          marks.announce(already ? "This mark was already cleared." : "Untrusted mark cleared");
          await marks.changed();
          setCleared({ next });
        }} /> : null}
    </div>
  );
}

/** The owner's dialog for a retained record whose file is gone. Readers never get one. */
function MissingFileDialog({ row, owner, onClose, onFind, onClear }: { row: MarkRow; owner: boolean; onClose(): void; onFind(): void; onClear(): void }) {
  const wrap = useRef<HTMLDivElement>(null);
  // Focus goes to Close, the last action; the Overlay's own first stop would be Find it in Files.
  const close = { get current() { return wrap.current?.querySelector<HTMLElement>(`[data-missing-close] :is(${CONTROL})`) ?? null; } } as RefObject<HTMLElement | null>;
  return (
    <Overlay open variant="dialog" size="md" title="Missing file" onClose={onClose} initialFocus={close} returnFocus={false} data-missing-dialog="">
      <div className="text-sm text-foreground" ref={wrap} data-untrusted-body="">
        <p className="font-[family-name:var(--font-mono)] text-xs [overflow-wrap:anywhere]">{row.path}</p>
        <p className="text-xs text-muted-foreground">marked {markDate(row.markedAt)}</p>
        <p className="mt-3">There's no file at this path any more. It may have been moved, renamed or deleted. brain-kit doesn't follow moves, so a moved copy is not marked.</p>
        <p className="mt-3">To protect it, open the file at its new location and use Mark untrusted.</p>
        <p className="mt-3">This record stays so the mark comes back if a file returns to this path.</p>
        <div className="mt-4 flex flex-col gap-2 any-pointer-coarse:gap-y-4">
          <Button tone="ghost" size="md" reach label="Find it in Files" onClick={onFind} />
          {owner ? <Button tone="danger" size="md" reach label="Clear old mark" onClick={onClear} /> : null}
          <div data-missing-close=""><Button tone="ghost" size="md" reach label="Close" onClick={onClose} /></div>
        </div>
      </div>
    </Overlay>
  );
}

/** The wide evidence rail's block for the open file's mark. */
export function UntrustedRailBlock({ path }: { path: string }) {
  const [detail] = useMarkDetail(path);
  if (detail.status !== "ready" || !detail.mark.marked || detail.mark.missing) return null;
  const mark = detail.mark;
  return (
    <div className="flex flex-col gap-1" data-rail-block="untrusted">
      <div className="flex items-center gap-1 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-wide" style={{ color: PURPLE }}>
        Untrusted <span aria-hidden="true"><Icon icon="unverified" size={11} color={PURPLE} /></span>
      </div>
      <div className="font-[family-name:var(--font-mono)] text-[10px] text-muted-foreground">marked {markDate(mark.markedAt)}</div>
      {mark.markedBy && byLine(mark.markedBy) ? <div className="font-[family-name:var(--font-mono)] text-[10px] text-muted-foreground">{byLine(mark.markedBy).trim()}</div> : null}
    </div>
  );
}
