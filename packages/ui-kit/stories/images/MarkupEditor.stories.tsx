import preview from "#.storybook/preview";
import { useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { MarkupEditor, type MarkupEditorProps } from "../../src/images/MarkupEditor.js";
import { atWidth } from "../_viewports.js";
import { consumerViewport } from "../conversation/_consumer-parity.js";
import { RAFT_MARKS, RAFT_PATH, RAFT_QUARTER_MARKS, RAFT_QUARTER_SIZE, RAFT_SIZE, RAFT_SRC } from "./_raft.js";

type SceneProps = Omit<MarkupEditorProps, "open" | "onDismiss"> & { width: number; onDismiss: () => void };

/** The editor opens on load; reopening it starts a fresh session. */
function Scene({ width: _width, onDismiss, ...p }: SceneProps) {
  const [open, setOpen] = useState(true);
  const [session, setSession] = useState(0);
  return (
    <>
      <button type="button" onClick={() => { setSession(s => s + 1); setOpen(true); }}>Open markup editor</button>
      {open ? <MarkupEditor key={session} {...p} open onDismiss={() => { onDismiss(); setOpen(false); }} /> : null}
    </>
  );
}

const LONG =
  "Mark what should change on the raft before it sails from Ithaca: circle the sail that Penelope wants dyed red, draw an arrow from the raft to where it should be moored by the harbour wall, and add a note for anything the arrows cannot say.";

const meta = preview.meta({
  title: "Images/Markup editor",
  component: Scene,
  parameters: { layout: "fullscreen" },
  beforeEach: consumerViewport,
  args: {
    width: 320,
    src: RAFT_SRC,
    imagePath: RAFT_PATH,
    size: RAFT_SIZE,
    instruction: "mark what should move and where",
    onSubmit: fn(),
    onDismiss: fn(),
  },
  render: args => <Scene {...args} />,
});

/** `atWidth` plus story args: its own `args.width` must survive the merge. */
const at = (width: 320 | 390 | 1280, args: Partial<Omit<SceneProps, "onSubmit" | "onDismiss" | "width">> = {}) => {
  const base = atWidth(width);
  return { ...base, args: { ...base.args, ...args } };
};

/**
 * Encoding is real work, and a hosted runner took over Testing Library's
 * one-second default on the 3024 × 4032 raft (#4098). The encoding stories use
 * the quarter-size scene and wait up to 4 s, inside Vitest's 5 s test limit.
 */
const ENCODE = { timeout: 4_000 };

const dialog = () => within(document.body).findByRole("dialog", { name: "Mark up the image" });

export const IdlePhone = meta.story({
  ...atWidth(320),
  play: async ({ args }) => {
    const editor = await dialog();
    const send = within(editor).getByRole("button", { name: "Send markup" });
    await expect(send.getAttribute("aria-disabled")).toBe("true");
    await expect(within(editor).getByText("Draw at least one mark.")).toBeTruthy();
    await expect(within(editor).getByRole("button", { name: "Pen" }).getAttribute("aria-pressed")).toBe("true");
    for (const control of within(editor).getAllByRole("button").filter(b => b.closest("[data-bk-editor-toolbar]"))) {
      const rect = control.getBoundingClientRect();
      await expect(rect.width, `${control.getAttribute("aria-label") ?? control.textContent} width`).toBeGreaterThanOrEqual(44);
      await expect(rect.height, `${control.getAttribute("aria-label") ?? control.textContent} height`).toBeGreaterThanOrEqual(44);
    }
    // Every toolbar row fits the phone without a horizontal scroll.
    const toolbar = editor.querySelector<HTMLElement>("[data-markup-toolbar]")!;
    await expect(toolbar.scrollWidth).toBeLessThanOrEqual(toolbar.clientWidth);
    // An empty layer is never sent, and dismissing it closes at once.
    await userEvent.click(within(editor).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(args.onDismiss).toHaveBeenCalledTimes(1));
    await expect(args.onSubmit).not.toHaveBeenCalled();
  },
});

export const IdleDesktop = meta.story({ ...atWidth(1280) });

export const WithMarksPhone = meta.story({
  ...at(320, { initialMarks: RAFT_MARKS }),
  play: async () => {
    const editor = await dialog();
    await expect(within(editor).getByRole("img", { name: "6 marks: 2 arrows, 1 ellipse, 1 stroke, 2 notes" })).toBeTruthy();
    await expect(within(editor).getByRole("button", { name: "Send markup" }).getAttribute("aria-disabled")).toBeNull();
  },
});

export const WithMarksDesktop = meta.story({ ...at(1280, { initialMarks: RAFT_MARKS }) });

export const ZoomedFourTimes = meta.story({
  ...at(1280, { initialMarks: RAFT_MARKS, initialView: { zoom: 4, center: { x: 1700, y: 3100 } } }),
  play: async () => {
    const editor = await dialog();
    await waitFor(() => expect(within(editor).getByText("400%")).toBeTruthy());
    await userEvent.click(within(editor).getByRole("button", { name: "Fit" }));
    await waitFor(() => expect(within(editor).getByText("100%")).toBeTruthy());
  },
});

export const LongInstruction = meta.story({
  ...at(320, { instruction: LONG }),
  play: async () => {
    const editor = await dialog();
    const line = editor.querySelector<HTMLElement>("[data-bk-editor-instruction]")!;
    await expect(line.getAttribute("aria-expanded")).toBe("false");
    const collapsed = line.getBoundingClientRect().height;
    await userEvent.click(line);
    await expect(line.getAttribute("aria-expanded")).toBe("true");
    await expect(line.getBoundingClientRect().height).toBeGreaterThan(collapsed);
  },
});

export const NoInstructionShowsPath = meta.story({ ...at(320, { instruction: undefined }) });

export const DiscardConfirmation = meta.story({
  ...at(320, { initialMarks: RAFT_MARKS.slice(0, 4) }),
  play: async ({ args }) => {
    const editor = await dialog();
    await userEvent.click(within(editor).getByRole("button", { name: "Close" }));
    const ask = await within(document.body).findByRole("alertdialog", { name: "Discard 4 marks?" });
    // Focus opens on the safe choice.
    await expect(document.activeElement?.textContent).toBe("Keep drawing");
    await userEvent.click(within(ask).getByRole("button", { name: "Keep drawing" }));
    await waitFor(() => expect(document.querySelector("[data-markup-confirm]")).toBeNull());
    await expect(args.onDismiss).not.toHaveBeenCalled();
    await userEvent.click(within(editor).getByRole("button", { name: "Close" }));
    await userEvent.click(within(await within(document.body).findByRole("alertdialog")).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(args.onDismiss).toHaveBeenCalledTimes(1));
    await expect(args.onSubmit).not.toHaveBeenCalled();
  },
});

export const OverTheCap = meta.story({
  ...at(320, { initialMarks: RAFT_QUARTER_MARKS, size: RAFT_QUARTER_SIZE, maxBytes: 1024 }),
  play: async ({ args }) => {
    const editor = await dialog();
    await userEvent.click(within(editor).getByRole("button", { name: "Send markup" }));
    const alert = await within(editor).findByRole("alert", {}, ENCODE);
    await expect(alert.textContent).toMatch(/^This markup is \d+ KB; the limit is 1 KB\. Remove some freehand marks\.$/);
    await expect(args.onSubmit).not.toHaveBeenCalled();
    // The editor stays open with the drawing intact.
    await expect(within(editor).getByRole("img", { name: /^6 marks/ })).toBeTruthy();
  },
});

export const Submitted = meta.story({
  ...at(390, { initialMarks: RAFT_QUARTER_MARKS, size: RAFT_QUARTER_SIZE }),
  play: async ({ args }) => {
    const editor = await dialog();
    await userEvent.click(within(editor).getByRole("button", { name: "Send markup" }));
    await waitFor(() => expect(args.onSubmit).toHaveBeenCalledTimes(1), ENCODE);
    const layer = (args.onSubmit as ReturnType<typeof fn>).mock.calls[0][0];
    await expect([layer.width, layer.height]).toEqual([756, 1008]);
    await expect(layer.counts).toEqual({ pen: 1, arrow: 2, ellipse: 1, text: 2 });
    await expect(layer.notes).toEqual(["make the sail red", "move the raft here"]);
    await expect(layer.bytes).toBe(layer.png.size);
  },
});
