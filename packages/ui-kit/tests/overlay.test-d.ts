import type { OverlayProps } from "../src/chrome/Overlay.js";
const base = { open: true, variant: "sheet" as const, onClose: () => {}, children: null };
// @ts-expect-error An accessible name is mandatory.
const missing: OverlayProps = base;
// @ts-expect-error Two naming strategies are ambiguous.
const ambiguous: OverlayProps = { ...base, title: "Raft", label: "Raft" };
const title: OverlayProps = { ...base, title: "Raft" };
const label: OverlayProps = { ...base, label: "Raft" };
const labelled: OverlayProps = { ...base, labelledBy: "raft-heading" };
void [missing, ambiguous, title, label, labelled];
