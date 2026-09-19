import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { backlinks, viewerTree, viewerTreeLabel } from "../../fixtures/files.js";
import { frontmatterChips, viewerDocument } from "../../fixtures/notes.js";
import { Disclosure } from "../../src/blocks/Disclosure.js";
import { StepList } from "../../src/blocks/StepList.js";
import { MessageBubble } from "../../src/chrome/MessageBubble.js";
import { ScreenBody } from "../../src/chrome/ScreenBody.js";
import { ScreenHeader } from "../../src/chrome/ScreenHeader.js";
import { RelatedFiles } from "../../src/conversation/RelatedFiles.js";
import { Button } from "../../src/primitives/Button.js";
import { Callout } from "../../src/primitives/Callout.js";
import { Chip } from "../../src/primitives/Chip.js";
import { Label } from "../../src/primitives/Label.js";
import { PathRef } from "../../src/primitives/PathRef.js";
import { FileRow } from "../../src/rows/FileRow.js";
import { phone } from "../_phone.js";
import { overflowing, unreachable } from "../_stage.js";

/**
 * FILE VIEWER, PHONE. The sixth assembled screen — the design's sixth-pass
 * ruling (§12) names it second after the acceptance set: *"frontmatter,
 * backlinks and the tree at 390px, which is where the D3 rail has to prove it
 * collapses honestly."*
 *
 * The source screen is `1f`: *"Viewer: frontmatter as chips, wiki-links live,
 * backlinks at the bottom, 'ask about this file' as the primary action."* A
 * nav header carrying the path, the document title, a row of key:value chips
 * and a tag chip, prose with two live links, an editorial aside, "Open
 * questions", "Linked from · 4", and a pinned bar with the primary button and
 * a bookmark. The document is the Odyssey's strait decision
 * (`viewerDocument` in `notes.ts`), whose backlinks `files.ts` already
 * carried.
 *
 * ## THE GAP THIS SCREEN EXISTS TO FIND
 *
 * **The prose body has no component.** `catalog.md` §4 says so and this is
 * where it shows: the source's document title (`22px` serif), section heading
 * (`22px` serif, amber), paragraphs (`13px/1.75`, the loosest line height in
 * the system) and emphasis runs are raw markup, and the kit has nothing that
 * renders a paragraph. Rather than add one during a port — which is the thing
 * this file may not do — the body is assembled from the nearest shapes the
 * kit owns, and each substitution is named here so the finding stays a
 * finding:
 *
 *   - **Paragraphs are `MessageBubble role="brain"`.** The design's own
 *     sentence for that role is *"the answer is the page"*: no bubble, full
 *     width, `13.5px/1.7` body ink — which is within half a pixel of the
 *     prose spec. Each paragraph carries its one wiki-link as a `PathRef
 *     variant="link"` child, so the link is a component and not a styled
 *     span. The link is NOT operable: `PathRef` has no handler, and the
 *     source's "wiki-links live" is a claim the kit cannot yet make.
 *   - **The section heading is a `Label`,** the kit's mono section label,
 *     where the source draws a serif H2. That is a type-contract change, not
 *     a port, and it is the visible cost of the gap.
 *   - **The aside is `Callout variant="accent"`,** which IS the design's own
 *     component for *"an editorial aside inside prose"* — the one piece of
 *     the body that ports without loss.
 *   - **Open questions are a `StepList variant="checklist"`** with every step
 *     `todo`: two questions nobody has answered are two things to tick off.
 *
 * A document renderer that owns those four type values is the component the
 * kit is missing. Until it exists, this screen is the honest composition.
 *
 * ## Departures from the source, each with its reason
 *
 * **The title is in the header and the path is under it.** The source's nav
 * header carries only the mono path and puts the `24px` serif title at the
 * top of the body. `ScreenHeader variant="nav"` draws its title in serif and
 * its subtitle in mono, and a path in serif is wrong in a way a title at
 * `17px` is not — so the header takes the title and the path takes the
 * subtitle line, and the body opens with the tree and the chips.
 *
 * **One trailing icon, not two.** The source draws share and edit;
 * `ScreenHeader` has one `trailingIcon` slot. Share stays. Edit is a second
 * slot, which is a component change, and is recorded as a gap.
 *
 * **The tree is a `Disclosure` over the open folder, closed by default.** This
 * is the D3 rail at 390px. On the desktop the Files rail is a column beside
 * the document; on the phone there is no beside, so the rail collapses to the
 * one folder the document is in — the real `decisions/` with its real count,
 * and the three decisions the world has written down as `treeitem` rows in a
 * `tree`. Closed by default because the document is what was opened; the
 * folder is one tap away and its label says what it holds and how much.
 *
 * **The bookmark is a labelled quiet button.** The source draws an icon-only
 * bookmark; `Button` always renders a label, and an icon with no name is a
 * control a screen reader announces as nothing. "Save" is the label.
 *
 * **The action bar has no hairline.** The source's pinned bar draws a top
 * border; a screen may declare layout only, and the kit has no bar component
 * to carry the line. Recorded as the third gap.
 */
const doc = viewerDocument;
const note = doc.note;

const on = {
  tree: viewerTree.map(() => fn()),
  backlinks: backlinks.map(() => fn()),
  ask: fn(),
  save: fn(),
};

const meta = preview.meta({
  title: "Screens/File viewer",
  component: ScreenBody,
  decorators: [phone({ showHome: true })],
  parameters: { layout: "centered" },
});

/** The document as `1f` draws it, with the folder collapsed above it. */
export const FileViewer = meta.story({
  render: () => (
    <>
      <ScreenHeader variant="nav" title={note.title} subtitle={note.path} trailingIcon="share" />
      <ScreenBody padding="12px 18px 8px" gap={12} overflow="auto">
        <Disclosure label={viewerTreeLabel} icon="folder-open">
          <div role="tree" aria-label="decisions" style={{ display: "flex", flexDirection: "column" }}>
            {viewerTree.map((node, i) => (
              <FileRow key={node.label} {...node} onClick={on.tree[i]} />
            ))}
          </div>
        </Disclosure>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {frontmatterChips.map((c) => (
            <Chip key={c.k} variant="kv" tone={c.tone} label={`${c.k}: ${c.v}`} />
          ))}
          <Chip variant="mono" tone="purple" label={note.tags.join(" ")} />
        </div>

        <Label text={doc.heading} tone="amber" />
        {doc.paragraphs.map((para) => (
          <MessageBubble key={para.before} role="brain" text={para.before} actions={false}>
            {para.link ? <PathRef variant="link" text={para.link} icon="link" fontSize={11.5} /> : null}
            {para.after}
          </MessageBubble>
        ))}
        <Callout variant="accent" tone="amber" italic text={doc.aside} />

        <Label text="Open questions" />
        <StepList variant="checklist" steps={doc.questions} pulse={false} />

        <RelatedFiles
          label="Linked from"
          meta={String(backlinks.length)}
          items={backlinks.map((b, i) => ({ ...b, onClick: on.backlinks[i] }))}
        />
      </ScreenBody>
      <div style={{ display: "flex", gap: 8, padding: "10px 16px 8px", flex: "none" }}>
        <Button
          label={doc.askLabel}
          icon="brain"
          tone="primary"
          size="md"
          center
          onClick={on.ask}
          style={{ flex: "1 1 0", width: "auto" }}
        />
        <Button label={doc.saveLabel} icon="bookmark" tone="quiet" size="md" center block={false} onClick={on.save} />
      </div>
    </>
  ),
});

/** Nothing crosses the phone's edges. See `Screens/Weekly review` for why this
 * is measured rather than inspected. */
export const NothingEscapesTheFrame = FileViewer.extend({
  play: async ({ canvasElement }) => {
    const frame = canvasElement.firstElementChild as HTMLElement;
    await expect(overflowing(frame)).toEqual([]);
    await expect(unreachable(frame.querySelector(".bk-screen-body")!)).toEqual([]);
  },
});

/**
 * THE RAIL COLLAPSES HONESTLY — the ruling's phrase, made into a check.
 *
 * Closed, the rail is one line that says which folder and how much of it
 * ("decisions/ · 3 of 63"). Opened, it is a real `tree`: every row is a
 * `treeitem`, the folder is `aria-expanded`, the open document is
 * `aria-selected`, and the whole thing still fits inside the frame. A rail
 * that vanished at 390px, or one that opened into rows with no roles, would
 * both look right in a screenshot.
 */
export const TheRailCollapsesHonestly = FileViewer.extend({
  play: async ({ canvas, canvasElement, userEvent }) => {
    const toggle = await canvas.findByRole("button", { name: viewerTreeLabel });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(canvas.queryByRole("tree")).toBeNull();

    await userEvent.click(toggle);
    const tree = await canvas.findByRole("tree");
    const rows = await canvas.findAllByRole("treeitem");
    await expect(rows).toHaveLength(viewerTree.length);
    await expect(rows[0]).toHaveAttribute("aria-expanded", "true");
    await expect(rows.filter((r) => r.getAttribute("aria-selected") === "true")).toHaveLength(1);
    await expect(tree.textContent).toContain(note.path.slice(note.path.lastIndexOf("/") + 1));

    const frame = canvasElement.firstElementChild as HTMLElement;
    await expect(overflowing(frame)).toEqual([]);
  },
});

/**
 * FRONTMATTER, LINKS AND BACKLINKS ARE ALL PATHS INTO THE SAME WORLD.
 *
 * Every wiki-link in the prose is a document that exists in `notes.ts`, every
 * backlink names the reason it points here, and the frontmatter chips carry
 * key and value as one string each. The check is that what the reader can
 * see is what the fixtures say — a chip that read `type: talk` over a
 * document about a strait would render fine and be wrong.
 */
export const EveryPathResolves = FileViewer.extend({
  play: async ({ canvas }) => {
    for (const c of frontmatterChips) await expect(await canvas.findByText(`${c.k}: ${c.v}`)).toBeTruthy();
    for (const para of doc.paragraphs) {
      // A prose link may also be a backlink below, so it may appear twice.
      if (para.link) await expect(await canvas.findAllByText(para.link)).not.toHaveLength(0);
    }
    for (const b of backlinks) {
      // A backlink's path is also a live link in the prose, so it may appear twice.
      await expect(await canvas.findAllByText(b.path)).not.toHaveLength(0);
      await expect(await canvas.findAllByText(b.reason!)).not.toHaveLength(0);
    }
    await expect(await canvas.findByText(String(backlinks.length))).toBeTruthy();
    await expect(await canvas.findByRole("button", { name: new RegExp(doc.askLabel) })).toBeTruthy();
  },
});

/**
 * THE WHOLE SCREEN BY KEYBOARD. The body scrolls, so it is the first stop; the
 * rail's toggle is the second, and with the rail closed nothing inside it is
 * reachable — which is right, because nothing inside it is rendered. The
 * paragraphs' links are NOT stops: `PathRef` has no handler, and the gap
 * above is the reason.
 */
export const TheWholeScreenByKeyboard = FileViewer.extend({
  play: async ({ canvasElement, userEvent }) => {
    const stops: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      await userEvent.tab();
      const active = document.activeElement as HTMLElement | null;
      if (!active || !canvasElement.contains(active)) break;
      const shape = `${active.getAttribute("role") ?? active.tagName.toLowerCase()}:${(active.textContent ?? "").trim().split("\n")[0]!.slice(0, 20)}`;
      if (stops.includes(shape)) break;
      stops.push(shape);
    }
    await expect(stops).toEqual([
      // The scrolling body.
      "div:decisions/ · 3 of 63",
      // The collapsed rail.
      "button:decisions/ · 3 of 63",
      // The four backlinks, each a row that opens a document.
      "button:knowledge/scylla.md0",
      "button:knowledge/charybdis.",
      "button:crew/_index.md0.77ca",
      "button:journal/day-1043.md0",
      // The pinned bar: the primary action and the bookmark.
      "button:Ask about this file",
      "button:Save",
    ]);
  },
});
