import preview from "#.storybook/preview";
import { fn } from "storybook/test";
import { HygieneCard } from "../../src/decisions/HygieneCard.js";
import { TextButton } from "../../src/primitives/TextButton.js";
import { stage, wide } from "../_stage.js";
const click = fn();
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
    controls: (
      <div role="radiogroup" aria-label="Fix: broken link">
        <label style={{ display: "flex", alignItems: "center", minHeight: 44 }}>
          <input type="radio" name="fix" defaultChecked />
          Link to places/eumaeus-hut.md
        </label>
        <label style={{ display: "flex", alignItems: "center", minHeight: 44 }}>
          <input type="radio" name="fix" />
          Link to another note…
        </label>
        <label style={{ display: "flex", alignItems: "center", minHeight: 44 }}>
          <input type="radio" name="fix" />
          Keep the text, remove the link
        </label>
      </div>
    ),
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
export const BrokenLink = meta.story({});
export const RequiredField = meta.story({
  args: {
    title: "A required frontmatter field is missing or invalid",
    category: "required field",
    location: "field created",
    excerpt: undefined,
    controls: (
      <div>
        <label htmlFor="created">created (YYYY-MM-DD)</label>
        <input
          id="created"
          aria-describedby="created-error"
          aria-invalid
          defaultValue="2026-07-1"
          style={{
            width: "100%",
            boxSizing: "border-box",
            minHeight: 44,
            color: "var(--bk-ink)",
            background: "var(--bk-canvas)",
            border: "1px solid var(--bk-red-ink)",
            borderRadius: 8,
            padding: 10,
          }}
        />
        <p id="created-error" style={{ color: "var(--bk-red-ink)" }}>
          Use YYYY-MM-DD, for example 2026-07-12.
        </p>
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
