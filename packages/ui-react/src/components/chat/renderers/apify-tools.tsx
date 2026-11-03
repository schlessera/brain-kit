// Apify approvals and results (#3163).
//
// The host raises a per-use `command` card for each catalog search or
// inspection under `ask`, and for each Actor run without an exact grant
// (#3162). Those cards arrive under the fixed names below with the host's
// own review as their input; the `brain_apify_*` tools' results are the one
// envelope every front door returns. Everything an Actor or the catalog said
// is untrusted: it renders as bounded plain text, never as markdown or a link.

import type { RendererPack, ToolCallView } from "@schlessera/brain-ui-sdk/client";
import { APIFY_TOOL_NAMES } from "@schlessera/brain-ui-sdk/tool-contracts";
import { Button, Callout, Disclosure } from "@schlessera/brain-ui-kit";
import { Globe } from "lucide-react";
import { useEffect, useState } from "react";
import type { ApifyLimitsRead } from "@schlessera/brain-ui-sdk/protocol";
import { useBrainUiRoot } from "../../../root-context.js";
import { openApifySettings } from "../../../lib/apify-focus.js";
import { refusalCopy, usd } from "../../../lib/apify.js";
import { ClampedPre } from "../tool-views.js";

export const APIFY_APPROVAL_TOOLS = { search: "Apify catalog search", inspect: "Apify Actor inspection", run: "Apify Actor run" } as const;
const NAMES = new Set<string>(Object.values(APIFY_TOOL_NAMES));
/** The bare operation tool name, whichever backend spelling carried it. */
export function apifyToolName(name: string): string | null {
  const bare = name.startsWith("mcp__") ? name.split("__").at(-1)! : name;
  return NAMES.has(bare) ? bare : null;
}

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown, max = 300): string | null => typeof value === "string" && value.length ? value.slice(0, max) : null;

/** What the approval card names as its target: the Actor or the query, never the whole review as JSON. */
export function apifyApprovalTarget(tool: Pick<ToolCallView, "name" | "input">): string | null {
  const input = tool.input ?? {};
  if (tool.name === APIFY_APPROVAL_TOOLS.run) return text(record(input.actor)?.name, 201) ?? "an Apify Actor";
  if (tool.name === APIFY_APPROVAL_TOOLS.search) return text(input.query, 120) ?? "the Apify Store";
  if (tool.name === APIFY_APPROVAL_TOOLS.inspect) return text(input.actor, 201) ?? "an Apify Actor";
  return null;
}

function Row({ name, children, warn = false }: { name: string; children: React.ReactNode; warn?: boolean }) {
  return <div className="grid min-w-0 gap-x-3 gap-y-0.5 sm:grid-cols-[110px_minmax(0,1fr)]" data-apify-row={name}>
    <dt className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{name}</dt>
    <dd className={`min-w-0 text-sm ${warn ? "text-[color:var(--bk-amber-ink)]" : ""}`} style={{ overflowWrap: "anywhere" }}>{children}</dd>
  </div>;
}

/** The policy's effective limits, read from the owner's settings; null when unknown or not an owner. */
function useApifyLimits(): { limits: ApifyLimitsRead | null; read: boolean } {
  const root = useBrainUiRoot();
  const [state, setState] = useState<{ limits: ApifyLimitsRead | null; read: boolean }>({ limits: null, read: false });
  useEffect(() => {
    let live = true;
    const epoch = root.authLock.epoch();
    root.api.apify().then(read => { if (live && epoch === root.authLock.epoch()) setState({ limits: read.policy.limits, read: true }); }, () => undefined);
    return () => { live = false; };
  }, [root]);
  return state;
}

/** The exact run a person approves once (rev 1 §3): Actor, what is sent, who pays, cost and what is not covered. */
function ApifyRunReview({ tool }: { tool: ToolCallView }) {
  const root = useBrainUiRoot();
  const effective = useApifyLimits();
  const review = tool.input ?? {};
  const actor = record(review.actor), build = record(review.build), pricing = record(review.pricing), eligibility = record(review.eligibility);
  const origins = Array.isArray(review.origins) ? review.origins.filter((o): o is string => typeof o === "string").slice(0, 20) : [];
  const events = Array.isArray(pricing?.events) ? pricing!.events.map(record).filter(Boolean).slice(0, 10) as Record<string, unknown>[] : [];
  const uncertainty = Array.isArray(pricing?.uncertainty) ? pricing!.uncertainty.filter((u): u is string => typeof u === "string").slice(0, 10) : [];
  const reasons = Array.isArray(eligibility?.reasons) ? eligibility!.reasons.filter((r): r is string => typeof r === "string").slice(0, 10) : [];
  const executable = eligibility?.executable === true && typeof review.profile_id === "string";
  const cap = typeof review.max_charge_usd === "number" && Number.isFinite(review.max_charge_usd) ? review.max_charge_usd : null;
  const account = text(review.account_id, 64);
  const inputText = (() => { try { return JSON.stringify(review.input ?? null, null, 2).slice(0, 20_000); } catch { return "unreadable"; } })();
  const fields = record(review.input) ? Object.keys(record(review.input)!).length : 0;
  return <div className="min-w-0 space-y-2" data-apify-run-review>
    <dl className="grid min-w-0 gap-2">
      <Row name="Actor"><span className="font-mono">{text(actor?.name, 201) ?? "unknown"}</span>
        <span className="block text-xs text-muted-foreground">build {text(build?.number, 32) ?? "unknown"}{typeof review.profile_id === "string" ? ` · qualified profile ${review.profile_id.slice(0, 128)}` : " · no qualified profile"}</span>
        {text(actor?.title, 200) && <span className="block text-xs text-muted-foreground">{text(actor?.title, 200)} · described by the Actor, not checked</span>}</Row>
      <Row name="Sends to Apify">{fields} input {fields === 1 ? "field" : "fields"} to {text(review.recipient, 120) ?? "Apify"}.
        <span className="block text-xs text-muted-foreground">{origins.length ? `Visits ${origins.join(", ")} only.` : "Names no target sites."}</span></Row>
      <Row name="Charged to">{account ? `Apify account …${account.slice(-4)}` : "an unknown account"}</Row>
      <Row name="Cost">{cap === null ? "No cap stated" : `Up to ${usd(cap)}`}{events.length > 0 && <span className="block text-xs text-muted-foreground">
        {events.map(event => `${text(event.title, 80) ?? text(event.name, 80) ?? "event"} ${typeof event.price_usd === "number" ? usd(event.price_usd) : "price unknown"}${event.tiered ? " (tiered)" : ""}`).join(" · ")}</span>}
        <span className="block text-xs text-muted-foreground">{executable ? "A qualified profile backs this cap, and Apify is told to stop charging at it. Reading results and remote storage are reserved too, within your limits." : "This build isn't qualified to run here, so approving can't start it."}</span></Row>
      {(uncertainty.length > 0 || (!executable && reasons.length > 0)) && <Row name="Not covered" warn>
        {[...uncertainty, ...(!executable ? reasons : [])].map(reason => reason.replaceAll("_", " ")).join(" · ")}
        <span className="block text-xs">Something here is not bounded, so no paid run of it can start.</span></Row>}
      <Row name="Limits">{effective.limits
          ? <span data-apify-effective-limits>{`≤ ${usd(effective.limits.run_usd)} a run · ${Math.round(effective.limits.max_runtime_seconds / 60)} min · ${effective.limits.max_result_items} items · ${Math.round(effective.limits.max_result_bytes / 1024)} KB · results kept ${Math.round(effective.limits.max_retention_seconds / 86400)} days`}</span>
          : effective.read ? "No Apify limits are set, so this can't run." : null}
        <span className="block text-xs text-muted-foreground">Your Apify limits and overall budgets apply; the lower one wins.</span>
        <span className="mt-1 flex flex-wrap gap-2"><Button label="Show limits" tone="quiet" size="sm" block={false} reach onClick={() => openApifySettings(root, "limits")} /></span></Row>
    </dl>
    <div className="[&_[role=button]]:min-h-11"><Disclosure label={`Full input · ${fields} ${fields === 1 ? "field" : "fields"}`}>
      <pre tabIndex={0} aria-label="Full Actor input, as sent" className="max-h-60 min-w-0 overflow-auto whitespace-pre-wrap text-xs outline-none focus-visible:ring-2 focus-visible:ring-primary/50" data-apify-full-input style={{ overflowWrap: "anywhere" }}>{inputText}</pre>
    </Disclosure></div>
    <p className="text-xs text-muted-foreground">Allow once runs exactly this, once. To skip this review for this exact Actor, add a grant in the policy (Settings › Accounts › Apify).</p>
  </div>;
}

function ApifyCatalogReview({ tool }: { tool: ToolCallView }) {
  const input = tool.input ?? {};
  const search = tool.name === APIFY_APPROVAL_TOOLS.search;
  const recipients = (Array.isArray(input.recipient) ? input.recipient : [input.recipient]).filter((r): r is string => typeof r === "string");
  return <dl className="grid min-w-0 gap-2" data-apify-catalog-review>
    {search ? <Row name="Search words"><span className="font-mono">{text(input.query, 120) ?? ""}</span></Row>
      : <Row name="Actor"><span className="font-mono">{text(input.actor, 201) ?? ""}</span></Row>}
    <Row name="Sent to">{recipients.join(", ") || "Apify"}</Row>
    <p className="text-xs text-muted-foreground">{search ? "Only these words are sent. Finding an Actor doesn't let it run or spend." : "Only this Actor's identifier is sent. Inspecting doesn't let it run or spend."}</p>
  </dl>;
}

/** Parse the one envelope every front door returns, without trusting its shape. */
export function apifyEnvelope(output: string | undefined): { ok: boolean; operation: string; error?: { code: string; reason: string | null; message: string }; data?: unknown } | null {
  if (!output) return null;
  for (const candidate of [output, output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1)]) {
    try {
      const value = record(JSON.parse(candidate));
      if (value && typeof value.ok === "boolean" && typeof value.operation === "string") {
        const error = record(value.error);
        return { ok: value.ok, operation: value.operation, ...(error && typeof error.code === "string" ? { error: { code: error.code, reason: typeof error.reason === "string" ? error.reason : null, message: text(error.message, 600) ?? "" } } : {}), data: value.data };
      }
    } catch { /* Not an envelope. */ }
  }
  return null;
}

/** A refusal names the limiting fact and links to its setting; a run's state never claims a confirmed stop it doesn't have. */
export function ApifyResult({ tool }: { tool: ToolCallView }) {
  const root = useBrainUiRoot();
  const envelope = apifyEnvelope(tool.output);
  if (!envelope) return tool.output ? <ClampedPre text={tool.output} isError={tool.isError} /> : null;
  if (!envelope.ok && envelope.error) {
    const copy = refusalCopy(envelope.error);
    return <div className="min-w-0 space-y-2" data-apify-refusal={envelope.error.code} style={{ overflowWrap: "anywhere" }}>
      <Callout tone={envelope.error.code === "remote_outcome_unknown" ? "gold" : "neutral"} text={`${copy.title}. ${copy.text}`} />
      {envelope.error.message && <p className="text-xs text-muted-foreground">Host: {envelope.error.message}</p>}
      {copy.setting && <div className="flex flex-wrap gap-2"><Button label="Why" ariaLabel={`Why: open Apify ${copy.setting} settings`} tone="quiet" size="sm" block={false} reach onClick={() => openApifySettings(root, copy.setting!)} /></div>}
    </div>;
  }
  const data = record(envelope.data);
  if (data && (envelope.operation === "run" || envelope.operation === "status" || envelope.operation === "abort") && typeof data.state === "string") {
    const abort = typeof data.abort === "string" ? data.abort : null;
    const unknown = data.remote_outcome_unknown === true;
    const note = unknown ? "Apify hasn't confirmed whether this run started. Its reservation is kept until Apify reports."
      : abort === "unresolved" ? "Abort sent but not confirmed. Up to the reservation may still be charged."
      : abort === "requested" ? "Abort sent · not confirmed yet."
      : abort === "confirmed" ? "Apify confirmed the abort. Charges settle from Apify's report, not from the abort."
      : `Run ${String(data.state).replaceAll("_", " ")}.`;
    return <div className="min-w-0 space-y-2" data-apify-run-state={data.state} data-apify-abort={abort ?? "none"}>
      <Callout tone={unknown || abort === "unresolved" || abort === "requested" ? "gold" : "neutral"} text={note} />
      <div className="flex flex-wrap gap-2"><Button label="Spend and unresolved runs" tone="quiet" size="sm" block={false} reach onClick={() => openApifySettings(root, "today")} /></div>
    </div>;
  }
  return <ClampedPre text={tool.output ?? ""} isError={tool.isError} />;
}

export const apifyToolPack: RendererPack = {
  renderers: [
    { match: APIFY_APPROVAL_TOOLS.run, icon: Globe, label: "Run an Apify Actor", summary: tool => apifyApprovalTarget(tool), Input: ApifyRunReview },
    { match: APIFY_APPROVAL_TOOLS.search, icon: Globe, label: "Apify catalog search", summary: tool => apifyApprovalTarget(tool), Input: ApifyCatalogReview },
    { match: APIFY_APPROVAL_TOOLS.inspect, icon: Globe, label: "Apify Actor inspection", summary: tool => apifyApprovalTarget(tool), Input: ApifyCatalogReview },
    { match: tool => apifyToolName(tool.name) ? 10 : 0, icon: Globe,
      label: tool => `Apify ${apifyToolName(tool.name)!.slice("brain_apify_".length)}`,
      summary: tool => { const envelope = apifyEnvelope(tool.output); return envelope && !envelope.ok && envelope.error ? refusalCopy(envelope.error).title : null; },
      Output: ApifyResult },
  ],
};
