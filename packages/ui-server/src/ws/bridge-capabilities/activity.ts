import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { SHARE_STAGING_DIR } from "@schlessera/brain-ui-sdk/protocol";
import type { ActivityQuery, BackendActivityEvent, BackendBridge } from "@schlessera/brain-ui-sdk/server";
import { ProviderRecordsRefusedError } from "../../brain/provider-mask-refusal.js";
import { withTurnScope } from "../frames.js";
import type { BridgeContext, BridgeSlice, MakeBridgeOptions } from "./context.js";
import type { TurnTranscript } from "./emission.js";

type InboxSlice = ReturnType<NonNullable<NonNullable<BridgeContext["host"]["inboxTools"]>["forTurn"]>>;

/**
 * The turn's inbox tools. Opened before the turn's share starts, so it is
 * called on its own ahead of the bridge's other capabilities.
 */
export function openInbox(ctx: BridgeContext, protectedPaths: readonly string[] | undefined): InboxSlice | undefined {
  const { host, turn, turnId, principalId, signal, work, isAuthorized } = ctx;
  return host.inboxTools?.forTurn({ principalId, turnId, isCurrent: () => !signal.aborted && isAuthorized(), sessionId: () => turn.sessionId ?? undefined,
    origin: "interactive", membership: work?.posture === "voice" ? "voice" : "interactive", ...(protectedPaths ? { protectedPaths } : {}) });
}

/** Activity events, usage and promotions the backend reports, and the activity query tool. */
export function createActivity(ctx: BridgeContext, transcript: TurnTranscript,
  options: Pick<MakeBridgeOptions, "onUsage">): BridgeSlice<"activity"> & Partial<BridgeSlice<"queryActivity">> {
  const { host, turn, turnId, signal, work, recorder, mainModel, principalIsAuthorized, queryActivity } = ctx;
  const { coordinator, catalog } = host;
  const { onUsage } = options;
  /** Promoted files whose links the live view has been sent. */
  const linked = new Set<string>();
  /**
   * A linked turn-temp file the backend promoted, or could not (#1655): kept
   * as a governance event with the session history, never shown in the chat.
   */
  const recordPromotion = (event: Extract<BackendActivityEvent, { kind: "promotion" | "promotion_refused" }>): void => {
    // The aliases only say which spellings the live view rewrites (below).
    const { kind, ...payload } = event.kind === "promotion" ? (({ aliases: _aliases, ...rest }) => rest)(event) : event;
    catalog.recordGovernanceEvent?.({
      kind, payload, turnId, sessionId: turn.sessionId, actor: work?.posture === "voice" ? "voice" : "interactive",
      model: mainModel?.current() ?? null, profile: null,
      // One record per linked file and turn, however often a backend reports it.
      dedupeKey: `${turnId}:${createHash("sha256").update(event.source).digest("hex")}`,
    });
    // A reader watching the turn holds the answer as it streamed: it gets the
    // links the stored answer now has, so it shows what a reload would (#1698).
    const sessionId = turn.sessionId;
    if (event.kind === "promotion") {
      for (const link of [event, ...(event.aliases ?? [])]) transcript.promotedLinks.set(link.originalLink, link.rewrittenLink);
      transcript.persistPromotedBlocks();
    }
    if (event.kind !== "promotion" || !sessionId || linked.has(event.source)) return;
    linked.add(event.source);
    const links = [event, ...(event.aliases ?? [])].map(link => ({ from: link.originalLink, to: link.rewrittenLink }));
    host.sendToClients(withTurnScope({ type: "message_links", sessionId, links }, turn, turnId));
  };
  return {
    // Always present: a promotion also reaches the live view (#1698).
    activity: (event: Parameters<NonNullable<BackendBridge["activity"]>>[0]) => {
      if (event.kind === "permission_denied" && work?.posture === "voice" && !signal.aborted && principalIsAuthorized() && turn.turnId === turnId && coordinator.resolvedApprovals.get(event.toolUseId)?.turnId !== turnId) {
        coordinator.recordApprovalOutcome(event.toolUseId, { outcome: "denied", turnId, sessionId: turn.sessionId, reason: "voice_posture" });
      }
      if (event.kind === "main_model") {
        if (turn.turnId === turnId && turn.backendStarted && !signal.aborted && !turn.cancelled && event.model
          && (!turn.sessionId || turn.sessionId === event.sessionId)) mainModel?.bind(event.model);
        return;
      }
      if (event.kind === "claude_title_usage" && turn.turnId === turnId) {
        transcript.claudeUsage = { ...transcript.claudeUsage, title: { receipts: event.receipts, coverage: event.coverage } };
      }
      else if (event.kind === "claude_session_usage" && turn.turnId === turnId) {
        transcript.claudeUsage = { ...transcript.claudeUsage, completed: event.completed,
          ...(event.cumulative ? { cumulative: event.cumulative, cumulativeCompleted: event.completed,
            reportedCostUsd: event.reportedCostUsd } : {}) };
      }
      else if (event.kind === "promotion" || event.kind === "promotion_refused") recordPromotion(event);
      else if (event.kind === "turn_temp_purge") {
        // Each purge of turn temp (#1703), kept with the session history and never shown.
        const { kind, ...payload } = event;
        catalog.recordGovernanceEvent?.({ kind, payload, turnId, sessionId: turn.sessionId,
          actor: work?.posture === "voice" ? "voice" : "interactive", model: mainModel?.current() ?? null, profile: null });
      }
      else if (event.kind === "budget_backstop" && turn.turnId === turnId) onUsage?.({},true);
      else {
        if (event.kind === "usage" && turn.turnId === turnId) {
          const priced=onUsage?.(event.usage);
          recorder?.observeActivity({...event,usage:priced ?? event.usage});
          if (!onUsage) host.sendToClients(withTurnScope({type:"usage",turnId,usage:event.usage,observedAt:Date.now()},turn,turnId));
        } else recorder?.observeActivity(event.kind === "policy_confirm" && signal.aborted
          ? { ...event, payload: { ...event.payload, decision: turn.cancelled ? "cancelled" : "timed_out" } }
          : event);
      }
    },
    ...(queryActivity
      ? { queryActivity: async (query: ActivityQuery) => queryActivity(query) }
      : {}),
  };
}

/**
 * Masks the server's own records on a bridge whose turn has masked folders.
 * Intake stages the submitted item under the share staging directory and
 * reconciles what is already staged there, so a mask at, above or inside
 * that directory, or one it resolves into, refuses the whole addition.
 * The activity record and inbox items are the server's own text, kept from
 * earlier runs, and may quote a masked document. They are refused whole,
 * before any record is read; the tools stay registered (#2698, option A).
 */
export function guardMaskedRecords(ctx: BridgeContext, bridge: BackendBridge): void {
  const { host, maskGuard, toolName } = ctx;
  const inboxAdd = bridge.inboxAdd;
  if (maskGuard && inboxAdd) bridge.inboxAdd = async input => {
    const tool = toolName("inbox_add");
    maskGuard.assert(tool, [`${SHARE_STAGING_DIR}/new`, ...maskGuard.folders.filter(folder => folder.startsWith(`${SHARE_STAGING_DIR}/`))]);
    if (host.brainPath) {
      let resolved: string | undefined;
      try { resolved = relative(realpathSync(host.brainPath), realpathSync(join(host.brainPath, SHARE_STAGING_DIR))); } catch { /* not staged yet */ }
      if (resolved !== undefined) maskGuard.assert(tool, [`${resolved}/new`]);
    }
    return inboxAdd(input);
  };
  if (maskGuard) for (const [name, tool, what] of [["queryActivity", "query_activity", "The activity record"],
    ["inboxList", "inbox_list", "The inbox"], ["inboxGet", "inbox_get", "The inbox"]] as const) {
    if (bridge[name]) bridge[name] = async () => { throw new ProviderRecordsRefusedError(toolName(tool), maskGuard.folders, what); };
  }
}
