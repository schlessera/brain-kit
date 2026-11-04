import { useRef, type KeyboardEvent, type Ref } from "react";
import { ApprovalCard, Button, Callout, DiffBlock, Surface } from "@schlessera/brain-ui-kit";
import type { ApifyGrantRead, ApifyPolicyMode, ApifyPolicyProposalRead, ApifySettingsRead } from "@schlessera/brain-ui-sdk/protocol";
import {
  COVERAGE_NOTE, grantNote, MODE_LABELS, providerCard, runLine, spendSummary, usd, type ApifyProviderCard,
} from "../../lib/apify.js";

/** One Settings edit in flight. The control keeps the host's value until the host confirms a change. */
export interface ApifyEdit {
  /** `enabled`, `discovery`, `actors` or `grant:{n}`. */
  target: string;
  /** What the change does, for announcements. */
  label: string;
  phase: "proposing" | "review" | "deciding" | "unconfirmed";
  proposal?: ApifyPolicyProposalRead;
}

export type ApifyFocusTarget = "provider" | "discovery" | "actors" | "grants" | "limits" | "today";

interface ApifyViewProps {
  read: ApifySettingsRead;
  edit: ApifyEdit | null;
  /** The last outcome, announced politely. */
  announcement: string;
  stale: boolean;
  checking: boolean;
  onTurn(enabled: boolean): void;
  onMode(field: "discovery" | "actors", mode: ApifyPolicyMode): void;
  onRevoke(grant: ApifyGrantRead, index: number): void;
  onCheck(): void;
  onConfirmAccount(): void;
  onReview(): void;
  onOpenPolicy(opener: HTMLElement): void;
  onOpenActivity(): void;
  onApprove(): void;
  onDecline(): void;
  onCheckProposal(): void;
  headings: Partial<Record<ApifyFocusTarget, Ref<HTMLHeadingElement>>>;
}

const HEADING = "text-xs font-medium uppercase tracking-wide text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/50 rounded";
const LINE = "text-xs text-muted-foreground";

/**
 * Settings › Accounts › External services › Apify (#3163, R1 A), in authority
 * order: provider and account, Catalog search, Running Actors, Approved
 * Actors, effective Limits, Today. Presentational (S6): the container owns
 * every request and the authority guards.
 */
export function ApifyView(props: ApifyViewProps) {
  const { read, edit } = props;
  const card = providerCard(read);
  const off = card.view === "off";
  const editable = read.policy.valid;
  const busy = edit !== null;
  return <div data-apify-settings data-apify-view={card.view} className="min-w-0 space-y-5" style={{ overflowWrap: "anywhere" }}>
    <span className="sr-only" role="status" aria-live="polite">{props.announcement}</span>
    <ProviderCard {...props} card={card} busy={busy} />
    {!off && <>
      <ModeGroup id="discovery" title="Catalog search" headingRef={props.headings.discovery}
        text="Agents look up Actors in the Apify Store. Only search words are sent; nothing runs or spends."
        value={read.policy.discovery} disabled={!editable || busy} onChoose={mode => props.onMode("discovery", mode)} {...props} />
      <ModeGroup id="actors" title="Running Actors" headingRef={props.headings.actors}
        text="Allow only skips review for an approved Actor below, at its exact build, input schema and price. Every other run still asks. Catalog search never lets anything run."
        value={read.policy.actors} disabled={!editable || busy} onChoose={mode => props.onMode("actors", mode)} {...props} />
    </>}
    <Grants {...props} off={off} busy={busy} editable={editable} />
    {!off && <Limits {...props} />}
    <Today {...props} />
  </div>;
}

function ProviderCard({ read, card, busy, edit, checking, onTurn, onCheck, onConfirmAccount, onReview, onOpenPolicy, headings, ...rest }: ApifyViewProps & { card: ApifyProviderCard; busy: boolean }) {
  const enabled = read.policy.enabled;
  return <section aria-labelledby="apify-provider-heading" className="space-y-2">
    <h4 id="apify-provider-heading" ref={headings.provider} tabIndex={-1} className={HEADING}>Apify · {card.label}</h4>
    <Surface emphasis="hairline" tone={card.tone === "red" ? "red" : card.tone === "gold" ? "gold" : card.tone === "teal" ? "teal" : "neutral"}>
      <div className="min-w-0 space-y-2 p-3">
        <p className="text-sm" data-apify-provider-text>{card.text}</p>
        <p className={LINE}>The token stays on the host; it's never shown or entered here. Turning Apify on, catalog search and each Actor run are separate permissions.</p>
        <div className="flex flex-wrap gap-2">
          {read.policy.valid && (enabled
            ? <Button label="Turn off" tone="quiet" block={false} reach disabled={busy} onClick={() => onTurn(false)} />
            : <Button label="Turn on" block={false} reach disabled={busy} onClick={() => onTurn(true)} />)}
          {card.view === "account_changed" && <>
            <Button label="Review approved Actors" tone="quiet" block={false} reach onClick={onReview} />
            <Button label={`Use ${read.pending_account?.username ?? "the new account"}`} tone="quiet" block={false} reach disabled={busy} onClick={onConfirmAccount} />
          </>}
          {["token_needed", "token_removed", "unavailable", "account_changed", "ready"].includes(card.view) &&
            <Button label={checking ? "Checking…" : "Check again"} tone="quiet" block={false} reach disabled={checking} onClick={onCheck} />}
          {card.view === "policy_invalid" && <Button label="Open policy" tone="quiet" block={false} reach onClick={() => { const opener = document.activeElement; if (opener instanceof HTMLElement) onOpenPolicy(opener); }} />}
        </div>
        {edit?.target === "enabled" && <EditState edit={edit} {...rest} read={read} checking={checking} onTurn={onTurn} onCheck={onCheck} onConfirmAccount={onConfirmAccount} onReview={onReview} onOpenPolicy={onOpenPolicy} headings={headings} />}
      </div>
    </Surface>
  </section>;
}

function ModeGroup(props: ApifyViewProps & { id: "discovery" | "actors"; title: string; text: string; value: ApifyPolicyMode; disabled: boolean;
  headingRef?: Ref<HTMLHeadingElement>; onChoose(mode: ApifyPolicyMode): void }) {
  const { id, title, text, value, edit, disabled, onChoose, headingRef } = props;
  const pending = edit?.target === id;
  const modes: ApifyPolicyMode[] = ["deny", "ask", "allow"];
  const group = useRef<HTMLDivElement>(null);
  function keys(event: KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const radios = [...group.current!.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    const index = radios.indexOf(event.currentTarget);
    const next = event.key === "Home" ? 0 : event.key === "End" ? radios.length - 1
      : (index + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + radios.length) % radios.length;
    for (const radio of radios) radio.tabIndex = -1;
    radios[next]!.tabIndex = 0;
    radios[next]!.focus();
  }
  return <section aria-labelledby={`apify-${id}-heading`} className="space-y-2">
    <h4 id={`apify-${id}-heading`} ref={headingRef} tabIndex={-1} className={HEADING}>{title}</h4>
    <p className={LINE} id={`apify-${id}-text`}>{text}</p>
    <div ref={group} role="radiogroup" aria-labelledby={`apify-${id}-heading`} aria-describedby={`apify-${id}-text`} aria-busy={pending || undefined}
      data-apify-mode={id} className="grid grid-cols-3 gap-1 rounded-lg bg-surface-raised p-1">
      {modes.map(mode => <button key={mode}
        // raw-button: select — a policy segment; arrows move focus, Enter/Space propose the change
        type="button" role="radio" aria-checked={value === mode} tabIndex={value === mode ? 0 : -1} disabled={disabled && value !== mode}
        aria-disabled={disabled || undefined} onKeyDown={keys}
        onClick={() => { if (!disabled && mode !== value) onChoose(mode); }}
        className={`min-h-11 min-w-0 rounded-md px-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${value === mode ? "bg-[var(--bk-color-canvas)] font-semibold text-foreground ring-2 ring-inset ring-[var(--bk-amber-ink)]" : "text-muted-foreground"} ${disabled && value !== mode ? "opacity-50" : ""}`}>
        {MODE_LABELS[mode]}
      </button>)}
    </div>
    {pending && <EditState {...props} edit={edit} />}
  </section>;
}

function Grants({ read, edit, off, busy, editable, onRevoke, onOpenPolicy, headings, ...rest }: ApifyViewProps & { off: boolean; busy: boolean; editable: boolean }) {
  return <section aria-labelledby="apify-grants-heading" className="space-y-2">
    <h4 id="apify-grants-heading" ref={headings.grants} tabIndex={-1} className={HEADING}>Approved Actors · {read.policy.grants.length}</h4>
    <p className={LINE}>Only this build, input schema and price, up to the cap. Any change asks again. Grants are added in the policy file, never by approving a run.</p>
    {read.policy.grants.length === 0 ? <p className="text-sm">No approved Actors. Every run asks first.</p>
      : <ul className="space-y-2" data-apify-grants>
        {read.policy.grants.map((grant, index) => {
          const target = `grant:${index}`;
          const inactive = off || grant.status !== "active";
          return <li key={`${grant.account_id}:${grant.actor_id}:${grant.build_number}:${grant.expires_at}`} data-apify-grant={grant.status}
            data-apify-grant-inactive={inactive || undefined}
            // Inactive rows are "dimmed" by a dashed border and raised fill, never by opacity: their text keeps full contrast.
            className={`min-w-0 rounded-lg border p-3 ${inactive ? "border-dashed border-border bg-surface-raised" : "border-border-subtle"}`}>
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="font-mono text-sm" style={{ overflowWrap: "anywhere" }}>{grant.actor_id}</p>
                <p className={LINE}>build {grant.build_number} · profile {grant.profile_id} · ≤ {usd(grant.max_run_usd)} a run</p>
                <p className={`text-xs ${grant.status === "active" && !off ? "text-muted-foreground" : "text-foreground"}`}>{grantNote(grant, off)}</p>
                {grant.origins.length > 0 && <p className={LINE}>Visits {grant.origins.join(", ")}</p>}
              </div>
              {editable && <Button label={grant.status === "active" ? "Revoke" : "Remove"} ariaLabel={`${grant.status === "active" ? "Revoke" : "Remove"} ${grant.actor_id} build ${grant.build_number}`}
                tone="quiet" block={false} reach disabled={busy} onClick={() => onRevoke(grant, index)} />}
            </div>
            {edit?.target === target && <EditState {...rest} read={read} edit={edit} onRevoke={onRevoke} onOpenPolicy={onOpenPolicy} headings={headings} />}
          </li>;
        })}
      </ul>}
    <div className="flex flex-wrap gap-2"><Button label="Open policy file" tone="quiet" block={false} reach onClick={() => { const opener = document.activeElement; if (opener instanceof HTMLElement) onOpenPolicy(opener); }} /></div>
  </section>;
}

function Limits({ read, onOpenPolicy, headings }: ApifyViewProps) {
  const limits = read.policy.limits, budgets = read.policy.budgets;
  return <section aria-labelledby="apify-limits-heading" className="space-y-2">
    <h4 id="apify-limits-heading" ref={headings.limits} tabIndex={-1} className={HEADING}>Limits</h4>
    {limits ? <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-sm" data-apify-limits>
      {([["Per run", usd(limits.run_usd)], ["Per turn", usd(limits.turn_usd)], ["Per conversation", usd(limits.session_usd)], ["Per UTC day, this account", usd(limits.day_usd)],
        ["Runs per turn", String(limits.max_runs_per_turn)], ["Requests per turn", String(limits.max_requests_per_turn)], ["Runs at once", String(limits.max_concurrent_runs)],
        ["Longest run", `${Math.round(limits.max_runtime_seconds / 60)} min`], ["Result items", String(limits.max_result_items)],
        ["Result size", `${Math.round(limits.max_result_bytes / 1024)} KB`], ["Results kept", `${Math.round(limits.max_retention_seconds / 86400)} days`]] as const)
        .map(([name, value]) => <div key={name} className="contents"><dt className="text-muted-foreground">{name}</dt><dd className="text-right font-mono">{value}</dd></div>)}
    </dl> : <p className="text-sm">No Apify limits are set, so no run can start. Catalog search still follows its own setting.</p>}
    <p className={LINE}>Your overall budgets still apply: {usd(budgets.turn_usd)} a turn, {usd(budgets.session_usd)} a conversation, {usd(budgets.day_usd)} a day. The lower limit wins; Apify never enlarges them.</p>
    <div className="flex flex-wrap gap-2"><Button label="Change limits in policy" tone="quiet" block={false} reach onClick={() => { const opener = document.activeElement; if (opener instanceof HTMLElement) onOpenPolicy(opener); }} /></div>
  </section>;
}

function Today({ read, stale, onOpenActivity, headings }: ApifyViewProps) {
  const summary = spendSummary(read.spend);
  return <section aria-labelledby="apify-today-heading" className="space-y-2">
    <h4 id="apify-today-heading" ref={headings.today} tabIndex={-1} className={HEADING}>Today</h4>
    <ApifySpendBody read={read} summary={summary} stale={stale} />
    <div className="flex flex-wrap gap-2"><Button label="Open Activity" tone="quiet" block={false} reach onClick={onOpenActivity} /></div>
  </section>;
}

/** Today's totals and unresolved runs; shared with Activity. */
export function ApifySpendBody({ read, summary = spendSummary(read.spend), stale = false }: { read: Pick<ApifySettingsRead, "spend">; summary?: { text: string; known: boolean }; stale?: boolean }) {
  return <div className="space-y-2" data-apify-spend={read.spend.ledger}>
    <p className="text-sm" data-apify-today>{summary.text}</p>
    {read.spend.ledger === "read" && <p className={LINE}>{read.spend.day ? "UTC day, this Apify account across brains." : "UTC day, this brain."} As of {new Date(read.spend.observed_at).toISOString().slice(11, 16)} UTC{stale ? " · may be out of date" : ""}. Inference is counted separately. {COVERAGE_NOTE}</p>}
    {read.spend.unresolved.length > 0 && <ul className="space-y-1" aria-label="Unresolved Apify runs" data-apify-unresolved>
      {read.spend.unresolved.map(run => {
        const line = runLine(run);
        return <li key={run.key} data-apify-run={run.state} className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 text-sm">
          <span className="min-w-0 flex-1"><span className="font-mono">{run.actor_id}</span> <span className={LINE}>build {run.build_number}</span>
            <span className={`block text-xs ${line.warn ? "text-[color:var(--bk-amber-ink)]" : "text-muted-foreground"}`}>{line.note}</span></span>
          <span className={`font-mono ${line.warn ? "text-[color:var(--bk-amber-ink)]" : ""}`} data-apify-run-value>{line.value}</span>
        </li>;
      })}
    </ul>}
  </div>;
}

/** The pending edit under its control: waiting, the exact review, or an unconfirmed answer. */
function EditState({ edit, onApprove, onDecline, onCheckProposal }: ApifyViewProps & { edit: ApifyEdit | null }) {
  if (!edit) return null;
  if (edit.phase === "proposing") return <p className={LINE} role="status">Waiting for approval…</p>;
  if (edit.phase === "unconfirmed") return <div className="space-y-2" data-apify-unconfirmed>
    <Callout tone="gold" text="The host hasn't confirmed this answer. The setting shows what the host last reported. Check again only reads this request; it never sends the answer twice." />
    <div className="flex flex-wrap gap-2"><Button label="Check again" tone="quiet" block={false} reach onClick={onCheckProposal} /></div>
  </div>;
  const review = edit.proposal!.review;
  return <ProposalReview review={review} deciding={edit.phase === "deciding"} onApprove={onApprove} onDecline={onDecline} />;
}

function ProposalReview({ review, deciding, onApprove, onDecline }: {
  review: ApifyPolicyProposalRead["review"]; deciding: boolean; onApprove(): void; onDecline(): void;
}) {
  return <div data-approval-card data-apify-review role="group" aria-label="Policy change proposed" tabIndex={-1} className="outline-none">
    <ApprovalCard tool="Policy change proposed" target={review.path} badge="Review policy" wrapHeader wrapActions diff="" risk=""
      allowLabel={deciding ? "Writing…" : "Approve and write"} denyLabel="Decline"
      onAllow={deciding ? undefined : onApprove} onDeny={deciding ? undefined : onDecline}>
      <blockquote className="text-sm">{review.rationale}</blockquote>
      <p className="text-xs">Changed: {review.sections.join(", ")}. This is the only confirmation; nothing changes until you approve.</p>
      <div className="max-h-60 min-w-0 overflow-auto" tabIndex={0} role="region" aria-label="Exact policy diff"><DiffBlock tinted variant="inset" text={review.frontmatterDiff} /></div>
      <p className="font-mono text-xs">Base: {review.baseHash ?? "no policy file"}</p>
      {review.warnings.map(warning => <Callout key={warning} tone="gold" text={warning} />)}
    </ApprovalCard>
  </div>;
}
