/**
 * DC-versus-React parity harness.
 *
 * Renders a component twice — once as the original `.dc.html` running the real
 * DC runtime, once as the ported Storybook story — and compares the two DOM
 * trees node by node across 37 computed properties. It is the only check that
 * answers "does the port still look like the design?" without a human eye, and
 * it caught things review did not: it is how the `sc-host` decision was
 * verified rather than argued, and how a colour-token refactor was shown to
 * have changed nothing.
 *
 * Two DC constructs are made transparent, because the port deliberately has no
 * equivalent for either: `div.sc-host`, the wrapper the runtime puts around
 * every component, and `span.sc-interp`, the wrapper it puts around every
 * scalar text hole. Walking through them is what lets the trees line up.
 *
 * USAGE — two static servers, then one invocation per component:
 *
 *   python3 -m http.server 8801 --directory <the design drop's kit/>
 *   bunx storybook build && python3 -m http.server 8802 --directory storybook-static
 *
 *   bun tools/dc-parity/compare.ts \
 *     Button \
 *     'http://localhost:8801/Button.dc.html' '.sc-host' \
 *     'http://localhost:8802/iframe.html?viewMode=story&id=primitives-button--default' \
 *     '#storybook-root > div > div'
 *
 * The Storybook selector usually needs `> div` for the stage decorator. Story
 * args can be set in the URL (`&args=label:x;onClick:!undefined`) to match the
 * DC page, which renders from its `data-props` defaults.
 *
 * Requires `agent-browser` on PATH.
 *
 * FOUR CLASSES OF DIFFERENCE ARE EXPECTED AND NOT PORT BUGS:
 *   - `text` whitespace: DC templates carry newlines that JSX strips.
 *   - `box-sizing: border-box` / `border-style: solid` where DC has content-box
 *     and none: Tailwind preflight, which the DC pages do not load. It changes
 *     nothing where a border is 0 wide or a box is auto-sized.
 *   - Inherited `color` / `font-family` / `line-height` on elements that render
 *     no text: the DC standalone page sets no body font.
 *   - `display: inline-flex` becoming `flex`: the sc-host decision. Without the
 *     wrapper the component root is itself the flex item, and flex items are
 *     blockified. See the sc-host decision in `docs/decisions/design-kit.md`.
 */

import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

const PROBE = readFileSync(join(import.meta.dir, "probe.js"), "utf8");

/** One element's probed computed style, plus enough identity to line rows up. */
type Row = Record<string, string>;

function dump(url: string, selector: string, session: string): Row[] {
  const js = PROBE.replace("ROOT_SELECTOR", JSON.stringify(selector));
  const run = (args: string[]) =>
    spawnSync("agent-browser", ["--session", session, ...args], { encoding: "utf8" });
  run(["open", url]);
  run(["wait", "2500"]);
  const result = run(["eval", js, "--json"]);
  return JSON.parse(JSON.parse(result.stdout).data.result);
}

/** Width and height depend on the harness container, not on the component. */
function normalise(rows: Row[]): Row[] {
  return rows.map((row) => {
    const copy = { ...row };
    delete copy.width;
    delete copy.height;
    copy.fontFamily = copy.fontFamily.replaceAll('"', "").replaceAll(", ", ",");
    return copy;
  });
}

const [name, dcUrl, dcSelector, sbUrl, sbSelector] = process.argv.slice(2);
if (!sbSelector) {
  console.error("usage: compare.ts <name> <dcUrl> <dcSelector> <storybookUrl> <storybookSelector>");
  process.exit(2);
}

const dc = normalise(dump(dcUrl, dcSelector, "dc"));
const react = normalise(dump(sbUrl, sbSelector, "sb"));

console.log(`\n===== ${name}: DC ${dc.length} nodes vs React ${react.length} nodes`);
if (dc.length !== react.length) {
  console.log("  NODE COUNT DIFFERS");
  console.log("  dc:", dc.map((r) => `${r.tag}:${r.text.slice(0, 14)}`));
  console.log("  rx:", react.map((r) => `${r.tag}:${r.text.slice(0, 14)}`));
}

let differences = 0;
for (const [i, left] of dc.entries()) {
  const right = react[i];
  if (!right) break;
  for (const key of Object.keys(left)) {
    if (left[key] === right[key]) continue;
    console.log(`  [${i} ${left.tag} ${JSON.stringify(left.text.slice(0, 18))}] ${key}: DC=${JSON.stringify(left[key])}  React=${JSON.stringify(right[key])}`);
    differences += 1;
  }
}
if (differences === 0 && dc.length === react.length) {
  console.log("  IDENTICAL on every probed property");
}
process.exit(differences > 0 || dc.length !== react.length ? 1 : 0);
