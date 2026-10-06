/**
 * The artifact's `components/bundle.js`, `components/bundle.css` and the two
 * React libraries its previews load.
 *
 * The bundle is ONE classic script assigning `window.BrainKit`: every runtime
 * export of `packages/ui-kit/src/index.ts`, plus the Storybook stories and a
 * mounter that renders any of them (`BrainKit.__mount`). Stories are CSF
 * factories, so `#.storybook/preview` and `storybook/test` resolve to the
 * small shims beside this file instead of the Storybook runtime; play
 * functions are kept and never run.
 *
 * Stories that import `@schlessera/brain-ui-react` are left out: they pull the
 * whole chat app in, which takes the bundle from about 0.7 MB to 5.7 MB
 * against the artifact's 6 MB cap.
 *
 * React is NOT bundled: the bundle reads `window.React`/`window.ReactDOM`,
 * which `components/lib/` supplies at the version the kit's Storybook runs.
 */
import { Glob } from "bun";
import { readFileSync } from "fs";
import { join } from "path";

const HERE = import.meta.dir;

/** A preview inlines these files, so nothing may close the script early. */
function inlineSafe(js: string): string {
  return js.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
}

const reactGlobals: Bun.BunPlugin = {
  name: "react-globals",
  setup(b) {
    const globals: Record<string, string> = {
      react: "window.React",
      "react-dom": "window.ReactDOM",
      "react-dom/client": "window.ReactDOM",
    };
    b.onResolve({ filter: /^(react|react-dom|react-dom\/client)$/ }, (a) => ({ path: a.path, namespace: "bk-global" }));
    b.onLoad({ filter: /.*/, namespace: "bk-global" }, (a) => ({ contents: `module.exports = ${globals[a.path]};`, loader: "js" }));
    b.onResolve({ filter: /^react\/jsx(-dev)?-runtime$/ }, () => ({ path: "jsx", namespace: "bk-jsx" }));
    b.onLoad({ filter: /.*/, namespace: "bk-jsx" }, () => ({
      contents: `const R = window.React;
function jsx(type, props, key) {
  const { children, ...rest } = props || {};
  if (key !== undefined) rest.key = key;
  if (children === undefined) return R.createElement(type, rest);
  return Array.isArray(children) ? R.createElement(type, rest, ...children) : R.createElement(type, rest, children);
}
export { jsx, jsx as jsxs, jsx as jsxDEV };
export const Fragment = R.Fragment;`,
      loader: "js",
    }));
  },
};

/** Story files the bundle carries, keyed by their Storybook title. */
export function storyFiles(kitDir: string): { title: string; file: string }[] {
  const out: { title: string; file: string }[] = [];
  for (const file of [...new Glob("stories/**/*.stories.tsx").scanSync(kitDir)].sort()) {
    const text = readFileSync(join(kitDir, file), "utf8");
    const title = /title:\s*"([^"]+)"/.exec(text)?.[1];
    if (!title || /brain-ui-react|ui-react\//.test(text)) continue;
    out.push({ title, file });
  }
  return out;
}

export async function buildBundle(kitDir: string, projectDir: string, tmpDir: string): Promise<{ components: string[]; titles: string[]; bytes: number }> {
  const stories = storyFiles(kitDir);
  const lines = [
    `import * as Kit from ${JSON.stringify(join(kitDir, "src/index.ts"))};`,
    `import { mountStory, listStories, StoryView } from ${JSON.stringify(join(HERE, "mount.ts"))};`,
    ...stories.map((s, i) => `import * as S${i} from ${JSON.stringify(join(kitDir, s.file))};`),
    `const stories = {${stories.map((s, i) => `${JSON.stringify(s.title)}: S${i}`).join(", ")}};`,
    `window.BrainKit = { ...Kit, __stories: stories, __storyIndex: () => listStories(stories), __mount: (el, title, names) => mountStory(stories, el, title, names), __StoryView: StoryView };`,
  ];
  const entry = join(tmpDir, "bundle-entry.ts");
  await Bun.write(entry, lines.join("\n") + "\n");

  const result = await Bun.build({
    entrypoints: [entry],
    format: "iife",
    minify: true,
    target: "browser",
    conditions: ["bun", "browser", "import", "default"],
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "storybook-shims",
        setup(b) {
          b.onResolve({ filter: /^#\.storybook\/preview$/ }, () => ({ path: join(HERE, "shims/preview.ts") }));
          b.onResolve({ filter: /^storybook\/test$/ }, () => ({ path: join(HERE, "shims/test.ts") }));
        },
      },
      reactGlobals,
    ],
  });
  if (!result.success) throw new AggregateError(result.logs, "bundle build failed");

  const kit = await import(join(kitDir, "src/index.ts"));
  const components = Object.keys(kit).filter((k) => /^[A-Z][a-z]/.test(k)).sort();
  const header = `/* @ds-bundle: ${JSON.stringify({ format: 4, namespace: "BrainKit", components: components.map((name) => ({ name })) })} */\n`;
  const js = header + inlineSafe(await result.outputs[0].text());
  await Bun.write(join(projectDir, "components/bundle.js"), js);
  return { components, titles: stories.map((s) => s.title), bytes: js.length };
}

/** React and ReactDOM at the workspace's installed version, as two classic scripts. */
export async function buildLibs(projectDir: string): Promise<string> {
  for (const name of ["react", "react-dom"] as const) {
    const r = await Bun.build({
      entrypoints: [join(HERE, `lib/${name}.ts`)],
      format: "iife",
      minify: true,
      target: "browser",
      define: { "process.env.NODE_ENV": '"production"' },
      plugins:
        name === "react-dom"
          ? [
              {
                name: "react-global",
                setup(b) {
                  b.onResolve({ filter: /^react$/ }, () => ({ path: "react", namespace: "g" }));
                  b.onLoad({ filter: /.*/, namespace: "g" }, () => ({ contents: "module.exports = window.React;", loader: "js" }));
                },
              },
            ]
          : [],
    });
    if (!r.success) throw new AggregateError(r.logs, `${name} build failed`);
    await Bun.write(join(projectDir, `components/lib/${name}.js`), inlineSafe(await r.outputs[0].text()));
  }
  return (await import("react")).version;
}

/** The kit's precompiled stylesheet, plus the two rules the previews add. */
export async function buildCss(kitDir: string, projectDir: string, tmpDir: string): Promise<void> {
  const out = join(tmpDir, "styles.css");
  const proc = Bun.spawnSync(["bunx", "-p", "@tailwindcss/cli", "tailwindcss", "-i", join(kitDir, "src/styles.css"), "-o", out, "--minify"], {
    cwd: kitDir,
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) throw new Error(`tailwindcss failed: ${proc.stderr.toString()}`);
  const previewRules = `
/* Design System previews only: Storybook's preview-head body rule, and a label per story. */
body.bk-ds-preview{margin:0;padding:16px;background:var(--bk-color-canvas);color:var(--bk-color-ink);font-family:"Plus Jakarta Sans",system-ui,sans-serif}
.bk-ds-preview #root{display:flex;flex-direction:column;gap:22px}
.bk-ds-story{display:flex;flex-direction:column;gap:8px;min-width:0}
.bk-ds-story-name{font:600 9.5px/1 "JetBrains Mono",ui-monospace,monospace;letter-spacing:.09em;text-transform:uppercase;color:var(--bk-color-ink-mute)}
`;
  await Bun.write(join(projectDir, "components/bundle.css"), (await Bun.file(out).text()) + previewRules);
}
