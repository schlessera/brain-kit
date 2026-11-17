import preview from "#.storybook/preview";
import { expect, fn, userEvent, within } from "storybook/test";

import { StatusIndicator } from "../../src/chrome/StatusIndicator.js";
import { stage, wide } from "../_stage.js";
import { DraftToolRow, MATRIX, SessionsHeader, SyncExample, deletionOperations } from "./_status-indicator.js";

/**
 * #3281: compact operation status with hover/focus summaries and persistent
 * tap/click/keyboard details. Consumer states, facts and actions are fixtures;
 * #3155 and #3231 own the real draft and deletion-recovery runtime.
 */
const meta = preview.meta({
  title: "Chrome/StatusIndicator",
  component: StatusIndicator,
  decorators: [stage],
  parameters: { stageWidth: 320 },
  args: {
    label: "Draft",
    title: "Draft status",
    summary: "Saving the draft to the brain now.",
    operations: [{ id: "draft-odysseus-raft", state: "active", stateLabel: "Saving the draft" }],
  },
});

/** One control per state: a distinct glyph and tone each, never colour or motion alone. */
export const Matrix = meta.story({
  render: () => <div style={{ display: "grid", gridTemplateColumns: "44px 1fr", alignItems: "center", gap: "4px 8px", width: "100%" }}>
    {MATRIX.map(m => <div key={m.state} style={{ display: "contents" }}>
      <StatusIndicator label="Raft list" title="Raft list" summary={m.stateLabel} operations={[{ id: `matrix-${m.state}`, state: m.state, stateLabel: m.stateLabel }]} />
      <span style={{ font: "400 .8125rem/1.4 'JetBrains Mono', ui-monospace, monospace", color: "var(--bk-color-ink)" }}>{m.state} · {m.stateLabel}</span>
    </div>)}
  </div>,
  play: async ({ canvasElement }) => {
    const controls = [...canvasElement.querySelectorAll<HTMLButtonElement>(".bk-status-indicator-btn")];
    await expect(controls).toHaveLength(8);
    for (const control of controls) {
      const box = control.getBoundingClientRect();
      await expect(box.width).toBe(44);
      await expect(box.height).toBe(44);
      await expect(control.hasAttribute("title")).toBe(false);
    }
  },
});
export const MatrixWide = Matrix.extend({ parameters: wide });

/** #3155: the icon sits after Attach and before the model label. */
export const DraftSaving = meta.story({
  render: () => <DraftToolRow draft="saving" />,
  play: async ({ canvasElement }) => {
    const control = within(canvasElement).getByRole("button", { name: "Draft: Saving the draft. Details." });
    await userEvent.click(control);
    const body = within(canvasElement.ownerDocument.body);
    await expect(body.getByRole("dialog", { name: "Draft status" })).toBeVisible();
    await expect(canvasElement.ownerDocument.activeElement?.textContent).toBe("Draft status");
    await userEvent.keyboard("{Escape}");
    await expect(control).toHaveFocus();
  },
});
export const DraftUploading = meta.story({ render: () => <DraftToolRow draft="uploading" /> });
/** R2: the static teal check stays while the acknowledged draft is unchanged. */
export const DraftSaved = meta.story({ render: () => <DraftToolRow draft="saved" /> });
export const DraftOffline = meta.story({ render: () => <DraftToolRow draft="offline" /> });
export const DraftUnknown = meta.story({ render: () => <DraftToolRow draft="unknown" /> });
export const DraftFileFailed = meta.story({ render: () => <DraftToolRow draft="file-failed" /> });
export const DraftRefused = meta.story({ render: () => <DraftToolRow draft="refused" /> });
/** An empty draft hides the indicator; its 44px slot stays so nothing shifts. */
export const DraftEmpty = meta.story({
  render: () => <DraftToolRow draft="empty" />,
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector(".bk-status-indicator-btn")).toBeNull();
    await expect(canvasElement.querySelector<HTMLElement>(".bk-status-indicator-slot")!.getBoundingClientRect().width).toBe(44);
  },
});
export const DraftWide = DraftSaved.extend({ parameters: wide });
export const DraftLargeText = meta.story({ render: () => <div style={{ fontSize: "200%", width: "100%" }}><DraftToolRow draft="unknown" /></div> });

const onAction = fn();
/** #3231: one Sessions-header summary for two unresolved removals; actions are separate. */
export const DeletionRecovery = meta.story({
  render: () => <SessionsHeader operations={deletionOperations()} onAction={onAction} />,
  play: async ({ canvasElement }) => {
    onAction.mockClear();
    const control = within(canvasElement).getByRole("button", { name: "Chat deletions: Attachment cleanup failed; 2 operations. Details." });
    await userEvent.click(control);
    await expect(onAction).not.toHaveBeenCalled();
    const dialog = within(canvasElement.ownerDocument.body).getByRole("dialog", { name: "Chat deletions" });
    const retry = within(dialog).getAllByRole("button", { name: "Retry removal" });
    await expect(retry).toHaveLength(2);
    await userEvent.click(retry[1]!);
    await expect(onAction).toHaveBeenCalledWith({ operation: "deletion-91c2", action: "retry" });
    await userEvent.keyboard("{Escape}");
  },
});
export const DeletionRecoveryWide = DeletionRecovery.extend({ parameters: wide });

/** Generic queued → active → success, or unknown when the reply is lost. */
export const Sync = meta.story({ render: () => <SyncExample /> });
export const SyncWide = Sync.extend({ parameters: wide });
