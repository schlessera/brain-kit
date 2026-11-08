import { useState, type CSSProperties } from "react";
import preview from "#.storybook/preview";
import { expect, fn, within } from "storybook/test";
import { HygieneCard } from "../../src/decisions/HygieneCard.js";
import { TextButton } from "../../src/primitives/TextButton.js";
import { color, font } from "../../src/tokens.js";
import { stage, wide } from "../_stage.js";
const click = fn();

/**
 * The caller-owned controls, drawn the way Actions draws them
 * (`packages/ui-react/src/components/activity/hygiene-review.tsx`): bordered
 * 44px rows in the card's own type, a teal accent and a teal edge on the
 * chosen fix. A bare browser radio here documents a card nobody ships.
 */
const control = (invalid = false): CSSProperties => ({
  minHeight: 44,
  width: "100%",
  boxSizing: "border-box",
  border: `1px solid ${invalid ? "var(--bk-red-ink)" : color.edge}`,
  borderRadius: 8,
  padding: "10px 12px",
  background: color.canvas,
  color: color.ink,
  font: `400 13px/1.5 ${font.body}`,
});

const FIXES = ["Link to places/eumaeus-hut.md", "Link to another note…", "Keep the text, remove the link"];

function FixOptions() {
  const [chosen, setChosen] = useState(FIXES[0]);
  return (
    <div role="radiogroup" aria-label="Fix: broken link" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {FIXES.map((fix) => (
        <label
          key={fix}
          data-fix-option=""
          style={{
            ...control(),
            display: "flex",
            alignItems: "center",
            gap: 8,
            borderColor: chosen === fix ? "var(--bk-teal-ink)" : color.edge,
          }}
        >
          <input
            type="radio"
            name="fix"
            checked={chosen === fix}
            onChange={() => setChosen(fix)}
            style={{ accentColor: "var(--bk-teal-ink)", margin: 0 }}
          />
          {fix}
        </label>
      ))}
    </div>
  );
}
const meta = preview.meta({
  title: "Decisions/HygieneCard",
  component: HygieneCard,
  decorators: [stage],
  args: {
    title: "A link points to a note that does not exist",
    severity: "MUST FIX",
    category: "broken link",
    path: "journeys/return-to-ithaca.md",
    location: "line 14",
    excerpt: "…met at [[Eumaios hut]] before…",
    provenance: "validation + hygiene · same finding",
    priority: "must fix · urgency unknown · open 12 days",
    onWhy: click,
    onReveal: click,
    controls: <FixOptions />,
    preview: {
      path: "journeys/return-to-ithaca.md",
      changes: [{ line: 14, before: "[[Eumaios hut]]", after: "[[places/eumaeus-hut|Eumaios hut]]" }],
    },
    postCheck: "Then re-checks the link before calling it fixed.",
    commit: { label: "Apply fix", onClick: click },
    later: { label: "Later ▾", onClick: click },
    dismiss: { label: "Dismiss", onClick: click },
  },
});
/** The fix options are the card's own rows: 44px, 13px body type, the chosen one edged in teal. */
export const BrokenLink = meta.story({
  play: async ({ canvasElement }) => {
    const options = [...canvasElement.querySelectorAll<HTMLElement>("[data-fix-option]")];
    await expect(options).toHaveLength(3);
    for (const option of options) {
      const style = getComputedStyle(option);
      await expect(style.fontSize, "a fix option uses the card's type, not the document's").toBe("13px");
      await expect(option.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      await expect(style.borderTopStyle).toBe("solid");
    }
    const [chosen, other] = options.map((option) => getComputedStyle(option).borderTopColor);
    await expect(chosen, "the chosen fix is edged differently").not.toBe(other);
    // Later and Dismiss always share a row. On a phone that row is under the
    // commit and they fill it; on a wide card all three share one row.
    const bar = canvasElement.querySelector<HTMLElement>("[data-disposition-bar]")!.getBoundingClientRect();
    const commit = within(canvasElement).getByRole("button", { name: /^Apply fix/ }).getBoundingClientRect();
    const later = within(canvasElement).getByRole("button", { name: /^Later/ }).getBoundingClientRect();
    const dismiss = within(canvasElement).getByRole("button", { name: /^Dismiss/ }).getBoundingClientRect();
    await expect(Math.round(dismiss.top), "Dismiss shares Later's row").toBe(Math.round(later.top));
    if (later.top > commit.top) {
      await expect(Math.round(later.left), "the pair starts at the bar's edge").toBe(Math.round(bar.left));
      await expect(Math.round(dismiss.right), "the pair fills its row").toBe(Math.round(bar.right));
    } else {
      await expect(commit.width, "on one row the commit takes the slack").toBeGreaterThan(later.width);
    }
  },
});
export const RequiredField = meta.story({
  args: {
    title: "A required frontmatter field is missing or invalid",
    category: "required field",
    location: "field created",
    excerpt: undefined,
    controls: (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <label htmlFor="created" style={{ font: `500 10px/1.5 ${font.mono}`, color: color.inkMute }}>
          created (YYYY-MM-DD)
        </label>
        <input id="created" aria-describedby="created-error" aria-invalid defaultValue="2026-07-1" style={control(true)} />
        <div id="created-error" style={{ color: "var(--bk-red-ink)", font: `400 11.5px/1.5 ${font.body}` }}>
          Use YYYY-MM-DD, for example 2026-07-12.
        </div>
      </div>
    ),
    preview: undefined,
    commit: { label: "Apply fix", disabled: true, onClick: click },
    disabledReason: "Fix the date first.",
    postCheck: "Then re-runs validation on this file.",
  },
});
export const Manual = meta.story({
  args: {
    title: "Review the TODO marker finding",
    severity: "INFO",
    category: "TODO marker",
    controls: <TextButton label="Open file ›" onClick={click} />,
    preview: undefined,
    postCheck: undefined,
    commit: { label: "Done, check again", onClick: click },
  },
});
export const Applying = meta.story({ args: { state: "applying" } });
export const Stale = meta.story({
  args: { state: "stale", recovery: <TextButton label="Refresh finding" onClick={click} /> },
});
export const Refused = meta.story({
  args: { state: "refused", reason: "the file is locked", recovery: <TextButton label="Try again" onClick={click} /> },
});
export const CheckFailed = meta.story({
  args: {
    state: "check_failed",
    code: "link-unresolved",
    recovery: (
      <>
        <TextButton label="Open file ›" onClick={click} />
        <TextButton label="Undo change" onClick={click} />
      </>
    ),
  },
});
export const ConnectionLost = meta.story({
  args: { state: "unknown", recovery: <TextButton label="Check again" onClick={click} /> },
});
export const StillDetected = meta.story({ args: { state: "still_detected" } });
export const Fixed = meta.story({
  args: {
    state: "fixed",
    controls: undefined,
    preview: undefined,
    commit: undefined,
    later: undefined,
    dismiss: undefined,
  },
});
export const Compact = meta.story({ args: { compact: true, onOpen: click } });
export const Wide = BrokenLink.extend({ parameters: wide });
