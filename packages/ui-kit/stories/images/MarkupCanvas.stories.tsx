import preview from "#.storybook/preview";
import { useState } from "react";
import { fn } from "storybook/test";

import { MarkupCanvas, type MarkupCanvasProps } from "../../src/images/MarkupCanvas.js";
import { MarkupNoteField } from "../../src/images/MarkupNoteField.js";
import type { Mark } from "../../src/images/markup.js";
import { RAFT_MARKS, RAFT_SIZE, RAFT_SRC } from "./_raft.js";

/* ── Canvas ───────────────────────────────────────────────────────────── */

function CanvasScene(p: Partial<MarkupCanvasProps> & { initial?: Mark[]; noteText?: string; editing?: boolean }) {
  const [marks, setMarks] = useState<Mark[]>(p.initial ?? []);
  const field = p.noteText !== undefined ? {
    at: p.editing ? { x: 1700, y: 3500 } : { x: 600, y: 1400 },
    editing: p.editing ? "s6" : undefined,
    node: <MarkupNoteField value={p.noteText} onChange={fn()} onPlace={fn()} onCancel={fn()} onDelete={p.editing ? fn() : undefined} autoFocus={false} />,
  } : undefined;
  return (
    <div data-theme="dark" style={{ background: "var(--bk-color-canvas)", width: "100%", height: 560 }}>
      <MarkupCanvas
        src={RAFT_SRC} size={RAFT_SIZE} marks={marks} tool={p.tool ?? "pen"} color="red" width="medium"
        onCommit={m => setMarks(list => [...list, m])} onNoteRequest={fn()} noteField={field} initialView={p.initialView}
      />
    </div>
  );
}

const canvas = preview.meta({ title: "Images/Markup canvas", component: CanvasScene, args: {} });
export const CanvasEmpty = canvas.story({});
export const CanvasEachMark = canvas.story({ args: { initial: RAFT_MARKS } });
export const CanvasTextPlacing = canvas.story({ args: { initial: RAFT_MARKS.slice(0, 4), tool: "text", noteText: "move the raft here" } });
export const CanvasTextEditing = canvas.story({ args: { initial: RAFT_MARKS, tool: "text", noteText: "move the raft here", editing: true } });
export const CanvasZoomed = canvas.story({ args: { initial: RAFT_MARKS, initialView: { zoom: 4, center: { x: 1700, y: 3100 } } } });
