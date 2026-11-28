// The outgoing snapshots against typing (#5069, epic #4661): the component
// selects this chat's snapshots and, while a bubble's Edit depends on it,
// whether the composer is empty. A keystroke that changes neither commits
// nothing. Mounted on a real root with no host; a Profiler counts the
// commits. Queries come from `render()`, never `screen` (tests/render/dom.ts
// says why).
import { registerOutgoingSnapshotsDom, unregisterOutgoingSnapshotsDom } from "./outgoing-snapshots-dom.js";

registerOutgoingSnapshotsDom();

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { Profiler } from "react";

import { OutgoingSnapshots } from "../../src/components/chat/outgoing-snapshots.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import type { ComposerSnapshot } from "../../src/stores/draft-state.js";

const SESSION = "odysseus-leg-0";
const LIMITS = { maxFiles: 10, maxFileBytes: 25_000_000, maxTotalBytes: 50_000_000, poolBytes: 1_073_741_824 };
/** Edit's subtitle while the composer holds something (`SnapshotBubble`). */
const WAIT_FOR_EMPTY = "Edit opens when the composer is empty.";
const TYPED = ["S", "Si", "Sir", "Sire", "Siren", "Sirens", "Sirens ", "Sirens a", "Sirens ah", "Sirens ahead"];

const roots: BrainUiRoot[] = [];
afterEach(() => {
  cleanup();
  for (const r of roots.splice(0)) r.dispose();
});
afterAll(unregisterOutgoingSnapshotsDom);

const snap = (over: Partial<ComposerSnapshot> & Pick<ComposerSnapshot, "snapshotId" | "requestId" | "state">): ComposerSnapshot =>
  ({ text: "Row past the Sirens.", files: [], createdAt: 1, ...over });

function fixture(): BrainUiRoot {
  const r = createBrainUiRoot({ storage: null, request: async () => Response.json({}) });
  roots.push(r);
  r.stores.drafts.getState().setSupport(true, undefined, LIMITS, true);
  r.stores.chat.getState().setActiveSession(SESSION);
  r.stores.chat.getState().setMessages(SESSION, []);
  return r;
}

async function mounted(r: BrainUiRoot) {
  let commits = 0;
  const view = render(<BrainUiProvider root={r}><Profiler id="snapshots" onRender={() => { commits++; }}><OutgoingSnapshots /></Profiler></BrainUiProvider>);
  await act(async () => {});
  commits = 0;
  return { view, commits: () => commits, reset: () => { commits = 0; } };
}

function type(r: BrainUiRoot, texts: readonly string[]) {
  const drafts = r.stores.drafts.getState();
  const id = drafts.idFor(SESSION);
  for (const text of texts) act(() => r.stores.drafts.getState().edit(id, SESSION, { text }));
  expect(r.stores.drafts.getState().drafts[id]!.text).toBe(texts.at(-1)!);
}

function addSnapshot(r: BrainUiRoot, snapshot: ComposerSnapshot) {
  const drafts = r.stores.drafts.getState();
  act(() => drafts.createSnapshot(drafts.idFor(SESSION), SESSION, snapshot, ""));
}

describe("the outgoing snapshots while the reader types", () => {
  test("in a chat with no snapshot, ten keystrokes commit nothing", async () => {
    const r = fixture();
    const { commits } = await mounted(r);
    type(r, TYPED);
    expect(commits(), "OUTGOING_SNAPSHOTS_IDLE_WITHOUT_A_SNAPSHOT").toBe(0);
  });

  test("with a held bubble drawn, ten keystrokes commit nothing; a new snapshot still commits", async () => {
    const r = fixture();
    addSnapshot(r, snap({ snapshotId: "s-held", requestId: "r-held", state: "held" }));
    const { view, commits, reset } = await mounted(r);
    expect(view.container.querySelector('[data-outgoing-snapshot="s-held"]')).not.toBeNull();
    type(r, TYPED);
    expect(commits(), "OUTGOING_SNAPSHOTS_IDLE_WITH_A_HELD_BUBBLE").toBe(0);
    reset();
    addSnapshot(r, snap({ snapshotId: "s-two", requestId: "r-two", state: "held", createdAt: 2 }));
    expect(commits(), "A_NEW_SNAPSHOT_COMMITS").toBeGreaterThan(0);
    expect(view.container.querySelector('[data-outgoing-snapshot="s-two"]')).not.toBeNull();
  });

  test("under a returned bubble, the composer's first character holds Edit once and later keystrokes commit nothing", async () => {
    const r = fixture();
    addSnapshot(r, snap({ snapshotId: "s-back", requestId: "r-back", state: "returned" }));
    const { view, commits, reset } = await mounted(r);
    const actions = () => view.container.querySelector('[data-outgoing-snapshot="s-back"] [data-snapshot-actions]')!.textContent;
    expect(actions()).toContain("Edit");
    expect(actions()).not.toContain(WAIT_FOR_EMPTY);
    type(r, TYPED.slice(0, 1));
    expect(commits(), "EMPTINESS_CHANGE_COMMITS").toBeGreaterThan(0);
    expect(actions(), "EDIT_WAITS_FOR_AN_EMPTY_COMPOSER").toContain(WAIT_FOR_EMPTY);
    reset();
    type(r, TYPED.slice(1));
    expect(commits(), "OUTGOING_SNAPSHOTS_IDLE_UNDER_A_RETURNED_BUBBLE").toBe(0);
  });
});
