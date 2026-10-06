/**
 * Builds the files of the Brain Kit Design System artifact from
 * `packages/ui-kit`: tokens, the live component bundle, one card per
 * component, the brand book and the cover.
 *
 *   bun scripts/design-system/build.ts [--out <dir>]
 *
 * Writes `<dir>/project/…` (default: the OS temp directory, never inside this
 * tree) and prints what it built. Publishing is a separate, authenticated
 * step: see this folder's README.
 */
import { cpSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { parseArgs } from "util";

import { buildBundle, buildCss, buildLibs } from "./bundle.ts";
import { buildCards, buildIndexDts } from "./cards.ts";
import { checkStories } from "./check.ts";
import { buildTokensJson, parseTokensCss } from "./tokens.ts";

const ROOT = resolve(import.meta.dir, "../..");
const KIT = join(ROOT, "packages/ui-kit");

const { values } = parseArgs({ options: { out: { type: "string" } } });
const out = resolve(values.out ?? join(tmpdir(), "brain-kit-design-system"));
if (out === ROOT || out.startsWith(`${ROOT}/`)) {
  // The leakage gate scans untracked files, and the output carries a build
  // of the whole kit; keep it outside the tree.
  console.error(`--out must be outside the repository: ${out}`);
  process.exit(2);
}
const project = join(out, "project");
const work = join(out, ".work");
rmSync(out, { recursive: true, force: true });
mkdirSync(project, { recursive: true });
mkdirSync(work, { recursive: true });

const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: ROOT }).stdout.toString().trim();
const ref = `${git("rev-parse", "--abbrev-ref", "HEAD")}@${git("rev-parse", "--short", "HEAD")}`;

const css = await Bun.file(join(KIT, "src/tokens.css")).text();
const { tokens, skipped } = parseTokensCss(css);
await Bun.write(join(project, "tokens.json"), JSON.stringify(buildTokensJson(tokens, ref, new Date().toISOString().slice(0, 10)), null, 1));
console.log(`tokens: ${tokens.length} colours × 3 themes${skipped.length ? `; skipped ${skipped.join(", ")}` : ""}`);

const reactVersion = await buildLibs(project);
const bundle = await buildBundle(KIT, project, work);
await buildCss(KIT, project, work);
console.log(`bundle: ${(bundle.bytes / 1024) | 0} KB, ${bundle.components.length} components, ${bundle.titles.length} story files; React ${reactVersion}`);

const check = await checkStories(project);
console.log(`check: ${check.checked - check.failures.length} of ${check.checked} story-file renders clean`);
for (const f of check.failures) console.error(`  ${f.title} (${f.theme}): ${[...f.errors, ...f.empty.map((s) => `empty ${s}`)].join("; ") || `height ${f.height}`}`);

const cards = buildCards(KIT, bundle.components, check.index, check.heights);
for (const [path, text] of Object.entries(cards.files)) await Bun.write(join(project, path), text);
await Bun.write(join(project, "components/index.d.ts"), buildIndexDts(KIT, work));
cpSync(join(import.meta.dir, "content/README.md"), join(project, "README.md"));
cpSync(join(import.meta.dir, "content/Cover.html"), join(project, "components/Cover/preview.html"));
console.log(`cards: ${Object.keys(cards.files).length} files; no preview: ${cards.noPreview.join(", ") || "none"}; no doc comment: ${cards.noDoc.join(", ") || "none"}`);

await Bun.write(
  join(out, "libraries.json"),
  JSON.stringify(
    [
      { name: "react", version: reactVersion, global: "React", file: "components/lib/react.js" },
      { name: "react-dom", version: reactVersion, global: "ReactDOM", file: "components/lib/react-dom.js" },
    ],
    null,
    1
  )
);
rmSync(work, { recursive: true, force: true });
console.log(`\nWrote ${project} (source ${ref}). libraries.json holds the index's \`libraries\` entry.`);
if (check.failures.length) process.exit(1);
