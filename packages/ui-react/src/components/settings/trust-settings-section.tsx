import { createStore, useStore, type StoreApi } from "zustand";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type SetStateAction } from "react";
import { Button, Callout, ChoiceOption, Surface } from "@schlessera/brain-ui-kit";
import { parseTrustOrigin, parseTrustTunnel, parseTrustGithub, TrustRuleSchema, TrustedSourcesSchema } from "@schlessera/brain-ui-sdk/schemas";
import { useBrainUiRoot } from "../../root-context.js";
import { ApiRequestError } from "../../lib/api-client.js";
import { trustTarget, type TrustChange, type TrustOperation, type TrustRule, type TrustSettingsRead } from "../../lib/trust-settings.js";
import { AgentPolicyGroup } from "./agent-policy-group.js";

type Draft = { action: "create" | "edit" | "remove"; rule: TrustRule | null; kind: TrustRule["selector"]["kind"]; target: string; providerId: string; label: string; incoming: boolean; recipient: boolean; revision: string; hash: string | null };

type Session = { draft: Draft | null; operation: TrustOperation | null; uncertain: boolean };
const sessions = new WeakMap<object, { epoch: number; store: StoreApi<Session> }>();
function sessionFor(root: object, epoch: number) {
  let session = sessions.get(root);
  if (!session || session.epoch !== epoch) { session = { epoch, store: createStore<Session>(() => ({ draft: null, operation: null, uncertain: false })) }; sessions.set(root, session); }
  return session.store;
}

/** Owner review uses the host's exact bytes. Lost commits are read, never replayed. */
export function TrustSettingsSection({ active }: { active: boolean }) {
  const root = useBrainUiRoot(), api = root.api;
  const [read, setRead] = useState<TrustSettingsRead | null>(null);
  const session = sessionFor(root, root.authLock.epoch());
  const { draft, operation, uncertain } = useStore(session);
  const setDraft = (value: SetStateAction<Draft | null>) => session.setState(state => ({ draft: typeof value === "function" ? value(state.draft) : value }));
  const setOperation = (operation: TrustOperation | null) => session.setState({ operation });
  const setUncertain = (uncertain: boolean) => session.setState({ uncertain });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const readRequest = useRef(0);
  const generation = useRef(0), epoch = useRef(root.authLock.epoch()), controller = useRef(new AbortController());
  const opener = useRef<HTMLElement | null>(null), heading = useRef<HTMLHeadingElement>(null), editor = useRef<HTMLDivElement>(null);
  const focusEditor = useRef(false), restoreFocus = useRef(false), focusReview = useRef(false);
  const current = useCallback((token: number) => token === generation.current && epoch.current === root.authLock.epoch() && !controller.current.signal.aborted, [root]);
  const load = useCallback(async () => {
    const token = generation.current, request = ++readRequest.current;
    try { const next = await api.trustSettings(controller.current.signal); if (current(token) && request === readRequest.current) { setRead(next); return next; } }
    catch (err) { if (current(token) && request === readRequest.current) setError(err instanceof ApiRequestError && err.status === 403 ? "Read-only: a live password or passkey owner login is required to manage trust." : "Trust settings unavailable. No configured rule is confirmed active."); }
    return null;
  }, [api, current]);
  useEffect(() => {
    generation.current++; epoch.current = root.authLock.epoch(); const lifetime = new AbortController(); controller.current = lifetime;
    setRead(null); setError(""); setNotice(""); setBusy(false);
    if (!active) return () => lifetime.abort();
    void load();
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    const timer = setInterval(refresh, 30_000); window.addEventListener("focus", refresh);
    const stop = root.authLock.state.subscribe(state => {
      if (state.phase !== "active") { generation.current++; lifetime.abort(); setRead(null); session.setState({ draft: null, operation: null, uncertain: false }); setError(""); setNotice(""); setBusy(false); opener.current = null; }
    });
    return () => { generation.current++; lifetime.abort(); clearInterval(timer); window.removeEventListener("focus", refresh); stop(); };
  }, [active, root, load, session]);
  useLayoutEffect(() => {
    if (focusReview.current && operation) { focusReview.current = false; editor.current?.querySelector<HTMLElement>("[data-trust-review]")?.focus(); }
    if (focusEditor.current && draft) { focusEditor.current = false; editor.current?.querySelector<HTMLElement>("input, [tabindex='-1']")?.focus(); }
    if (restoreFocus.current && !draft) { restoreFocus.current = false; (opener.current?.isConnected ? opener.current : heading.current)?.focus(); }
  }, [draft, operation]);
  function close() { setDraft(null); setOperation(null); setError(""); setUncertain(false); restoreFocus.current = true; }
  function start(action: Draft["action"], rule: TrustRule | null = null, repository = false) {
    if (!read || busy) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setError(""); setNotice(""); setOperation(null); setUncertain(false); focusEditor.current = true;
    setDraft({ action, rule, kind: rule?.selector.kind ?? (repository ? "github_repository" : "web_origin"), providerId: "", target: rule ? trustTarget(rule.selector).replace(" · opaque tunnel", "") : "", label: rule?.label ?? "", incoming: rule?.incomingContent ?? true, recipient: rule?.recipientWhileRestricted ?? false, revision: read.revision, hash: read.policyHash });
  }
  async function prepare() {
    if (!draft || !read || busy || !canMutate) return;
    let change: TrustChange;
    try {
      if (draft.action === "remove") change = { action: "remove", ruleId: draft.rule!.id };
      else {
        const rule = TrustRuleSchema.parse({ id: draft.rule?.id ?? crypto.randomUUID(), label: draft.label,
          selector: draft.rule?.selector ?? (() => {
            if (draft.kind === "web_origin") return parseTrustOrigin(draft.target);
            if (draft.kind === "tunnel_authority") return parseTrustTunnel(draft.target);
            const names = parseTrustGithub(draft.target);
            if (draft.kind === "github_repository") {
              if (!names.repository) throw new Error("Enter owner/repository for an exact repository rule.");
              return { kind: draft.kind, host: names.host, owner: names.owner, repository: names.repository, repositoryId: draft.providerId };
            }
            if (names.repository) throw new Error("Enter only the owner for an organization rule.");
            return { kind: draft.kind, host: names.host, owner: names.owner, ownerId: draft.providerId };
          })(), incomingContent: draft.incoming, recipientWhileRestricted: draft.recipient });
        TrustedSourcesSchema.parse([...read.rules.filter(r => r.id !== rule.id), rule]);
        change = { action: draft.action, rule };
      }
    } catch (err) { setError(err instanceof Error ? err.message.includes("Duplicate trust") ? "This canonical target already has a rule. Edit that rule instead." : err.message : "Check the fields."); return; }
    const token = generation.current; setBusy(true); setError("");
    try { const next = await api.trustPrepare(change, draft.revision, draft.hash, controller.current.signal); if (current(token)) { focusReview.current = true; setOperation(next); } }
    catch (err) { if (current(token)) { setError(`Nothing saved. ${err instanceof Error ? err.message : "Review failed"}. Refresh the base and review again; your draft is kept.`); } }
    finally { if (current(token)) setBusy(false); }
  }
  async function settle(next: TrustOperation) {
    setOperation(next);
    const receipt = next.receipt;
    if (receipt.stage === "prepared" || receipt.stage === "unknown" || receipt.stage === "file_published") { setUncertain(true); setNotice("Save is not confirmed. Check the same receipt; no automatic retry will publish again."); return; }
    if (receipt.publication === "proved") {
      setNotice(`Publication proved. ${receipt.enforcement === "enforced" ? "Future admissions updated." : "Runtime enforcement unavailable."} Current rule: ${receipt.currentRule}. Historical events are unchanged.`);
      await load(); close();
    } else if (receipt.stage === "refused") { setOperation(null); setUncertain(false); setError(`Nothing saved: ${receipt.reason ?? "refused"}. Refresh the base and review again; your draft is kept.`);
    } else { setUncertain(true); setError(`Change not confirmed: ${receipt.reason ?? receipt.stage}. Your draft is kept.`); }
  }
  async function commit() {
    if (!operation || busy || uncertain || !canMutate) return;
    const token = generation.current; setBusy(true); setUncertain(true);
    try { const next = await api.trustCommit(operation, controller.current.signal); if (current(token)) await settle(next); }
    catch { if (current(token)) { setUncertain(true); setError("Save outcome unknown. Check the receipt before making another change."); } }
    finally { if (current(token)) setBusy(false); }
  }
  async function check() {
    if (!operation || busy) return; const token = generation.current; setBusy(true);
    try { const next = await api.trustReceipt(operation.receipt.requestId, controller.current.signal); if (current(token)) await settle(next); }
    catch { if (current(token)) setError("Receipt unavailable. Save remains unconfirmed; your draft is kept."); }
    finally { if (current(token)) setBusy(false); }
  }
  const canMutate = !!read && read.mutationAllowed === true && !read.error;
  if (!active) return null;
  return <section data-trust-settings className="my-5 min-w-0 space-y-4" style={{ overflowWrap: "anywhere" }}>
    <h3 ref={heading} tabIndex={-1} className="text-sm font-semibold">Source trust and data sending</h3>
    <p className="text-xs">Rules apply to future input only. Settings never marks historical events safe or clears a chat's restrictions.</p>
    {error && <div role="alert"><Callout tone="gold" variant="banner" text={error} /></div>}
    <p role="status" className="text-xs">{notice}</p>
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
          <div className="flex flex-wrap gap-4"><Button label="Edit" ariaLabel={`Edit ${trustTarget(rule.selector)}`} reach block={false} disabled={!canMutate || busy || !!draft || rule.selector.kind.startsWith("github_") && !read.capabilities.repositoryRules} onClick={() => start("edit", rule)} />
            <Button label="Remove" ariaLabel={`Remove ${trustTarget(rule.selector)}`} reach block={false} disabled={!canMutate || busy || !!draft} onClick={() => start("remove", rule)} /></div>
        </div></Surface>)}
        <Button label={title === "Trusted origins" ? "Add origin" : "Add repository or organization"} reach block={false} disabled={!canMutate || busy || !!draft || (title === "Trusted origins" ? !read.capabilities.originRules : !read.capabilities.repositoryRules)} onClick={() => start("create", null, title !== "Trusted origins")} />
      </div>)}
    </>}
    {draft && <div ref={editor} className="space-y-4 rounded-lg border border-border p-3" aria-label="Trust rule editor">
      <h4 tabIndex={-1} className="text-sm font-semibold">{draft.action === "remove" ? "Review removal" : "Trust rule"}</h4>
      {draft.action === "remove" ? <p className="text-xs">Remove {trustTarget(draft.rule!.selector)}? This affects future input and data sending only. Historical events remain unchanged; already dispatched operations cannot be recalled.</p> : <>
        <label className="block text-xs">Label<input className="mt-1 min-h-11 w-full rounded border border-border bg-surface p-2 text-sm" value={draft.label} disabled={busy || !!operation} onChange={e => setDraft({ ...draft, label: e.target.value })} /></label>
        {draft.rule ? <p className="text-xs">Target: {trustTarget(draft.rule.selector)}. To change a target, remove it and add the new one.</p> : <>
          <label className="block text-xs">Target type<select className="mt-1 min-h-11 w-full rounded border border-border bg-surface p-2 text-sm" value={draft.kind} disabled={busy || !!operation} onChange={e => setDraft({ ...draft, kind: e.target.value as Draft["kind"] })}>{draft.kind.startsWith("github_") ? <><option value="github_repository">Exact GitHub repository</option><option value="github_owner">GitHub owner / organization</option></> : <><option value="web_origin">HTTP(S) origin</option><option value="tunnel_authority">Opaque tunnel</option></>}</select></label>
          <label className="block text-xs">{draft.kind === "web_origin" ? "Origin" : draft.kind === "tunnel_authority" ? "Tunnel host:port" : draft.kind === "github_repository" ? "GitHub owner/repository" : "GitHub owner"}<input className="mt-1 min-h-11 w-full rounded border border-border bg-surface p-2 text-sm" value={draft.target} disabled={busy || !!operation} onChange={e => setDraft({ ...draft, target: e.target.value })} /></label>
          {draft.kind.startsWith("github_") && <label className="block text-xs">Stable provider ID (verified independently by the host)<input className="mt-1 min-h-11 w-full rounded border border-border bg-surface p-2 text-sm" value={draft.providerId} disabled={busy || !!operation} onChange={e => setDraft({ ...draft, providerId: e.target.value })} /></label>}
          {draft.kind === "github_owner" && <p className="text-xs">This broad scope includes present and future repositories currently owned by this namespace.</p>}
          {draft.kind === "tunnel_authority" && <p className="text-xs">Trust covers the whole opaque connection, not verified HTTPS content.</p>}
        </>}
        <div role="group" aria-label="Independent trust permissions" className="space-y-4"><ChoiceOption multiple title="Trust future incoming content" selected={draft.incoming} disabled={busy || !!operation || draft.kind.startsWith("github_")} onClick={() => setDraft({ ...draft, incoming: !draft.incoming })} />
        <ChoiceOption multiple title="Allow sending data while restricted" subtitle="Allows data to be sent to this destination even when another trigger restricts the chat. Independent deny rules, byte limits and credential checks still apply." selected={draft.recipient} disabled={busy || !!operation || draft.kind.startsWith("github_") || !read?.capabilities.recipientRules} onClick={() => setDraft({ ...draft, recipient: !draft.recipient })} /></div>
      </>}
      {operation && <div className="space-y-3"><h4 data-trust-review tabIndex={-1} className="text-sm font-semibold">Review exact policy change</h4><p className="text-xs">Source trust and recipient permission are independent. Review both in these exact bytes before Save. This does not resolve historical events.</p><pre tabIndex={0} className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{operation.review.diff}</pre></div>}
      <div className="flex flex-wrap gap-4">
        <Button label="Cancel" reach block={false} disabled={busy || uncertain} onClick={close} />
        {!operation ? <><Button label="Review change" reach block={false} disabled={busy || !canMutate} onClick={() => void prepare()} /><Button label="Refresh base" reach block={false} disabled={busy} onClick={async () => { const next = await load(); if (next) setDraft(value => value && { ...value, revision: next.revision, hash: next.policyHash }); }} /></>
          : uncertain ? <Button label="Check save receipt" reach block={false} disabled={busy} onClick={() => void check()} /> : <Button label={draft.action === "remove" ? "Remove rule" : "Save rule"} reach block={false} disabled={busy || !canMutate} onClick={() => void commit()} />}
      </div>
    </div>}
    <AgentPolicyGroup active={active} />
  </section>;
}
