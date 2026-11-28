/**
 * Pinned "Needs your approval" stack above the composer for the open chat only (#4967, #3595).
 *
 * Groups pending Network approvals by canonical `origin`, preserves stable DOM
 * nodes across in-place revision updates, arms newly-arrived or updated cards
 * for 500 ms with zero layout shift, shows `"Sending…"` until the host's
 * `tool_resolution` settles the card, collapses to a count bar when the mobile
 * soft keyboard is open, and keeps keyboard `a` on the narrowest choice (`once`).
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  ApprovalStack,
  NetworkApprovalCard,
  type NetworkApprovalScopeChoice,
  type NetworkApprovalState,
} from "@schlessera/brain-ui-kit";
import type { ClientMessage } from "@schlessera/brain-ui-sdk/protocol";
import { useBrainUiRoot } from "../../root-context.js";
import { activeChat, useChatStore, type PendingNetworkApproval } from "../../stores/chat-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { useFinePointer } from "../../hooks/use-fine-pointer.js";
import { singleKey } from "../../lib/single-key.js";
import { replyToNetworkApproval } from "../../lib/tool-approval.js";

/** Arming duration after initial delivery or an in-place revision update (#4966, #4967). */
const NETWORK_APPROVAL_ARMING_MS = 500;

/** Format elapsed wait time as `"Waiting M:SS"`. */
function formatWaitingTime(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `Waiting ${mins}:${secs < 10 ? "0" : ""}${secs}`;
}

interface OriginGroup {
  origin: string;
  originLabel: string;
  /** Oldest pending item for this origin (target for `once` replies and representative offer). */
  oldest: PendingNetworkApproval;
  items: PendingNetworkApproval[];
  managedReference: boolean;
  scopes: readonly NetworkApprovalScopeChoice[];
  earliestCreatedAt: number;
  latestUpdatedAt: number;
  maxRevisionCount: number;
  anySending: boolean;
}

function groupByOrigin(items: readonly PendingNetworkApproval[]): OriginGroup[] {
  const map = new Map<string, PendingNetworkApproval[]>();
  for (const item of items) {
    if (item.readOnly) continue;
    const bucket = map.get(item.origin);
    if (bucket) bucket.push(item);
    else map.set(item.origin, [item]);
  }
  const groups: OriginGroup[] = [];
  for (const [origin, bucket] of map) {
    const oldest = bucket[0]!;
    const managedReference = oldest.network?.managedReference === true;
    const scopes: readonly NetworkApprovalScopeChoice[] = managedReference
      ? ["once"]
      : oldest.network?.scopes?.length
        ? oldest.network.scopes
        : [];
    groups.push({
      origin,
      originLabel: oldest.originLabel,
      oldest,
      items: bucket,
      managedReference,
      scopes,
      earliestCreatedAt: Math.min(...bucket.map((i) => i.createdAt)),
      latestUpdatedAt: Math.max(...bucket.map((i) => i.updatedAt)),
      maxRevisionCount: Math.max(...bucket.map((i) => i.revisionCount)),
      anySending: bucket.some((i) => i.sending === true),
    });
  }
  return groups;
}

/** True when a narrow mobile viewport has a soft keyboard open covering >22% of the screen. */
function useMobileKeyboardOpen(): boolean {
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const vv = window.visualViewport;
    if (!vv) return;
    const check = () => {
      const narrow = window.innerWidth < 768;
      const shrunk = window.innerHeight > 0 && vv.height < window.innerHeight * 0.78;
      setKeyboardOpen(narrow && shrunk);
    };
    check();
    vv.addEventListener("resize", check);
    window.addEventListener("resize", check);
    return () => {
      vv.removeEventListener("resize", check);
      window.removeEventListener("resize", check);
    };
  }, []);
  return keyboardOpen;
}

export function ChatApprovalStack({
  send,
  armingMs = NETWORK_APPROVAL_ARMING_MS,
}: {
  send: (message: ClientMessage) => boolean;
  /** Override for deterministic tests; defaults to 500 ms. */
  armingMs?: number;
}) {
  const root = useBrainUiRoot();
  const sessionId = useChatStore((s) => s.activeSessionId);
  const rawItems = useChatStore((s) => activeChat(s).networkApprovals);
  const keys = useUIStore((s) => s.singleKeyShortcuts);
  const printKeys = useFinePointer() && keys;
  const keyboardOpen = useMobileKeyboardOpen();
  const [manualCollapsed, setManualCollapsed] = useState<boolean | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [announcement, setAnnouncement] = useState("");
  const prevRevisions = useRef<Map<string, string | undefined>>(new Map());

  const groups = useMemo(() => groupByOrigin(rawItems ?? []), [rawItems]);
  const totalCount = useMemo(() => groups.reduce((sum, g) => sum + g.items.length, 0), [groups]);

  // Reset manual collapse override whenever the mobile keyboard state changes.
  useEffect(() => {
    setManualCollapsed(null);
  }, [keyboardOpen]);

  // Live waiting-time clock (1 s) while any card is waiting.
  useEffect(() => {
    if (totalCount === 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [totalCount]);

  // Arming expiration timer: wake as soon as the next armed card finishes arming.
  useEffect(() => {
    if (groups.length === 0 || armingMs <= 0) return;
    const currentNow = Date.now();
    let soonestRemaining = Infinity;
    for (const g of groups) {
      const rem = g.latestUpdatedAt + armingMs - currentNow;
      if (rem > 0 && rem < soonestRemaining) soonestRemaining = rem;
    }
    if (!Number.isFinite(soonestRemaining)) return;
    const timer = setTimeout(() => setNow(Date.now()), soonestRemaining + 5);
    return () => clearTimeout(timer);
  }, [groups, armingMs, now]);

  // Polite live-region announcement on in-place revision update without stealing focus.
  useEffect(() => {
    const next = new Map<string, string | undefined>();
    const updatedLabels: string[] = [];
    for (const g of groups) {
      const rev = g.oldest.revision;
      next.set(g.origin, rev);
      const prev = prevRevisions.current.get(g.origin);
      if (prev !== undefined && rev !== undefined && prev !== rev) {
        updatedLabels.push(g.originLabel);
      }
    }
    prevRevisions.current = next;
    if (updatedLabels.length > 0) {
      setAnnouncement(`Updated approval details for ${updatedLabels.join(", ")}`);
    }
  }, [groups]);

  if (groups.length === 0) return null;

  const collapsed = manualCollapsed !== null ? manualCollapsed : keyboardOpen;
  const nonManagedWithSession = groups.filter((g) => !g.managedReference && g.scopes.includes("session"));
  const showAllowAll = nonManagedWithSession.length >= 2;
  const allowAllLabel = showAllowAll ? `Allow all ${nonManagedWithSession.length} sites for this chat` : undefined;
  const anyArmed = groups.some((g) => armingMs > 0 && now - g.latestUpdatedAt < armingMs);

  function decideGroup(group: OriginGroup, decision: { approved: true; scope?: NetworkApprovalScopeChoice } | { approved: false }) {
    if (armingMs > 0 && Date.now() - group.latestUpdatedAt < armingMs) return;
    if (group.anySending) return;
    // Per #3595: `once` targets only the oldest pending connection; `origin`/`session` settle siblings server-side.
    if (decision.approved) {
      replyToNetworkApproval(
        root,
        sessionId,
        send,
        group.oldest,
        decision.scope !== undefined ? { approved: true, scope: decision.scope } : { approved: true }
      );
    } else {
      // Deny applies to all currently waiting requests for this grouped origin.
      for (const item of group.items) {
        replyToNetworkApproval(root, sessionId, send, item, { approved: false });
      }
    }
  }

  function handleAllowAll() {
    if (anyArmed) return;
    const target = nonManagedWithSession[0];
    if (!target || target.anySending) return;
    replyToNetworkApproval(root, sessionId, send, target.oldest, { approved: true, scope: "session" });
  }

  function onCardKeyDown(group: OriginGroup, event: KeyboardEvent<HTMLDivElement>) {
    if (!keys) return;
    const key = singleKey(event);
    if (key !== "a" && key !== "d") return;
    event.preventDefault();
    if (key === "a") {
      // Keyboard shortcut `a` ALWAYS picks the narrowest advertised choice: once < origin < session (#3595),
      // or legacy unscoped allow when the host did not advertise explicit scopes.
      if (group.scopes.length === 0) {
        decideGroup(group, { approved: true });
        return;
      }
      const narrowest: NetworkApprovalScopeChoice | undefined = group.scopes.includes("once")
        ? "once"
        : group.scopes.includes("origin")
          ? "origin"
          : group.scopes.includes("session")
            ? "session"
            : undefined;
      if (narrowest) decideGroup(group, { approved: true, scope: narrowest });
    } else {
      decideGroup(group, { approved: false });
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-2 md:px-6" data-chat-approval-stack="">
      <ApprovalStack
        count={totalCount}
        originCount={groups.length}
        collapsed={collapsed}
        onToggleCollapsed={() => setManualCollapsed(!collapsed)}
        allowAllLabel={allowAllLabel}
        allowAllDisabled={anyArmed || nonManagedWithSession.some((g) => g.anySending)}
        onAllowAll={showAllowAll ? handleAllowAll : undefined}
        announcement={announcement}
      >
        {groups.map((group) => {
          const armed = armingMs > 0 && now - group.latestUpdatedAt < armingMs;
          const cardState: NetworkApprovalState = group.anySending
            ? "sending"
            : armed
              ? "armed"
              : group.maxRevisionCount > 1
                ? "updated"
                : "pending";
          return (
            <div
              key={group.origin}
              data-network-approval-group={group.origin}
              data-tool-use-id={group.oldest.toolUseId}
              data-revision={group.oldest.revision ?? ""}
              tabIndex={0}
              role="group"
              aria-label={`Network approval: ${group.originLabel}`}
              onKeyDown={(e) => onCardKeyDown(group, e)}
              className="rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            >
              <NetworkApprovalCard
                originLabel={group.originLabel}
                target={group.origin}
                connectionCount={group.items.length}
                description={group.oldest.description}
                managedReference={group.managedReference}
                scopes={group.scopes}
                state={cardState}
                waitingLabel={formatWaitingTime(now - group.earliestCreatedAt)}
                updateNotice={
                  group.maxRevisionCount > 1
                    ? "Updated with new untrusted input in this chat."
                    : undefined
                }
                shortcuts={printKeys ? { allow: "a", deny: "d" } : undefined}
                hideSessionButton={showAllowAll}
                compact
                onSelectScope={(scope) => decideGroup(group, { approved: true, scope })}
                onAllow={() => decideGroup(group, { approved: true })}
                onDeny={() => decideGroup(group, { approved: false })}
              />
            </div>
          );
        })}
      </ApprovalStack>
    </div>
  );
}
