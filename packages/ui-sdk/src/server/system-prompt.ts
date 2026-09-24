import type { ClientEnvironment } from "../protocol.js";
import {
  ASK_USER_CONTRACT,
  BRIDGE_TOOL_CONTRACTS,
  GET_CURRENT_LOCATION_CONTRACT,
  QUERY_ACTIVITY_CONTRACT,
  REQUEST_IMAGE_MASK_CONTRACT,
  SHOW_BLOCK_CONTRACT,
  toolBriefLines,
  type BridgeToolName,
} from "../tool-contracts/index.js";
import type { WebSearchBrief } from "./web-search.js";

/**
 * The chat UI's own capability brief, appended to the agent's system prompt.
 *
 * Everything here is a fact about the SURFACE the answer lands on, which the
 * model cannot discover from the brain repo: it can read CLAUDE.md and the
 * files, but nothing tells it that a mermaid fence becomes a zoomable diagram
 * or that the reader is holding a phone. Repo-specific conventions stay in the
 * brain repo's own CLAUDE.md — this file must remain true for any brain-kit
 * deployment.
 *
 * Keep it tight. It rides every turn, and a long brief crowds out the user's
 * actual instructions.
 */
export const BRAIN_UI_SYSTEM_PROMPT_APPEND = `# Response surface

Your replies render as GitHub-flavored markdown in a chat UI, not in a
terminal. What that buys you:

- **Diagrams.** A \`\`\`mermaid fence renders as a real diagram, themed to match
  the app. The reader can open it full-screen to pan and zoom, and share it as
  PNG, PDF or SVG. Reach for one when structure IS the answer — a flow, a
  sequence, a state machine, a hierarchy, a timeline — instead of describing
  the shape in prose. Available types include flowchart, sequence, class,
  state, ER, journey, gantt, pie, quadrant, mindmap, timeline, gitGraph,
  sankey, xychart, block, requirement, kanban and architecture; most answers
  that want a picture are not flowcharts. Keep it to what fits on a phone: a
  handful of nodes with short labels beats one exhaustive diagram. Prose,
  lists and tables remain the default for everything non-structural.
- **Do not put a \`%%{init}%%\` directive in a diagram.** The app themes every
  diagram itself, and your own directive silently overrides that theme and
  makes the diagram look foreign. Write plain mermaid.
- **Diagrams stream.** A partial fence shows as source until it parses, so a
  diagram mid-answer costs the reader nothing.
- **Paths and wikilinks are tap targets.** A repo path written plainly
  (\`projects/active/foo.md\`) becomes a link into the file viewer, and
  \`[[note]]\` / \`[[note|Label]]\` resolves the same way. Wikilinks are also
  what the graph view is built from, so when you WRITE a note, link it to its
  neighbours — an unlinked note is invisible in the graph.
- **No raw HTML.** The renderer has no HTML pass, so \`<b>x</b>\` reaches the
  reader as the literal text \`<b>x</b>\`, tags and all. Markdown only — the
  one exception is the share block below.
- Tables, task lists and footnotes render; code blocks are highlighted and
  copyable.

# Shareable output

When the user asks for something to send onward ("summarize this for
WhatsApp", "make a one-pager I can email"), wrap the shareable part:

<share format="image" title="Weekly summary">
markdown body — rendered as a preview and used as the share payload
</share>

\`format\` pre-fills the primary button: image | pdf | text | markdown |
richtext. Use it only when sharing was actually asked for; every assistant
message already carries its own share button.

The PNG/PDF renderer runs with no network and no JavaScript, so **remote
images do not appear** — inline anything essential as a \`data:\` URI. Mermaid
diagrams are the exception and always render.

Only files inside the brain repo can be opened, previewed or shared from the
UI. Anything you write to /tmp or elsewhere is invisible to the reader. For
output that is only for now (a preview, a draft, a file to share and forget),
use the brain's scratch area, \`.brain/scratch/\` (\`brain render --scratch\`,
\`brain image --scratch\`): the reader can open it, it is never committed, and it
is pruned after 7 days.

# Working in the open

- **Don't narrate tool use.** Every call is already shown with its inputs,
  outputs and duration in a timeline the reader can expand. "Let me read that
  file" is noise; the finding is the message.
- **Approvals cost a tap**, sometimes while the reader is walking. Batch
  related edits; don't split work into a long chain of small approvals.`;

/**
 * Facts about the host's turn lifecycle the model cannot discover on its own,
 * and will keep tripping over until told: subagents dying at turn end,
 * timeout cancellations masquerading as human refusals, and the shared write
 * locks. Costed one 48-country research fan-out (23 dead background agents,
 * three false "the user refused" stops) before it was written down.
 */
export interface ExecutionBrief {
  /**
   * Name of the fan-out/delegation tool, or false when this backend has
   * none. Default "Agent" (the Claude backend's tool) preserves the
   * historical text; a backend without one must pass false — naming a tool
   * the model cannot call is worse than saying nothing.
   */
  subagentTool?: string | false;
  /**
   * True when each turn runs as its own PROCESS whose background children
   * die at turn end (the Claude backend). False for an in-process backend
   * whose sessions persist across turns. Default true.
   */
  perTurnProcess?: boolean;
  /**
   * True when sibling tool calls in one assistant message execute
   * concurrently and the model should be told to batch independent calls.
   * Default false (the Claude backend's harness decides this itself).
   */
  parallelToolCalls?: boolean;
}

function turnLifecycleSection(turnBudgetMs?: number, execution?: ExecutionBrief): string {
  const budget =
    turnBudgetMs && turnBudgetMs > 0
      ? `about ${Math.round(turnBudgetMs / 60000)} minutes`
      : "a fixed number of minutes";
  const subagentTool = execution?.subagentTool ?? "Agent";
  const perTurnProcess = execution?.perTurnProcess ?? true;
  const lines: string[] = [];

  if (perTurnProcess && subagentTool) {
    lines.push(`- **Each turn is its own process; everything it started dies with it.** A
  background subagent cannot outlive the turn, so the host reruns ${subagentTool} calls
  in the foreground. Fan out with foreground subagents and collect their
  results before the turn ends.`);
  } else if (subagentTool) {
    lines.push(`- **Fan out with \`${subagentTool}\` for independent workstreams** — parallel
  reviews, research alongside implementation, multiple audits. Foreground
  runs return results within this turn; collect them before summarizing.`);
  }
  if (execution?.parallelToolCalls) {
    lines.push(`- **Independent tool calls in one message run concurrently.** Batch your
  reads — searches, file reads, web fetches — into a single message instead
  of issuing them one at a time. Same-file writes and git commands still
  serialize safely, so batching is never unsafe.`);
  }
  const incremental = subagentTool
    ? "have subagents write results\n  incrementally (one file per finding), never batched at the end"
    : "write intermediate results to\n  files as you go, never batched at the end";
  lines.push(`- **This turn has a hard budget of ${budget}** — the host cancels it at the
  cap, mid-flight work included. Size batches to finish inside it, prefer
  several small turns over one big one, and ${incremental}.`);
  lines.push(`- **A tool error is not always a human refusal.** "The user doesn't want to
  take this action", "hook did not respond before its timeout" or "lock busy"
  usually mean a cancelled turn or a busy write lock — especially in context
  from an earlier turn that hit the budget. Retry once before concluding the
  user said no.`);
  lines.push(`- **Sessions run in parallel against one repo.** Writes to the same file
  serialize, and git staging/history commands serialize repo-wide. A "lock
  busy — retry" denial means exactly that: the identical call is fine a
  moment later.`);

  return `

# Turn lifecycle

${lines.join("\n")}`;
}

/**
 * Tool names differ per backend — the Claude backend exposes these through an
 * in-process MCP server (`mcp__brain-ui__…`), pi registers plain tool names,
 * and pi has no location tool at all. Naming a tool the running backend does
 * not have is worse than saying nothing, so each backend declares its own.
 */
export interface SurfaceTools {
  /** Name of the tappable-choice tool, or false when this backend has none. */
  askUser?: string | false;
  /** Name of the browser-geolocation tool, or false when absent. */
  location?: string | false;
  /** Name of the mask-painting tool, or false when absent. */
  mask?: string | false;
  /** Name of the activity-record query tool, or false when absent. */
  activity?: string | false;
  /** Name of the inline answer-block tool, or false when absent. */
  block?: string | false;
}

/**
 * Which `SurfaceTools` key names each contract. Keyed by `BridgeToolName`, so
 * adding a contract without deciding how a backend declares it is a `tsc`
 * error rather than a tool that silently never reaches the prompt.
 */
const SURFACE_TOOL_KEYS: Record<BridgeToolName, keyof SurfaceTools> = {
  [ASK_USER_CONTRACT.name]: "askUser",
  [GET_CURRENT_LOCATION_CONTRACT.name]: "location",
  [REQUEST_IMAGE_MASK_CONTRACT.name]: "mask",
  [QUERY_ACTIVITY_CONTRACT.name]: "activity",
  [SHOW_BLOCK_CONTRACT.name]: "block",
};

/**
 * The tool paragraph, GENERATED from the contract list rather than written
 * out here. A tool that is schema'd but never described to the model was a
 * standing hazard while the two lists were maintained by hand; now a contract
 * carries its own brief and this function cannot skip one. `tests/` asserts
 * that every contract in `BRIDGE_TOOL_CONTRACTS` reaches the prompt.
 */
function toolSection(tools: SurfaceTools, webSearch?: WebSearchBrief): string {
  const lines = toolBriefLines(BRIDGE_TOOL_CONTRACTS, (contract) =>
    tools[SURFACE_TOOL_KEYS[contract.name as BridgeToolName]]
  );
  if (webSearch) lines.push(webSearchLine(webSearch));
  return lines.length ? `\n${lines.join("\n")}` : "";
}

/**
 * Which search providers are actually reachable. The search tool's own
 * description names every provider its extension could theoretically use —
 * around thirty — regardless of what this deployment configured, so a model
 * reading it alone will happily ask for one that has no key and get an error.
 * This line is the correction, and it also states the cost gradient, which the
 * tool description never mentions.
 */
function webSearchLine(brief: WebSearchBrief): string {
  if (brief.providers.length === 0) {
    return `- **Web search picks its own provider.** No provider chain is configured, so
  \`${brief.toolName}\` falls back to its built-in order, starting with a free
  rate-limited tier. Omit the \`provider\` argument and let it choose.`;
  }
  const list = brief.providers
    .map((p) => `\`${p.id}\`${p.paid ? " (paid)" : " (free)"} — ${p.blurb}`)
    .join("; ");
  const [cheapest] = brief.providers;
  const paid = brief.providers.filter((p) => p.paid);
  const override = paid.length
    ? `Pass one explicitly — \`provider: "${paid[0]!.id}"\` — only when the question
  warrants it or the reader asked for that provider.`
    : `Pass \`provider\` explicitly only when the reader asks for a specific one.`;
  return `- **Web search runs a fixed provider chain**, tried in this order: ${list}.
  The first one answers; a later one is reached only when an earlier fails, so
  omitting the \`provider\` argument keeps searches on ${cheapest!.id}. ${override}
  \`${brief.toolName}\`'s own description lists many other providers — none of
  them are configured here, and naming one fails.`;
}

/** Fallback line when the client never reported its environment. */
const UNKNOWN_DEVICE = `The reader's device is unknown — assume a phone held one-handed, and don't
promise a capability you can't confirm.`;

/**
 * Render the per-turn device paragraph.
 *
 * Capability facts must come from the live client, not from assumption: the
 * same deployment is a phone PWA, a desktop browser and an iPad, and each one
 * answers "can you take a photo", "can I share this to WhatsApp" and "where
 * am I" differently. Everything here is feature detection, not a UA guess.
 */
function describeClient(env: ClientEnvironment): string {
  const lines: string[] = [];

  const form =
    env.formFactor === "phone"
      ? "a phone"
      : env.formFactor === "tablet"
        ? "a tablet"
        : "a desktop browser";
  const installed = env.standalone ? ", running as an installed PWA" : "";
  const input = env.touch ? "touch" : "mouse and keyboard";
  lines.push(`Right now the reader is on ${form}${installed}, using ${input}.`);

  // Each capability has TWO phrasings. Reusing one list's wording for the
  // other produces sentences like "NOT available: geolocation, so the
  // location tool works", which is worse than saying nothing at all.
  const has: string[] = [];
  const lacks: string[] = [];
  (env.camera ? has : lacks).push("a camera");
  (env.microphone ? has : lacks).push("a microphone");
  if (env.geolocation) has.push("geolocation, so the location tool works");
  else lacks.push("geolocation — the location tool will fail here");
  if (env.share) {
    has.push(
      env.shareFiles
        ? "the OS share sheet, files included"
        : "the OS share sheet, but for text and links only — not files"
    );
  } else {
    lacks.push("any OS share sheet — shared output arrives as a download");
  }
  if (has.length) lines.push(`Available: ${has.join("; ")}.`);
  if (lacks.length) lines.push(`NOT available: ${lacks.join("; ")}.`);

  if (env.viewportWidth) {
    // The narrow-column warning is only true when the column IS narrow —
    // telling a 2560px desktop that a five-column table won't fit degrades
    // the answer for no reason.
    lines.push(
      env.viewportWidth < 700
        ? `The reading column is about ${env.viewportWidth}px wide, so a table ` +
            `past three or four columns will not fit.`
        : `The reading column is about ${env.viewportWidth}px wide.`
    );
  }
  if (env.locale || env.timeZone) {
    const parts = [env.locale, env.timeZone].filter(Boolean).join(", ");
    lines.push(`Locale/timezone: ${parts}.`);
  }
  return lines.join(" ");
}

/**
 * The full brief for one turn: the static surface description plus whatever
 * the client reported about itself. Callers pass the environment straight
 * from the turn request; omitting it is safe and degrades to a phone-first
 * assumption.
 */
export function buildSystemPromptAppend(
  opts: {
    client?: ClientEnvironment;
    tools?: SurfaceTools;
    /**
     * The host's per-turn timeout, so the brief states the real budget the
     * agent is working against. Absent = the section still warns, without a
     * number.
     */
    turnBudgetMs?: number;
    /** How this backend executes work — see {@link ExecutionBrief}. */
    execution?: ExecutionBrief;
    /**
     * Which web-search providers this deployment actually reaches. Absent when
     * the backend has no configurable search (the Claude backend's hosted
     * WebSearch) — the brief then says nothing about providers.
     */
    webSearch?: WebSearchBrief;
  } = {}
): string {
  const device = opts.client ? describeClient(opts.client) : UNKNOWN_DEVICE;
  return `${BRAIN_UI_SYSTEM_PROMPT_APPEND}${turnLifecycleSection(opts.turnBudgetMs, opts.execution)}${toolSection(opts.tools ?? {}, opts.webSearch)}

# Who is reading

${device}

Front-load the answer and keep the first screen useful; expand below it.
Dictated input carries homophone errors — read through an obvious
mis-transcription instead of asking about it.`;
}
