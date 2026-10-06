/**
 * One card per component (`components/<Comp>/README.md` + `preview.html`),
 * showcase cards for the assembled screens and the kit's rule stories, and
 * `components/index.d.ts`.
 *
 * A README is the component's own doc comment: the block above its `Props`
 * type, else above its declaration, else the file's first exported doc block.
 * A preview mounts up to six of the component's Storybook stories through
 * `BrainKit.__mount`, so the card shows exactly what Storybook shows.
 */
import { Glob } from "bun";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

/** Components whose stories live in another component's file. */
const RELATED: Record<string, string> = {
  DiscRow: "Chrome/DiscButton",
  AskUserRankCard: "Decisions/Ranked question",
  RankList: "Decisions/Ranked question",
  AskUserFormCard: "Decisions/Conditional form",
  AskUserGroupCard: "Decisions/AskUserCard",
};

/** Story files that are not one component: assembled screens and the kit's rules. */
const PAGES: Record<string, string> = {
  "Screens/Chat answer": "ScreenChatAnswer",
  "Screens/Actions triage": "ScreenActionsTriage",
  "Screens/File viewer": "ScreenFileViewer",
  "Screens/First run": "ScreenFirstRun",
  "Screens/Morning digest": "ScreenMorningDigest",
  "Screens/Run detail": "ScreenRunDetail",
  "Screens/Weekly review": "ScreenWeeklyReview",
  "Rules/Non-negotiables": "RulesNonNegotiables",
  "Rules/Keyboard reachability": "RulesKeyboardReachability",
  "Blocks/In print": "BlocksInPrint",
  "Decisions/Question and mask": "QuestionAndMask",
  "Chrome/PhoneFrame": "PhoneFrame",
};

const FONTS =
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Serif+Text:ital@0;1&family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap">';
const MAX_STORIES = 6;

function docFor(kitDir: string, sources: string[], name: string): { file: string; doc: string } | null {
  const head = String.raw`(/\*\*(?:(?!\*/)[\s\S])*?\*/)\s*`;
  for (const file of sources) {
    const text = readFileSync(join(kitDir, file), "utf8");
    if (!new RegExp(String.raw`export (?:function|const|interface|type) ${name}(?:Props)?\b`).test(text)) continue;
    const m =
      new RegExp(String.raw`${head}export (?:interface|type) ${name}Props\b`).exec(text) ??
      new RegExp(String.raw`${head}export (?:default )?(?:function|const) ${name}\b`).exec(text) ??
      (new RegExp(String.raw`export (?:function|const) ${name}\b`).test(text) ? new RegExp(String.raw`^${head}export `, "m").exec(text) : null);
    if (new RegExp(String.raw`export (?:function|const) ${name}\b`).test(text)) return { file, doc: m?.[1] ?? "" };
  }
  return null;
}

function markdown(doc: string): string {
  return doc
    .replace(/^\/\*\*\s?/, "")
    .replace(/\s*\*\/$/, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\* ?/, ""))
    .join("\n")
    .replace(/\{@link ([^}]+)\}/g, "`$1`")
    .trim();
}

function preview(group: string, title: string, all: string[], shown: string[], height: number, page: boolean): string {
  const h = Math.min(4000, Math.max(120, Math.round((height * shown.length) / all.length) + 40));
  const count = shown.length < all.length ? `${shown.length} of ${all.length} stories` : `${all.length} ${all.length === 1 ? "story" : "stories"}`;
  return `<!-- @dsCard group="${group}" height=${h} subtitle="${count} · ${title}"${page ? " page" : ""} -->
<!doctype html>
<html>
<head>
<meta charset="utf-8">
${FONTS}
</head>
<body class="bk-ds-preview">
<div id="root"></div>
<script>BrainKit.__mount(document.getElementById("root"), ${JSON.stringify(title)}, ${JSON.stringify(shown)});</script>
</body>
</html>
`;
}

export function buildCards(
  kitDir: string,
  components: string[],
  index: Record<string, string[]>,
  heights: Record<string, number>
): { files: Record<string, string>; noPreview: string[]; noDoc: string[] } {
  const sources = [...new Glob("src/**/*.{ts,tsx}").scanSync(kitDir)].sort();
  const files: Record<string, string> = {};
  const noPreview: string[] = [];
  const noDoc: string[] = [];

  for (const name of components) {
    const title = Object.keys(index).find((t) => t.split("/").pop() === name) ?? RELATED[name];
    if (title && index[title]) {
      files[`components/${name}/preview.html`] = preview(title.split("/")[0], title, index[title], index[title].slice(0, MAX_STORIES), heights[title] ?? 300, false);
    } else noPreview.push(name);

    const found = docFor(kitDir, sources, name);
    const body = found?.doc ? markdown(found.doc) : "";
    if (!body) noDoc.push(name);
    files[`components/${name}/README.md`] = [
      body || `\`${name}\` from \`@schlessera/brain-ui-kit\`.`,
      "",
      "## Source",
      "",
      `- Component: \`packages/ui-kit/${found?.file ?? "src/index.ts"}\``,
      title && index[title] ? `- Stories: Storybook \`${title}\` (${index[title].length}), the source of this card's preview` : "- No live preview: its stories depend on the full chat app",
      `- Import: \`import { ${name} } from "@schlessera/brain-ui-kit"\`, with \`@schlessera/brain-ui-kit/styles.css\` loaded once`,
      "",
    ].join("\n");
  }

  for (const [title, card] of Object.entries(PAGES)) {
    if (!index[title]) continue;
    const group = title.startsWith("Screens/") ? "Screens" : title.startsWith("Rules/") ? "Rules" : title.split("/")[0];
    files[`components/${card}/preview.html`] = preview(group, title, index[title], index[title].slice(0, 4), heights[title] ?? 600, true);
  }
  return { files, noPreview, noDoc };
}

/** The emitted declarations concatenated into one file for reading; not type-checked. */
export function buildIndexDts(kitDir: string, tmpDir: string): string {
  const outDir = join(tmpDir, "dts");
  const tsc = Bun.spawnSync(["bunx", "tsc", "-p", join(kitDir, "tsconfig.build.json"), "--emitDeclarationOnly", "--declarationMap", "false", "--sourceMap", "false", "--outDir", outDir], {
    cwd: kitDir,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (tsc.exitCode !== 0) throw new Error(`tsc failed: ${tsc.stdout.toString()}${tsc.stderr.toString()}`);
  const indexDts = readFileSync(join(outDir, "index.d.ts"), "utf8");
  const modules = [...new Set(["types", ...[...indexDts.matchAll(/from "\.\/([^"]+)\.js"/g)].map((m) => m[1])])];
  let out = "// Types of @schlessera/brain-ui-kit, concatenated from its emitted declarations for reading.\n// Not type-checked here; import from the package in real code.\n";
  for (const mod of modules) {
    const file = join(outDir, `${mod}.d.ts`);
    if (!existsSync(file)) continue;
    const body = readFileSync(file, "utf8")
      .split("\n")
      .filter(
        (l) => !l.startsWith("import ") && !/^export \{[^}]*\} from /.test(l) && !l.startsWith("export * from") && !l.startsWith("//# sourceMappingURL")
      )
      .join("\n")
      .trim();
    if (body) out += `\n// ── ${mod} ──\n${body}\n`;
  }
  return out;
}
