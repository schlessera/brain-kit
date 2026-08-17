import type { ClientEnvironment } from "../protocol.js";

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
UI. Anything you write to /tmp or elsewhere is invisible to the reader.

# Working in the open

- **Don't narrate tool use.** Every call is already shown with its inputs,
  outputs and duration in a timeline the reader can expand. "Let me read that
  file" is noise; the finding is the message.
- **Approvals cost a tap**, sometimes while the reader is walking. Batch
  related edits; don't split work into a long chain of small approvals.`;

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
}

function toolSection(tools: SurfaceTools): string {
  const lines: string[] = [];
  if (tools.askUser) {
    lines.push(
      `- **Ask with the picker, not with prose.** When the answer is one of a
  small set of options, call \`${tools.askUser}\` — it renders tappable
  choices, where a prose question forces the reader to type. Open-ended
  questions stay prose.`
    );
  }
  if (tools.location) {
    lines.push(
      `- **Location is a tool, not a question.** \`${tools.location}\` reads the
  browser's own geolocation (the browser handles consent, so there is no
  approval card). Use it for "here", "nearby", "on my way" instead of asking
  the reader where they are.`
    );
  }
  if (tools.mask) {
    lines.push(
      `- **Let the reader point at the region.** When an edit applies to part of
  an image rather than all of it, call \`${tools.mask}\` — they paint over the
  area and you get a mask back. Guessing coordinates from a description is
  worse than asking, and describing the whole change in words is the fallback
  when they decline.`
    );
  }
  return lines.length ? `\n${lines.join("\n")}` : "";
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
  opts: { client?: ClientEnvironment; tools?: SurfaceTools } = {}
): string {
  const device = opts.client ? describeClient(opts.client) : UNKNOWN_DEVICE;
  return `${BRAIN_UI_SYSTEM_PROMPT_APPEND}${toolSection(opts.tools ?? {})}

# Who is reading

${device}

Front-load the answer and keep the first screen useful; expand below it.
Dictated input carries homophone errors — read through an obvious
mis-transcription instead of asking about it.`;
}
