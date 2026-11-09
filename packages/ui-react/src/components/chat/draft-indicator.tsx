import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, StatusIndicator, type StatusIndicatorFact } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot, useRootStore } from "../../root-context.js";
import { useLocalWorkStatus } from "../../hooks/use-local-work.js";
import { draftIndicatorView, type DraftIndicatorView } from "../../lib/draft-indicator.js";
import type { QueuedFile } from "../../lib/attachment-queue.js";
import { CompareDrafts, openOtherVersion } from "./draft-save-line.js";

type CheckResult = "saved" | "not_saved" | "changed" | "unreachable" | "none";

/** What the last Check again found, in the reader's words. Never a claim the host has not made. */
const CHECKED: Record<Exclude<CheckResult, "saved">, string> = {
  not_saved: "The brain doesn't have this change yet.",
  changed: "The brain holds a different version. It is compared when the drafts refresh.",
  unreachable: "Couldn't reach the brain.",
  none: "Nothing to check.",
};

/**
 * The composer's draft indicator (#3155, rev 4 §1): the kit's compact
 * `StatusIndicator` beside Attach, in place of D52's persistent save line.
 * Hover, focus or tap shows the summary; activating it opens details with
 * the facts and, where one applies, a single action. Opening details reads
 * and writes nothing; only Check again, a read, and the reader's own
 * choices (Compare, Open other version, Open Storage) do anything.
 *
 * Its live region is off: like the line it replaces, saving is silent, and
 * upload outcomes have the composer's own announcement.
 */
export function DraftIndicator({ draftId, queued, online }: { draftId: string; queued: readonly QueuedFile[]; online: boolean }) {
  const root = useBrainUiRoot();
  const draft = useRootStore("drafts", (s) => s.drafts[draftId]);
  const supported = useRootStore("drafts", (s) => s.supported);
  const limits = useRootStore("drafts", (s) => s.limits);
  const localFailed = useLocalWorkStatus((s) => s.failed);
  const wrapper = useRef<HTMLSpanElement>(null);
  const compareRef = useRef<HTMLSpanElement>(null);
  // Remounting the indicator closes its details: an action that moves the reader elsewhere does.
  const [epoch, setEpoch] = useState(0);
  const [comparing, setComparing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<{ edit: number; result: Exclude<CheckResult, "saved"> } | null>(null);
  useEffect(() => { if (!draft?.conflict) setComparing(false); }, [draft?.conflict]);
  useEffect(() => { setChecked(null); setChecking(false); }, [draftId]);

  const view: DraftIndicatorView = draftIndicatorView({ draft, store: { supported, limits }, queued, online, localFailed });
  const trigger = () => wrapper.current?.querySelector<HTMLElement>(".bk-status-indicator-btn") ?? null;

  const check = async () => {
    if (checking) return;
    setChecking(true);
    const edit = draft?.edit ?? 0;
    try {
      const result = await root.connection.drafts.checkSave(draftId);
      setChecked(result === "saved" ? null : { edit, result });
    } finally {
      setChecking(false);
    }
  };

  // Each action is a kit Button, found by its wrapper's `data-draft-action`.
  const act = (name: string, label: string, onClick: () => void, extra: { disabled?: boolean } = {}) =>
    <span data-draft-action={name} ref={name === "compare" ? compareRef : undefined} className="contents">
      <Button label={label} tone="ghost" size="md" block={false} reach {...extra} onClick={onClick} />
    </span>;
  let actions: ReactNode;
  if (view.key !== "none") {
    if (view.action === "check") actions = act("check", checking ? "Checking…" : "Check again", () => { void check(); }, { disabled: checking });
    else if (view.action === "storage") actions = act("storage", "Open Storage", () => { setEpoch((n) => n + 1); root.stores.ui.getState().openSettings("storage"); });
    else if (view.action === "compare") actions = act("compare", "Compare drafts", () => setComparing(true));
    else if (view.action === "other_version") actions = act("other_version", "Open other version", () => { setEpoch((n) => n + 1); openOtherVersion(root, draft!.deviceConflict!.otherId); });
  }
  const facts: StatusIndicatorFact[] = view.key === "none" ? [] : [...view.facts];
  if (view.key === "unconfirmed" && checked && checked.edit === draft?.edit) facts.push({ key: "Checked", value: CHECKED[checked.result] });

  return (
    <span ref={wrapper} className="contents" data-draft-indicator="" data-draft-save={view.key} data-draft-id={draftId}
      data-draft-summary={view.key === "none" ? undefined : view.summary} data-device-conflict={view.key === "device_conflict" ? "" : undefined}>
      <StatusIndicator key={epoch} label="Draft" title="Draft status" announce={false} returnFocus={trigger}
        summary={view.key === "none" ? "" : view.summary}
        operations={view.key === "none" ? [] : [{ id: draftId, state: view.state, stateLabel: view.stateLabel, explanation: view.explanation, facts, actions }]} />
      {comparing && draft?.conflict ? <CompareDrafts draftId={draftId}
        onClose={() => { setComparing(false); if (!root.stores.drafts.getState().drafts[draftId]?.conflict) setEpoch((n) => n + 1); }}
        returnFocus={() => compareRef.current?.isConnected ? compareRef.current.querySelector<HTMLElement>("[data-bk-button]") : trigger()} /> : null}
    </span>
  );
}
