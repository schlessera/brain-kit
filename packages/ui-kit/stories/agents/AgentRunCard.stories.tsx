import preview from "#.storybook/preview";
import { expect } from "storybook/test";

import { researcherTools, runs, usd, watcherTools } from "../../fixtures/runs.js";
import { AgentRunCard } from "../../src/agents/AgentRunCard.js";
import { stage, wide } from "../_stage.js";

const [researcher, filer, watcher, ledger] = runs;

const meta = preview.meta({
  title: "Agents/AgentRunCard",
  component: AgentRunCard,
  decorators: [stage],
  args: {
    agent: researcher.agent,
    state: researcher.state,
    meta: `${researcher.steps} steps · ${researcher.tokens / 1000}k tok · ${researcher.elapsed}`,
    task: researcher.task,
    progress: researcher.progress,
    tools: researcherTools,
  },
  argTypes: {
    state: { control: "select", options: ["running", "waiting", "done", "failed"] },
    progress: { control: { type: "range", min: 0, max: 100, step: 1 } },
  },
});

/** Amber and breathing: an agent is working, and the tool strip names what it
 * is doing rather than spinning at you. */
export const Default = meta.story({});

/**
 * Teal, still breathing — and the tone change is the whole message. `waiting`
 * is not the agent waiting, it is YOU: the run has stopped and cannot restart
 * until somebody answers.
 */
export const Waiting = Default.extend({
  args: {
    agent: filer.agent,
    state: filer.state,
    task: filer.task,
    progress: filer.progress,
    meta: `${filer.steps} steps · ${filer.elapsed}`,
    tools: undefined,
  },
});

export const Done = Default.extend({
  args: {
    agent: ledger.agent,
    state: ledger.state,
    task: ledger.task,
    progress: ledger.progress,
    meta: `${ledger.steps} steps · ${usd(ledger.cents)} · ${ledger.elapsed}`,
    tools: undefined,
  },
});

/** Red, not breathing, and the failed tool is named. A dead-lettered run that
 * would not say which call died is a run nobody can fix. */
export const Failed = Default.extend({
  args: {
    agent: watcher.agent,
    state: watcher.state,
    task: watcher.task,
    progress: watcher.progress,
    meta: `${watcher.steps} steps · ${watcher.elapsed}`,
    tools: watcherTools,
  },
});

/**
 * `progress: null` draws no meter at all, and it is a different thing from
 * `progress: 0`. Zero is "started and nothing done yet"; null is "this run has
 * no notion of how far along it is". The source distinguishes them with
 * `p.progress !== null && p.progress !== undefined` and so does the port.
 */
export const NoMeter = Default.extend({ args: { progress: null } });

/** An empty tool array renders no strip — the `.length` check, not a truthiness
 * check, so a caller who passes `[]` gets nothing rather than a stand-in. */
export const NoTools = Default.extend({ args: { tools: [] } });

export const Wide = Default.extend({ parameters: wide });

/**
 * The prop is `agent`. The source's `data-props` says `name` while its own
 * `renderVals()` reads `p.agent`, and the half that renders wins — `name` was
 * only ever reserved because `<dc-import name="…">` owns that attribute, which
 * is a constraint React does not have.
 */
export const AgentIsTheProp = meta.story({
  args: { agent: "note-filer" },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("note-filer")).toBeTruthy();
  },
});

/** Never colour alone: each tool state carries its own mark, so a monochrome
 * screenshot still says which call failed. */
export const ToolMarksAreNotColourAlone = meta.story({
  args: { tools: watcherTools },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("✓ brain_search")).toBeTruthy();
    await expect(await canvas.findByText("✕ WebFetch")).toBeTruthy();
  },
});

/** A card with no handlers anywhere is not interactive, and says so: the source
 * gives this component no callbacks at all, and the port does not invent any. */
export const Static = meta.story({
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector("[role]")).toBeNull();
    await expect(canvasElement.querySelector("[tabindex]")).toBeNull();
    await expect(canvasElement.querySelector(".bk-control")).toBeNull();
  },
});
