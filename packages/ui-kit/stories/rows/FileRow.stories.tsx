import type { Decorator } from "@storybook/react-vite";
import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { fileTree } from "../../fixtures/files.js";
import { FileRow } from "../../src/rows/FileRow.js";
import type { FileKind, Tone } from "../../src/types.js";
import { stage, wide } from "../_stage.js";

const KINDS: FileKind[] = ["folder", "open", "file", "image"];
const TONES: Tone[] = ["neutral", "gold", "red", "teal"];

/**
 * A `treeitem` is only valid inside a `tree`, and this component is one row —
 * the container is always the caller's. Stories that render an operable row
 * therefore render inside one, which is not story furniture but the smallest
 * correct use of the component: a lone FileRow with a handler is an ARIA error
 * no matter how it is styled, and axe said so the moment the gate went to
 * `error`.
 *
 * The condition is the point, not a workaround for the two stories it excludes.
 * The wrapper exists BECAUSE OF THE ROLE, and there is no role when the row has
 * no handler (`Static`) or when `view` has swapped the whole row for a
 * `Placeholder` (`Loading`/`Empty`/`ErrorState`/`Retried`). Wrapping those in a
 * `tree` would be an empty tree — or, in `Retried`'s case, a tree whose only
 * child is a button — and axe fails both, correctly.
 */
const tree: Decorator = (Story, context) => {
  const { view, onClick } = context.args as { view?: string; onClick?: () => void };
  if (!onClick || (view !== undefined && view !== "ready")) return <Story />;
  return (
    <div role="tree" aria-label="Corpus" style={{ width: "100%" }}>
      <Story />
    </div>
  );
};

const meta = preview.meta({
  title: "Rows/FileRow",
  component: FileRow,
  decorators: [stage, tree],
  args: { view: "ready", label: "omens", kind: "open", depth: 0, badge: "3", meta: "86", onClick: fn() },
  argTypes: {
    view: { control: "select", options: ["ready", "loading", "empty", "error"] },
    kind: { control: "select", options: KINDS },
    metaTone: { control: "select", options: TONES },
    flag: { control: "select", options: TONES },
    depth: { control: { type: "number", min: 0, max: 4, step: 1 } },
  },
});

export const Default = meta.story({});

export const Closed = Default.extend({ args: { kind: "folder", label: "voyage", badge: undefined, meta: "612" } });

export const File = Default.extend({
  args: { kind: "file", label: "day-3651-eagle.md", depth: 1, badge: undefined, meta: "1d" },
});

export const Image = File.extend({ args: { kind: "image", label: "ionian-approach.png", meta: "sketch" } });

export const Active = Default.extend({ args: { active: true } });

/** A staleness flag and a gold meta, which is the tree's way of saying a folder
 * needs attention without pushing a notification about it. */
export const Flagged = Default.extend({
  args: { kind: "folder", label: "oaths", badge: undefined, meta: "stale 38d", metaTone: "gold", flag: "gold" },
});

/**
 * The whole tree, in the `tree` container its `treeitem` rows require. This
 * component cannot render that container — it is one row — so a caller who
 * builds a tree supplies it, exactly as this story does.
 */
export const Tree = meta.story({
  parameters: wide,
  // The decorator already supplies the `tree`; a nested one would be a second
  // container for the same rows.
  render: (args) => (
    <>
      {fileTree.map((node) => (
        <FileRow {...args} key={`${node.depth}-${node.label}`} {...node} />
      ))}
    </>
  ),
});

/* ── The Placeholder delegation, all four states ───────────────────────── */

export const Loading = Default.extend({ args: { view: "loading" } });

/** The component's own copy, not `Placeholder`'s generic sentence. */
export const Empty = Default.extend({ args: { view: "empty" } });

export const ErrorState = Default.extend({ args: { view: "error", onStateAction: fn() } });

/** `stateMessage` / `stateDetail` override that copy per call site. */
export const EmptyOverridden = Default.extend({
  args: {
    view: "empty",
    stateMessage: "No omens filed since Aeaea",
    stateDetail: "The last entry is 40 days old.",
  },
});

/** The retry is inert unless the caller passes `onStateAction` — the gating
 * rule applied to the state affordance as well as to the row. */
export const Retried = ErrorState.extend({
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(await canvas.findByText("Retry"));
    await expect(args.onStateAction).toHaveBeenCalled();
  },
});

/**
 * EVERY operable row is a `treeitem`, folder and file alike, and `aria-expanded`
 * is what tells them apart.
 *
 * Until wave 1b a file was an `option`, which is what the DC source does. That
 * cannot be made valid from any call site: `treeitem` requires a `tree` parent,
 * `option` requires a `listbox`, and a file tree needs both roles in ONE
 * container. Axe failed it from both ends at once — `aria-required-parent` on
 * the file rows and `aria-required-children` on the tree holding them. The
 * design's own role table says `button` / `treeitem` and never mentions
 * `option`, so this also moves the port back towards the spec.
 * `.plan/design-feedback.md` records it.
 */
export const Roles = meta.story({
  render: (args) => (
    <>
      <FileRow {...args} kind="folder" label="voyage" badge={undefined} meta="612" />
      <FileRow {...args} kind="open" label="omens" />
      <FileRow {...args} kind="file" label="day-3651-eagle.md" depth={1} badge={undefined} meta="1d" />
    </>
  ),
  play: async ({ canvas }) => {
    const [closed, open, file] = await canvas.findAllByRole("treeitem");
    await expect(closed).toHaveAttribute("aria-expanded", "false");
    await expect(open).toHaveAttribute("aria-expanded", "true");
    // A file is a leaf: same role, no expanded state to report.
    await expect(file).not.toHaveAttribute("aria-expanded");
    // And the role a file used to carry is gone, container and all.
    await expect(canvas.queryByRole("option")).toBeNull();
    await expect(canvas.queryByRole("listbox")).toBeNull();
  },
});

export const Tapped = meta.story({
  play: async ({ canvas, userEvent, args }) => {
    const row = await canvas.findByRole("treeitem");
    await userEvent.click(row);
    await expect(args.onClick).toHaveBeenCalledTimes(1);
    row.focus();
    await userEvent.keyboard("{Enter}");
    await expect(args.onClick).toHaveBeenCalledTimes(2);
  },
});

/** THE CONTRACT. No handler, no role — and so no `aria-expanded` or
 * `aria-selected` either, since neither means anything without one. */
export const Static = meta.story({
  args: { onClick: undefined, active: true },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.queryByRole("treeitem")).toBeNull();
    await expect(canvasElement.querySelector(".bk-row")).toBeNull();
    await expect(canvasElement.querySelector("[tabindex]")).toBeNull();
    await expect(canvasElement.querySelector("[aria-expanded]")).toBeNull();
    await expect(canvasElement.querySelector("[aria-selected]")).toBeNull();
  },
});

/**
 * ← / → FOLD, AND THEY ARE PRINTED. The ARIA tree pattern requires them and
 * the kit's rule is that a bound key is printed where it applies — the D3
 * footer reads `← → fold`. An unadvertised key is one nobody uses; an
 * advertised key that does nothing is worse, so they ship together (sixth
 * drop, ruling 8). → on a closed folder opens it; ← on an open one closes it.
 */
export const Folded = meta.story({
  args: { kind: "folder", label: "voyage", badge: undefined, meta: "612", onFold: fn() },
  play: async ({ canvas, userEvent, args }) => {
    const row = await canvas.findByRole("treeitem");
    row.focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect(args.onFold).toHaveBeenCalledWith(true);
    // ← on a CLOSED folder is not in the design's table: it does not climb.
    await userEvent.keyboard("{ArrowLeft}");
    await expect(args.onFold).toHaveBeenCalledTimes(1);
  },
});

export const Unfolded = meta.story({
  args: { kind: "open", label: "omens", onFold: fn() },
  play: async ({ canvas, userEvent, args }) => {
    const row = await canvas.findByRole("treeitem");
    row.focus();
    await userEvent.keyboard("{ArrowLeft}");
    await expect(args.onFold).toHaveBeenCalledWith(false);
    // → on an OPEN folder does not descend into its children.
    await userEvent.keyboard("{ArrowRight}");
    await expect(args.onFold).toHaveBeenCalledTimes(1);
  },
});

/** A file has nothing to fold, and a row without `onFold` binds nothing —
 * the arrow keys fall through untouched. */
export const NothingToFold = meta.story({
  args: { kind: "file", label: "day-3651-eagle.md", depth: 1, badge: undefined, meta: "1d", onFold: fn() },
  play: async ({ canvas, userEvent, args }) => {
    const row = await canvas.findByRole("treeitem");
    row.focus();
    await userEvent.keyboard("{ArrowRight}{ArrowLeft}");
    await expect(args.onFold).not.toHaveBeenCalled();
  },
});

/** The name carries itself as a `title`: the row OPENS the record, so the
 * ellipsis is allowed, and a pointer user never has to click to read it. */
export const NameCarriesATitle = meta.story({
  args: { kind: "file", label: "the-swineherd-reports-an-eagle-over-the-hall-at-first-light.md", depth: 1, badge: undefined },
  play: async ({ canvasElement, args }) => {
    await expect(canvasElement.querySelector(`[title="${args.label}"]`)).not.toBeNull();
  },
});
