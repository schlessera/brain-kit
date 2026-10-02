/** #525: resolve a local geo artifact before the actual network-denied document export. */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { delimiter, join } from "node:path";
import sharp from "sharp";
import { BRAIN_BIN, cleanup, keylessEnv, makeTempBrain, runCli } from "../packages/core/tests/cli-harness.js";
import type { GeoRenderReceipt } from "./helpers/geo-render-observer.js";

const chromePath = [process.env.PUPPETEER_EXECUTABLE_PATH, process.env.BRAIN_UI_CHROME_PATH,
  "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
  .find(path => path && existsSync(path) && statSync(path).isFile());
if (!chromePath && process.env.BRAIN_REQUIRE_CHROME === "1") throw new Error("BRAIN_REQUIRE_CHROME=1, but Chrome/Chromium was not found.");

async function colors(png: Buffer): Promise<Map<string, number>> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const counts = new Map<string, number>();
  for (let at = 0; at < data.length; at += info.channels) {
    const rgb = [data[at]!, data[at + 1]!, data[at + 2]!];
    if (Math.max(...rgb) - Math.min(...rgb) < 40) continue;
    const key = rgb.join(","); counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

describe.skipIf(!chromePath)("a resolved geo map in actual brain render and Chrome", () => {
  test("draws the exact local PNG into PNG and PDF with no network request or allowed host", async () => {
    const root = makeTempBrain({ empty: true });
    const source = '<gpx version="1.1"><trk><trkseg><trkpt lat="38.36" lon="20.72"/><trkpt lat="38.37" lon="20.73"/></trkseg></trk></gpx>';
    try {
      writeFileSync(join(root, "brain.config.json"), "{}");
      writeFileSync(join(root, "walk.gpx"), source);
      const map = await runCli(root, ["geo", "map", "walk.gpx", "--no-background", "--width", "320", "--out", "map.png", "--json"]);
      expect(map.code).toBe(0); const evidence = JSON.parse(map.stdout);
      expect(evidence.tracks[0].summary.geometry[0]).toHaveLength(2);
      const local = readFileSync(join(root, "map.png")), hash = createHash("sha256").update(local).digest("hex");
      const width = local.readUInt32BE(16), height = local.readUInt32BE(20);
      expect(width).toBe(320); expect(height).toBeGreaterThan(200);
      const ink = [...await colors(local)].sort((a, b) => b[1] - a[1])[0]!;
      expect(ink[1]).toBeGreaterThan(100);
      // All file reads and geo resolution finish here, before the document renderer starts.
      const document = `<!doctype html><html><head><title>Resolved walk</title></head><body><img src="data:image/png;base64,${local.toString("base64")}" alt="Resolved walk map" width="${width}" height="${height}"></body></html>`;
      writeFileSync(join(root, "resolved.html"), document);
      // Chrome's installed wrapper needs these utilities; keep the CLI's host-account isolation.
      const tools = join(root, "browser-tools"); mkdirSync(tools);
      for (const name of ["readlink", "dirname", "cat"]) {
        const executable = Bun.which(name); if (executable) symlinkSync(executable, join(tools, name));
      }
      const env = keylessEnv(root);
      for (const format of ["png", "pdf"] as const) {
        const receiptPath = join(root, `${format}-receipt.json`);
        const proc = Bun.spawn([process.execPath, "--preload", join(import.meta.dir, "helpers/geo-render-observer.ts"), BRAIN_BIN,
          "render", "resolved.html", "--format", format, "--width", "768", "--out", `document.${format}`, "--json"], {
          env: { ...env, PATH: env.PATH + delimiter + tools, PUPPETEER_EXECUTABLE_PATH: chromePath!, BRAIN_CHROME_NO_SANDBOX: "1", GEO_RENDER_TEST_RECEIPT: receiptPath },
          stdout: "pipe", stderr: "pipe", stdin: "ignore",
        });
        const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        expect(stderr).toBe(""); expect(code).toBe(0);
        const result = JSON.parse(stdout), receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as GeoRenderReceipt;
        // First check proves the listener heard this artifact; an empty observer cannot prove no traffic.
        expect(receipt.inlineImages).toContain(hash);
        expect(receipt.otherRequests).toEqual([]); expect(result.allowHosts).toEqual([]);
        expect(receipt.launchArgs).toHaveLength(1);
        expect(receipt.launchArgs[0]).toContain("--host-resolver-rules=MAP * ~NOTFOUND");
        const output = readFileSync(join(root, `document.${format}`)); expect(result.bytes).toBe(output.length);
        if (format === "png") {
          expect(output.subarray(1, 4).toString()).toBe("PNG");
          // Actual bitmap pixels retain the source's colored track, not only a requested image URL.
          expect((await colors(output)).get(ink[0]) ?? 0).toBeGreaterThan(100);
        } else {
          const pdf = output.toString("latin1"); expect(pdf.startsWith("%PDF")).toBe(true);
          const imageHeaders = [...pdf.matchAll(/\d+ 0 obj\s*<<([\s\S]*?)>>\s*stream/g)].map(match => match[1]!)
            .filter(header => /\/Subtype\s*\/Image\b/.test(header));
          expect(imageHeaders.some(header => new RegExp(`/Width ${width}\\b`).test(header) && new RegExp(`/Height ${height}\\b`).test(header))).toBe(true);
          expect(result.pages).toBeGreaterThan(0);
        }
      }
      expect(readFileSync(join(root, "walk.gpx"), "utf8")).toBe(source);
      expect(readFileSync(join(root, "map.png"))).toEqual(local);
      expect(existsSync(join(root, "brain.db"))).toBe(false);
    } finally { cleanup(root); }
  }, 120_000);
});
