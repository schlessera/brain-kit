import { createStore, useStore, type StoreApi } from "zustand";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type SetStateAction } from "react";
import { Button, Callout, ChoiceOption, Surface } from "@schlessera/brain-ui-kit";
import { parseTrustOrigin, parseTrustTunnel, parseTrustGithub, TrustRuleSchema, TrustedSourcesSchema } from "@schlessera/brain-ui-sdk/schemas";
import { useBrainUiRoot } from "../../root-context.js";
import { ApiRequestError } from "../../lib/api-client.js";
import { trustTarget, type TrustChange, type TrustOperation, type TrustRule, type TrustSettingsRead } from "../../lib/trust-settings.js";
import { AgentPolicyGroup } from "./agent-policy-group.js";

type Draft = { focusField?: string; focused?: boolean; action: "create" | "edit" | "remove"; rule: TrustRule | null; instance: string | null; kind: TrustRule["selector"]["kind"]; target: string; providerId: string; label: string; incoming: boolean; recipient: boolean; revision: string; hash: string | null };
type Edit = { phase: "draft" | "preparing"; draft: Draft; operation: null }
  | { phase: "review" | "committing" | "uncertain" | "receipt-lost"; draft: Draft; operation: TrustOperation };
type Session = { edit: Edit | null; unknownOutcomes: number };
const sessions = new WeakMap<object, { epoch: number; store: StoreApi<Session> }>();
const draftEdit = (draft: Draft): Edit => ({ phase: "draft", draft, operation: null });
function sessionFor(root: object, epoch: number) {
  let session = sessions.get(root);
  if (!session || session.epoch !== epoch) { session = { epoch, store: createStore<Session>(() => ({ edit: null, unknownOutcomes: 0 })) }; sessions.set(root, session); }
  return session.store;
}
const instanceAt = (read: TrustSettingsRead, id: string) => typeof read.instances?.[id] === "string" ? read.instances[id]! : null;
function selectionMatches(draft: Draft, read: TrustSettingsRead) {
  if (!draft.rule) return true;
  if (JSON.stringify(read.rules.find(rule => rule.id === draft.rule!.id)) !== JSON.stringify(draft.rule)) return false;
  const instance = instanceAt(read, draft.rule.id);
  return draft.instance !== null && instance !== null ? draft.instance === instance : draft.revision === read.revision;
}
function capabilitiesAllow(draft: Pick<Draft, "action" | "kind" | "incoming" | "recipient">, read: TrustSettingsRead) {
  if (draft.action === "remove") return true;
  const caps = read.capabilities;
  if (draft.kind.startsWith("github_")) return caps.repositoryRules && caps.repositoryIdentity;
  return (!draft.incoming || caps.originRules) && (!draft.recipient || caps.recipientRules);
}

/** The transition table and its browser cases live in hit-reach.trust-settings.pointer.tsx. */
export function TrustSettingsSection({ active }: { active: boolean }) {
  const root = useBrainUiRoot(), api = root.api;
  const [readState, setReadState] = useState<{ root: object; epoch: number; value: TrustSettingsRead } | null>(null);
  const read = readState?.root === root && readState.epoch === root.authLock.epoch() ? readState.value : null;
  const setRead = useCallback((value: TrustSettingsRead | null) => setReadState(value ? { root, epoch: root.authLock.epoch(), value } : null), [root]);
  const frameScope = useRef({ root, epoch: root.authLock.epoch() });
  const currentFrame = frameScope.current.root === root && frameScope.current.epoch === root.authLock.epoch();
  const [policyRefresh, setPolicyRefresh] = useState(0);
  const session = sessionFor(root, root.authLock.epoch());
  const { edit, unknownOutcomes } = useStore(session);
  const draft = edit?.draft ?? null, operation = edit?.operation ?? null;
  const uncertain = edit?.phase === "uncertain" || edit?.phase === "receipt-lost";
  const [checking, setChecking] = useState(false);
  const busy = checking || edit?.phase === "preparing" || edit?.phase === "committing";
  const setDraft = (value: SetStateAction<Draft | null>) => session.setState(state => {
    const next = typeof value === "function" ? value(state.edit?.draft ?? null) : value;
    return { edit: next ? state.edit ? { ...state.edit, draft: next } : draftEdit(next) : null };
  });
  const [error, setError] = useState(""), [readError, setReadError] = useState(""), [notice, setNotice] = useState("");
  const readRequest = useRef(0), generation = useRef(0), epoch = useRef(root.authLock.epoch()), controller = useRef(new AbortController());
  const opener = useRef<HTMLElement | null>(null), heading = useRef<HTMLHeadingElement>(null), editor = useRef<HTMLDivElement>(null);
  const focusEditor = useRef(draft?.focused ?? false), restoreFocus = useRef(false), focusReview = useRef(false);
  const current = useCallback((token: number) => token === generation.current && epoch.current === root.authLock.epoch() && !controller.current.signal.aborted, [root]);
  const ownerMessage = "Read-only: a live password or passkey owner login is required to manage trust.";
  const invalidatePrivate = useCallback((readDenied: boolean) => {
    generation.current++; session.setState(state => ({
      edit: readDenied || !state.edit ? null : draftEdit(state.edit.draft),
      unknownOutcomes: readDenied ? 0 : state.unknownOutcomes + (state.edit && ["committing", "uncertain", "receipt-lost"].includes(state.edit.phase) ? 1 : 0),
    }));
    setChecking(false); setError(""); setNotice("");
  }, [session]);
  function ownerRefused(err: unknown) {
    if (!(err instanceof ApiRequestError) || ![401, 403].includes(err.status)) return false;
    invalidatePrivate(true); setRead(null); setReadError(ownerMessage); return true;
  }
  const load = useCallback(async () => {
    const token = generation.current, request = ++readRequest.current;
    try {
      const next = await api.trustSettings(controller.current.signal);
      if (current(token) && request === readRequest.current) {
        const pending = session.getState().edit;
        if (next.mutationAllowed !== true) invalidatePrivate(false);
        else if (pending && ["preparing", "review"].includes(pending.phase) && (pending.draft.revision !== next.revision || pending.draft.hash !== next.policyHash)) {
          generation.current++; session.setState({ edit: draftEdit(pending.draft) }); setChecking(false);
          setNotice("Policy changed. Refresh base and review again; your draft is kept.");
        }
        setRead(next); setReadError(""); setPolicyRefresh(request); return next;
      }
    } catch (err) {
      if (current(token) && request === readRequest.current) {
        setRead(null);
        if (err instanceof ApiRequestError && [401, 403].includes(err.status)) { invalidatePrivate(true); setReadError(ownerMessage); }
        else {
          generation.current++; setChecking(false);
          session.setState(state => ({ edit: !state.edit ? null : state.edit.phase === "preparing" ? draftEdit(state.edit.draft)
            : state.edit.phase === "committing" ? { ...state.edit, phase: "uncertain" } : state.edit }));
          setReadError("Trust settings unavailable. No configured rule is confirmed active.");
        }
      }
    }
    return null;
  }, [api, current, invalidatePrivate, session, setRead]);
  useEffect(() => {
    frameScope.current = { root, epoch: root.authLock.epoch() };
    generation.current++; epoch.current = root.authLock.epoch(); const lifetime = new AbortController(); controller.current = lifetime;
    setRead(null); setError(""); setReadError(""); setNotice(""); setChecking(false);
    if (!active) return () => lifetime.abort();
    void load();
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    const timer = setInterval(refresh, 30_000); window.addEventListener("focus", refresh);
    const stop = root.authLock.state.subscribe(state => {
      if (state.phase !== "active") { lifetime.abort(); invalidatePrivate(true); setRead(null); setReadError(""); opener.current = null; }
    });
    return () => {
      generation.current++; lifetime.abort(); clearInterval(timer); window.removeEventListener("focus", refresh); stop();
      session.setState(state => ({ edit: !state.edit ? null : state.edit.phase === "preparing" ? draftEdit(state.edit.draft)
        : state.edit.phase === "committing" ? { ...state.edit, phase: "uncertain" } : state.edit }));
    };
  }, [active, root, load, session, invalidatePrivate, setRead]);
  useLayoutEffect(() => {
    if (focusReview.current && operation) { focusReview.current = false; editor.current?.querySelector<HTMLElement>("[data-trust-review]")?.focus(); }
    if (focusEditor.current && draft && read) {
      focusEditor.current = false;
      const field = [...(editor.current?.querySelectorAll<HTMLElement>("[data-trust-focus]") ?? [])].find(node => node.dataset.trustFocus === draft.focusField && !node.matches(":disabled"));
      (field ?? editor.current?.querySelector<HTMLElement>("[data-trust-review], h4"))?.focus();
    }
    if (restoreFocus.current && !draft) { restoreFocus.current = false; (opener.current?.isConnected ? opener.current : heading.current)?.focus(); }
  }, [draft, operation, read]);
  function rememberFocus(target: EventTarget | null, focused: boolean) {
    const field = target instanceof HTMLElement ? target.closest<HTMLElement>("[data-trust-focus]")?.dataset.trustFocus : undefined;
    session.setState(state => !state.edit || state.edit.draft.focused === focused && (!field || state.edit.draft.focusField === field) ? {} : {
      edit: { ...state.edit, draft: { ...state.edit.draft, focused, focusField: field ?? state.edit.draft.focusField } },
    });
  }
  function close() { session.setState({ edit: null }); setError(""); setChecking(false); restoreFocus.current = true; }
  function leaveUnknown() {
    const pending = session.getState().edit;
    if (!pending?.operation || !["uncertain", "receipt-lost", "committing"].includes(pending.phase)) return;
    generation.current++; setChecking(false); setRead(null);
    session.setState(state => ({ edit: null, unknownOutcomes: state.unknownOutcomes + 1 }));
    setError(""); setNotice(""); restoreFocus.current = true; void load();
  }
  function start(action: Draft["action"], rule: TrustRule | null = null, repository = false) {
    if (!read || !canMutate || busy || edit) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setError(""); setNotice(""); focusEditor.current = true;
    session.setState({ edit: draftEdit({ action, rule, instance: rule ? instanceAt(read, rule.id) : null,
      kind: rule?.selector.kind ?? (repository ? "github_repository" : "web_origin"), providerId: "", target: rule ? trustTarget(rule.selector).replace(" · opaque tunnel", "") : "",
      label: rule?.label ?? "", incoming: rule?.incomingContent ?? true, recipient: rule?.recipientWhileRestricted ?? false, revision: read.revision, hash: read.policyHash }) });
  }
  async function prepare() {
    const pending = session.getState().edit;
    if (!pending || pending.phase !== "draft" || !read || busy || !canWrite || selectedChanged) return;
    const value = pending.draft; let change: TrustChange;
    try {
      if (value.action === "remove") change = { action: "remove", ruleId: value.rule!.id };
      else {
        const rule = TrustRuleSchema.parse({ id: value.rule?.id ?? crypto.randomUUID(), label: value.label,
          selector: value.rule?.selector ?? (() => {
            if (value.kind === "web_origin") return parseTrustOrigin(value.target);
            if (value.kind === "tunnel_authority") return parseTrustTunnel(value.target);
            const names = parseTrustGithub(value.target);
            if (value.kind === "github_repository") {
              if (!names.repository) throw new Error("Enter owner/repository for an exact repository rule.");
              return { kind: value.kind, host: names.host, owner: names.owner, repository: names.repository, repositoryId: value.providerId };
            }
            if (names.repository) throw new Error("Enter only the owner for an organization rule.");
            return { kind: value.kind, host: names.host, owner: names.owner, ownerId: value.providerId };
          })(), incomingContent: value.incoming, recipientWhileRestricted: value.recipient });
        TrustedSourcesSchema.parse([...read.rules.filter(r => r.id !== rule.id), rule]); change = { action: value.action, rule };
      }
    } catch (err) { setError(err instanceof Error ? err.message.includes("Duplicate trust") ? "This canonical target already has a rule. Edit that rule instead." : err.message : "Check the fields."); return; }
    const token = generation.current; session.setState({ edit: { phase: "preparing", draft: value, operation: null } }); setError("");
    try {
      const next = await api.trustPrepare(change, value.revision, value.hash, controller.current.signal);
      if (current(token)) { focusReview.current = true; session.setState({ edit: { phase: "review", draft: value, operation: next } }); }
    } catch (err) { if (current(token) && !ownerRefused(err)) { session.setState({ edit: draftEdit(value) }); setError(`Nothing saved. ${err instanceof Error ? err.message : "Review failed"}. Refresh the base and review again; your draft is kept.`); } }
  }
  function expiredReview(value: Draft) {
    session.setState({ edit: draftEdit(value) }); setChecking(false);
    setError("Review expired. Nothing was published. Refresh base and review again; your draft is kept.");
  }
  async function settle(next: TrustOperation) {
    const pending = session.getState().edit; if (!pending) return;
    const receipt = next.receipt;
    if (receipt.stage === "prepared" && receipt.publication === "not_published" && next.review.expiresAt < Date.now()) { expiredReview(pending.draft); return; }
    if (["prepared", "unknown", "file_published"].includes(receipt.stage)) {
      session.setState({ edit: { phase: "uncertain", draft: pending.draft, operation: next } });
      setNotice("Save is not confirmed. Check its receipt or leave its outcome unknown; no automatic retry will publish again."); return;
    }
    if (receipt.publication === "proved") {
      setNotice(`Publication proved. ${receipt.enforcement === "enforced" ? "Future admissions updated." : "Runtime enforcement unavailable."} Current rule: ${receipt.currentRule}. Historical events are unchanged.`);
      close(); setRead(null); await load();
    } else if (receipt.stage === "refused") { session.setState({ edit: draftEdit(pending.draft) }); setError(`Nothing saved: ${receipt.reason ?? "refused"}. Refresh the base and review again; your draft is kept.`); }
    else { session.setState({ edit: { phase: "uncertain", draft: pending.draft, operation: next } }); setError(`Change not confirmed: ${receipt.reason ?? receipt.stage}. Your draft is kept.`); }
  }
  async function commit() {
    const pending = session.getState().edit;
    if (!pending || pending.phase !== "review" || busy || !canWrite || selectedChanged) return;
    if (pending.operation.receipt.stage === "prepared" && pending.operation.receipt.publication === "not_published" && pending.operation.review.expiresAt < Date.now()) { expiredReview(pending.draft); return; }
    const token = generation.current; session.setState({ edit: { ...pending, phase: "committing" } });
    try { const next = await api.trustCommit(pending.operation, controller.current.signal); if (current(token)) await settle(next); }
    catch (err) { if (current(token)) {
      if (ownerRefused(err)) return;
      if (err instanceof ApiRequestError && err.message === "request_expired") expiredReview(pending.draft);
      else { session.setState({ edit: { ...pending, phase: "uncertain" } }); setError("Save outcome unknown. Check the receipt or leave it unknown without replaying it."); }
    } }
  }
  async function check() {
    const pending = session.getState().edit;
    if (!pending?.operation || busy) return; const token = generation.current; setChecking(true);
    try { const next = await api.trustReceipt(pending.operation.receipt.requestId, controller.current.signal); if (current(token)) await settle(next); }
    catch (err) { if (current(token) && !ownerRefused(err)) {
      session.setState({ edit: { ...pending, operation: pending.operation, phase: err instanceof ApiRequestError && err.status === 404 ? "receipt-lost" : "uncertain" } });
      setError("Receipt unavailable. Save outcome remains unknown. You can leave without replaying or confirming it.");
    } }
    finally { if (current(token)) setChecking(false); }
  }
  const canMutate = !!read && read.mutationAllowed === true && !read.error;
  const canWrite = canMutate && !!draft && !!read && capabilitiesAllow(draft, read);
  const conflict = "Selected rule changed or cannot be verified. Your draft is kept; cancel and select the current rule before reviewing again.";
  const selectedChanged = !!draft && !!read && !selectionMatches(draft, read);
  const capabilityError = canMutate && draft && !canWrite ? "Required enforcement capability is unavailable. Your draft is kept; review and Save are disabled." : "";
  const message = currentFrame ? readError || error || (selectedChanged ? conflict : capabilityError) : "";
  async function refreshBase() {
    if (busy) return; const token = generation.current; setChecking(true);
    try {
      const next = await load(), pending = session.getState().edit;
      if (!current(token) || !next || next.mutationAllowed !== true || next.error || !pending || pending.phase !== "draft") return;
      if (!selectionMatches(pending.draft, next)) { setError(conflict); return; }
      setDraft({ ...pending.draft, revision: next.revision, hash: next.policyHash, instance: pending.draft.rule ? instanceAt(next, pending.draft.rule.id) : null }); setError("");
    } finally { if (current(token)) setChecking(false); }
  }
  if (!active) return null;
  return <section data-trust-settings className="my-5 min-w-0 space-y-4" style={{ overflowWrap: "anywhere" }}>
    <h3 ref={heading} tabIndex={-1} className="text-sm font-semibold">Source trust and data sending</h3>
    <p className="text-xs">Rules apply to future input only. Settings never marks historical events safe or clears a chat's restrictions.</p>
    {message && <div role="alert"><Callout tone="gold" variant="banner" text={message} /></div>}
    <p role="status" className="text-xs">{unknownOutcomes > 0 && `${unknownOutcomes === 1 ? "A previous save outcome remains unknown" : `${unknownOutcomes} save outcomes remain unknown`}. No operation was replayed. `}{currentFrame ? notice : ""}</p>
    {!read ? <p className="text-xs">No trust policy loaded.</p> : <>
      {!canMutate && <p className="text-xs">Read-only. {read.error ? "Policy invalid or unavailable; last-valid rules (or empty defaults if none) are shown. No new rule can be saved." : "Only a live password or passkey owner can change these rules."}</p>}
      <p className="text-xs">Trust revision {read.revision} · Policy {read.policyHash ?? "built-in empty defaults"}</p>
      {!read.capabilities.originRules && <Callout tone="gold" variant="banner" text="Origin enforcement unavailable. Configured origins are not confirmed active." />}
      {!read.capabilities.recipientRules && <p className="text-xs">Recipient enforcement unavailable; configured permission is not confirmed active.</p>}
      {([['Trusted origins', read.origins], ['Repositories and organizations', read.repositories]] as const).map(([title, rules]) => <div key={title} className="space-y-3">
        <h4 className="text-xs font-semibold">{title}</h4>
        {title === "Repositories and organizations" && !read.capabilities.repositoryRules && <p className="text-xs">Repository enforcement unavailable. Repository and organization rules are disabled / unverified until qualified repository enforcement exists. Owner scopes include future repositories.</p>}
        {rules.length === 0 && <p className="text-xs">No rules configured. No sources gain trust from this list.</p>}
        {rules.map(rule => <Surface key={rule.id} emphasis="hairline"><div className="min-w-0 space-y-3 p-3">
          <p className="text-sm font-medium">{rule.label}</p><p className="font-mono text-xs">{trustTarget(rule.selector)}</p>
          <p className="text-xs">Source trust: {rule.incomingContent ? "configured" : "off"} · Sending data while restricted: {rule.recipientWhileRestricted ? "configured" : "off"}</p>
          {rule.selector.kind === "tunnel_authority" && <p className="text-xs">Opaque connection scope; this is not verified HTTPS.</p>}
          <div className="flex flex-wrap gap-4"><Button label="Edit" ariaLabel={`Edit ${trustTarget(rule.selector)}`} reach block={false} disabled={!canMutate || busy || !!draft || rule.selector.kind.startsWith("github_") && (!read.capabilities.repositoryRules || !read.capabilities.repositoryIdentity)} onClick={() => start("edit", rule)} />
            <Button label="Remove" ariaLabel={`Remove ${trustTarget(rule.selector)}`} reach block={false} disabled={!canMutate || busy || !!draft} onClick={() => start("remove", rule)} /></div>
        </div></Surface>)}
        <Button label={title === "Trusted origins" ? "Add origin" : "Add repository or organization"} reach block={false} disabled={!canMutate || busy || !!draft || (title === "Trusted origins" ? !read.capabilities.originRules : !read.capabilities.repositoryRules || !read.capabilities.repositoryIdentity)} onClick={() => start("create", null, title !== "Trusted origins")} />
      </div>)}
    </>}
    {draft && <div ref={editor} className="space-y-4 rounded-lg border border-border p-3" aria-label="Trust rule editor" onFocusCapture={event => rememberFocus(event.target, true)} onBlurCapture={event => {
      if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) rememberFocus(null, false);
    }}>
      <h4 tabIndex={-1} className="text-sm font-semibold">{draft.action === "remove" ? "Review removal" : "Trust rule"}</h4>
      {draft.action === "remove" ? <p className="text-xs">Remove {trustTarget(draft.rule!.selector)}? This affects future input and data sending only. Historical events remain unchanged; already dispatched operations cannot be recalled.</p> : <>
        <label className="block text-xs">Label<input className="mt-1 min-h-11 w-full rounded border border-border bg-surface p-2 text-sm" data-trust-focus="label" value={draft.label} disabled={busy || !!operation} onChange={e => setDraft({ ...draft, label: e.target.value })} /></label>
        {draft.rule ? <p className="text-xs">Target: {trustTarget(draft.rule.selector)}. To change a target, remove it and add the new one.</p> : <>
          <label className="block text-xs">Target type<select className="mt-1 min-h-11 w-full rounded border border-border bg-surface p-2 text-sm" data-trust-focus="type" value={draft.kind} disabled={busy || !!operation} onChange={e => setDraft({ ...draft, kind: e.target.value as Draft["kind"] })}>{draft.kind.startsWith("github_") ? <><option value="github_repository">Exact GitHub repository</option><option value="github_owner">GitHub owner / organization</option></> : <><option value="web_origin">HTTP(S) origin</option><option value="tunnel_authority">Opaque tunnel</option></>}</select></label>
          <label className="block text-xs">{draft.kind === "web_origin" ? "Origin" : draft.kind === "tunnel_authority" ? "Tunnel host:port" : draft.kind === "github_repository" ? "GitHub owner/repository" : "GitHub owner"}<input className="mt-1 min-h-11 w-full rounded border border-border bg-surface p-2 text-sm" data-trust-focus="target" value={draft.target} disabled={busy || !!operation} onChange={e => setDraft({ ...draft, target: e.target.value })} /></label>
          {draft.kind.startsWith("github_") && <label className="block text-xs">Stable provider ID (verified independently by the host)<input className="mt-1 min-h-11 w-full rounded border border-border bg-surface p-2 text-sm" data-trust-focus="provider" value={draft.providerId} disabled={busy || !!operation} onChange={e => setDraft({ ...draft, providerId: e.target.value })} /></label>}
          {draft.kind === "github_owner" && <p className="text-xs">This broad scope includes present and future repositories currently owned by this namespace.</p>}
          {draft.kind === "tunnel_authority" && <p className="text-xs">Trust covers the whole opaque connection, not verified HTTPS content.</p>}
        </>}
        <div role="group" aria-label="Independent trust permissions" className="space-y-4"><ChoiceOption multiple title="Trust future incoming content" selected={draft.incoming} disabled={busy || !!operation || draft.kind.startsWith("github_")} onClick={() => setDraft({ ...draft, incoming: !draft.incoming })} />
        <ChoiceOption multiple title="Allow sending data while restricted" subtitle="Allows data to be sent to this destination even when another trigger restricts the chat. Independent deny rules, byte limits and credential checks still apply." selected={draft.recipient} disabled={busy || !!operation || draft.kind.startsWith("github_") || !read?.capabilities.recipientRules} onClick={() => setDraft({ ...draft, recipient: !draft.recipient })} /></div>
      </>}
      {operation && canMutate && <div className="space-y-3"><h4 data-trust-review tabIndex={-1} className="text-sm font-semibold">Review exact policy change</h4><p className="text-xs">Source trust and recipient permission are independent. Review both in these exact bytes before Save. This does not resolve historical events.</p><pre tabIndex={0} className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{operation.review.diff}</pre></div>}
      <div className="flex flex-wrap gap-4">
        <Button label="Cancel" reach block={false} disabled={busy || uncertain} onClick={close} />
        {!operation ? <><Button label="Review change" reach block={false} disabled={busy || !canWrite || selectedChanged} onClick={() => void prepare()} /><Button label="Refresh base" reach block={false} disabled={busy} onClick={() => void refreshBase()} /></>
          : uncertain ? <><Button label="Check save receipt" reach block={false} disabled={busy} onClick={() => void check()} /></> : <Button label={draft.action === "remove" ? "Remove rule" : "Save rule"} reach block={false} disabled={busy || !canWrite || selectedChanged} onClick={() => void commit()} />}
        {(uncertain || edit?.phase === "committing") && <Button label="Leave as outcome unknown" reach block={false} onClick={leaveUnknown} />}
      </div>
      {edit?.phase === "committing" && <p className="text-xs">Save is pending. It may still finish if you leave its outcome unknown.</p>}
    </div>}
    <AgentPolicyGroup active={active && read !== null} refreshKey={policyRefresh} />
  </section>;
}
