/**
 * Mounts every bundled story file the way a preview card will, in headless
 * Chromium and in both Dark and Paper, and reports what failed.
 *
 * It is also how the build learns each file's story names and rendered
 * height: those exist only once the stories run, and the cards need both.
 * Fonts load from Google Fonts, as they do in the artifact, so this step needs
 * the network for type metrics; a missing font changes heights, not results.
 */
import { chromium } from "playwright";
import { join } from "path";

export interface CheckResult {
  index: Record<string, string[]>;
  heights: Record<string, number>;
  failures: { title: string; theme: string; errors: string[]; empty: string[]; height: number }[];
  checked: number;
}

export async function checkStories(projectDir: string): Promise<CheckResult> {
  const read = (f: string) => Bun.file(join(projectDir, f)).text();
  const head = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Serif+Text:ital@0;1&family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap">
<style>${await read("components/bundle.css")}</style>
<script>${await read("components/lib/react.js")}</script>
<script>${await read("components/lib/react-dom.js")}</script>
<script>${await read("components/bundle.js")}</script>`;
  const doc = (theme: string) => `<!doctype html><html data-theme="${theme}"><head>${head}</head><body class="bk-ds-preview"><div id="root"></div></body></html>`;

  const browser = await chromium.launch();
  try {
    const probe = await browser.newPage();
    await probe.setContent(doc("dark"));
    const index: Record<string, string[]> = await probe.evaluate(() => (window as any).BrainKit.__storyIndex());
    await probe.close();

    const heights: Record<string, number> = {};
    const failures: CheckResult["failures"] = [];
    let checked = 0;
    for (const [title, names] of Object.entries(index)) {
      for (const theme of ["dark", "light"]) {
        const errors: string[] = [];
        const page = await browser.newPage({ viewport: { width: 760, height: 900 } });
        page.on("pageerror", (e) => errors.push(e.message.slice(0, 200)));
        page.on("console", (m) => {
          if (m.type() === "error") errors.push(m.text().slice(0, 200));
        });
        await page.setContent(doc(theme));
        await page
          .evaluate(([t, n]) => (window as any).BrainKit.__mount(document.getElementById("root"), t, n), [title, names] as const)
          .catch((e: unknown) => errors.push(String(e)));
        await page.waitForTimeout(150);
        const height = await page.evaluate(() => Math.round(document.getElementById("root")!.getBoundingClientRect().height));
        const empty = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>(".bk-ds-story")].filter((s) => s.getBoundingClientRect().height < 12).map((s) => s.dataset.story ?? "")
        );
        if (theme === "dark") heights[title] = height;
        if (errors.length || empty.length || height < 20) failures.push({ title, theme, errors: [...new Set(errors)].slice(0, 3), empty, height });
        checked++;
        await page.close();
      }
    }
    return { index, heights, failures, checked };
  } finally {
    await browser.close();
  }
}
