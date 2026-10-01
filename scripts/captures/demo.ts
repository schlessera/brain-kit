import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { rankingJourneys } from "../../packages/ui-kit/fixtures/ranking.ts";
import { awaitFonts, awaitStory, capturePage, inspectPng, visibleText } from "./browser.ts";
import type { Catalogue, DemoRecipe, Viewport } from "./catalogue.ts";
import { sha256,variantFile } from "./provenance.ts";

/** A single approved gesture, sampled deterministically; no general video editor. */
export async function captureDemo(browser: Browser, root: string, cache: string, catalogue: Catalogue,
  origin: string, recipe: DemoRecipe, output: string, theme = recipe.theme, viewportOverride?: Viewport,
): Promise<{ files: Array<{ file: string; bytes: number; sha256: string }>; evidence: Record<string, unknown> }> {
  if (recipe.id !== "rank-five-reorder") throw new Error(`${recipe.id}: no approved gesture implementation`);
  const viewport=viewportOverride ?? recipe.viewport;
  const { context, page, faults } = await capturePage(browser, root, cache, catalogue, [origin], viewport, theme);
  try {
    await awaitStory(page, origin, recipe.source.story_id, theme);
    const fonts = await awaitFonts(page, catalogue);
    const expected = rankingJourneys.slice(0, 5).map((entry) => entry.label);
    const expectedIds=rankingJourneys.slice(0,5).map((entry)=>entry.id);
    const rowIds=()=>page.locator("[data-rank-row]").evaluateAll((rows)=>rows.map((row)=>row.getAttribute("data-rank-row")));
    if(JSON.stringify(await rowIds())!==JSON.stringify(expectedIds))throw new Error("Actual five-choice fixture IDs are missing");
    const labels = () => page.locator("[data-rank-pick]").allTextContents();
    const before = await labels();
    if (before.length !== 5 || before.some((label, i) => !label.includes(expected[i]))) throw new Error("Actual five-choice fixture order is missing");
    const missing = await visibleText(page, "#storybook-root", expected, { x: 0, y: 0, ...viewport }, true);
    if (missing.length) throw new Error(`Ranking labels are not visible: ${missing.join(", ")}`);
    const handle = await page.getByRole("button", { name: `Reorder ${expected[2]}, position 3 of 5`, exact: true }).boundingBox();
    const destination = await page.locator("[data-rank-row]").first().boundingBox();
    if (!handle || !destination) throw new Error("Actual drag handle/destination is missing");
    const start = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
    const end = { x: destination.x + destination.width / 2, y: destination.y + destination.height / 2 };
    const fps = 12, count = Math.round(recipe.duration_seconds * fps);
    const hashes: string[] = [];
    const encodingFrames: Buffer[] = [];
    let beforeBytes!: Buffer, afterBytes!: Buffer;
    for (let frame = 0; frame < count; frame++) {
      if (frame === fps) { await page.mouse.move(start.x, start.y); await page.mouse.down(); }
      if (frame >= 2 * fps && frame < 3 * fps) {
        const fraction = (frame - 2 * fps + 1) / fps;
        await page.mouse.move(start.x + (end.x - start.x) * fraction, start.y + (end.y - start.y) * fraction);
      }
      if (frame === 3 * fps) {
        await page.mouse.up();
        await page.getByRole("button", { name: `Reorder ${expected[2]}, position 1 of 5`, exact: true }).waitFor();
        await page.getByText(`${expected[2]} moved to 1 of 5.`, { exact: true }).waitFor();
        const after = await labels();
        if(JSON.stringify(await rowIds())!==JSON.stringify([expectedIds[2],expectedIds[0],expectedIds[1],...expectedIds.slice(3)]))throw new Error("Drag did not preserve all five fixture IDs");
        const reordered = [expected[2], expected[0], expected[1], ...expected.slice(3)];
        if (after.length !== 5 || after.some((label, i) => !label.includes(reordered[i]))) throw new Error("Drag did not preserve and reorder all five choices");
      }
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
      const bytes = await page.screenshot({ animations: "disabled" });
      const pixels = inspectPng(bytes);
      if (pixels.width !== viewport.width || pixels.height !== viewport.height) throw new Error("Ranking frame dimensions differ");
      hashes.push(pixels.sha256);
      if (frame === 0) beforeBytes = bytes;
      if (frame === count - 1) afterBytes = bytes;
      encodingFrames.push(await page.screenshot({ type:"jpeg",quality:100,animations:"disabled" }));
    }
    if (sha256(beforeBytes) === sha256(afterBytes)) throw new Error("Drag before/after pixels are identical");
    if (faults.length) throw new Error(faults.join("; "));
    const file = (name:string)=>variantFile(name,recipe.theme,theme,viewportOverride);
    const video = file(recipe.output);
    const ffmpegDirectory = (await readdir("/ms-playwright")).filter((name) => /^ffmpeg-\d+$/.test(name));
    if (ffmpegDirectory.length !== 1) throw new Error("Expected one image-provided FFmpeg binary");
    const ffmpeg = resolve("/ms-playwright", ffmpegDirectory[0], "ffmpeg-linux");
    execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-vcodec", "mjpeg", "-framerate", String(fps), "-i", "pipe:0", "-c:v", "libvpx", "-threads", "1", "-deadline", "best", "-b:v", "0", "-crf", "20", "-an", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-y", resolve(output, video)], { timeout: 60_000,input:Buffer.concat(encodingFrames) });
    const beforeFile = file(recipe.fallback.before), afterFile = file(recipe.fallback.after);
    await writeFile(resolve(output, beforeFile), beforeBytes); await writeFile(resolve(output, afterFile), afterBytes);
    const files = await Promise.all([video, beforeFile, afterFile].map(async (file) => {
      const bytes = await readFile(resolve(output, file));
      if (!bytes.length) throw new Error(`Empty gesture output: ${file}`);
      return { file, bytes: bytes.length, sha256: sha256(bytes) };
    }));
    return { files, evidence: { fps, frames: count, duration_seconds: count / fps, frame_sha256: hashes,
      fonts,initial_ids:expectedIds,final_ids:[expectedIds[2],expectedIds[0],expectedIds[1],...expectedIds.slice(3)], initial_order: expected, final_order: [expected[2], expected[0], expected[1], ...expected.slice(3)],
      encoding_frame_sha256: encodingFrames.map(sha256), ffmpeg_sha256: sha256(await readFile(ffmpeg)), submission: "untouched" } };
  } catch (error) { throw new Error(`${recipe.id}: ${(error as Error).message}`); }
  finally { await context.close(); }
}
