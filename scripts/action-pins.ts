/**
 * Workflow actions run with the workflow's token, so each `uses:` names the
 * full commit its release tag pointed at when the pin was reviewed, never the
 * mutable tag itself (#4111). One table owns every pin; the workflow lint and
 * the generated heavy-feedback workflow read it.
 */
export const ACTION_PINS = {
  "actions/checkout@v7": "3d3c42e5aac5ba805825da76410c181273ba90b1",
  "actions/deploy-pages@v4": "d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e",
  "actions/setup-node@v6": "249970729cb0ef3589644e2896645e5dc5ba9c38",
  "actions/setup-node@v7": "949feb2413d6458794dcd2491c4babbbce0c15c1",
  "actions/upload-artifact@v4": "ea165f8d65b6e75b540449e92b4886f43607fa02",
  "actions/upload-artifact@v7": "cf430e030ddbb5b0abf93d22962f4752f3646cd9",
  "actions/upload-pages-artifact@v4": "7b1f4a764d45c48632c6b24a0339c27f5614fb0b",
  "oven-sh/setup-bun@v2": "0c5077e51419868618aeaa5fe8019c62421857d6",
} as const;
export type ActionPin = keyof typeof ACTION_PINS;

const split = (pin: string): [string, string] => [pin.slice(0, pin.lastIndexOf("@")), pin.slice(pin.lastIndexOf("@") + 1)];

/** The `uses:` value for a reviewed action release: `owner/name@<commit>`. */
export function pinned(pin: ActionPin): string {
  return `${split(pin)[0]}@${ACTION_PINS[pin]}`;
}

const REVIEWED = new Map<string, string>(Object.entries(ACTION_PINS).map(([pin, sha]) => [`${split(pin)[0]}@${sha}`, split(pin)[1]]));
const USES_LINE = /^\s*(?:-\s*)?uses:\s*(.*?)\s*$/;

/** Every `uses:` value a parsed workflow carries, wherever its YAML spells it. */
function parsedUses(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) for (const entry of value) parsedUses(entry, found);
  else if (value && typeof value === "object") for (const [key, entry] of Object.entries(value)) {
    if (key === "uses") found.push(String(entry)); else parsedUses(entry, found);
  }
  return found;
}

/**
 * A workflow may run only reviewed action commits. Each reference is one block
 * line, `uses: owner/name@<40-hex commit> # <tag>`, whose commit and tag match
 * `ACTION_PINS`. Parsed references are counted against those lines, so a quoted,
 * flow-style or reusable-workflow reference cannot pass unread.
 */
export function actionPinProblems(text: string, file: string): string[] {
  const problems: string[] = [], fail = (message: string) => problems.push(`${file}: ${message}`);
  let parsed: unknown;
  try { parsed = Bun.YAML.parse(text); } catch { return [`${file}: invalid YAML`]; }
  let lines = 0;
  for (const line of text.split("\n")) {
    const value = USES_LINE.exec(line)?.[1];
    if (value === undefined) continue;
    lines++;
    const match = /^([^\s@"'#]+)@([0-9a-f]{40})\s+#\s+(\S+)$/.exec(value);
    if (!match) { fail(`action reference must be a full commit followed by its tag comment, not: ${value}`); continue; }
    const tag = REVIEWED.get(`${match[1]}@${match[2]}`);
    if (!tag) fail(`${match[1]}@${match[2]} is not a reviewed pin in scripts/action-pins.ts`);
    else if (tag !== match[3]) fail(`${match[1]}@${match[2]} is the reviewed commit of ${tag}, not ${match[3]}`);
  }
  const uses = parsedUses(parsed);
  for (const value of uses) if (!REVIEWED.has(value)) fail(`${value} is not a reviewed action commit`);
  if (uses.length !== lines) fail(`${uses.length} action references but ${lines} readable uses: lines; write each as its own block line`);
  return [...new Set(problems)];
}

/** Restore the tag comments a YAML stringifier drops, for generated workflows. */
export function annotateActionPins(text: string): string {
  return text.split("\n").map(line => {
    const match = /^(\s*(?:-\s*)?uses:\s*)["']?([^\s"'#]+@[0-9a-f]{40})["']?\s*$/.exec(line);
    const tag = match && REVIEWED.get(match[2]!);
    return match && tag ? `${match[1]}${match[2]} # ${tag}` : line;
  }).join("\n");
}
