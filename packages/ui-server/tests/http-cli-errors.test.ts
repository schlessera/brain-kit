import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { version } from "@schlessera/brain-ui-server/package.json";
import { httpContractApp } from "./helpers/http-contract-app";

test("mounted corpus handlers preserve CLI failures and sync terminates with an unsuccessful SSE frame", async () => {
  const t = await httpContractApp();
  try {
    const before = await t.fetch("/api/brain/list");
    expect(before.status).toBe(200);
    expect((await before.json()).results).toHaveLength(1);
    writeFileSync(join(t.brainPath, "node_modules", ".bin", "brain"),
      `#!${process.execPath}\nif (process.argv.includes("--version")) console.log(${JSON.stringify(version)});\nelse { console.error("Fixture CLI unavailable"); process.exit(1); }\n`,
      { mode: 0o755 });
    for (const [method, path, body] of [
      ["GET", "/api/brain/search?q=harbor", undefined],
      ["GET", "/api/brain/list", undefined],
      ["GET", "/api/brain/briefing", undefined],
      ["GET", "/api/brain/stats", undefined],
      ["GET", "/api/brain/stats/history", undefined],
      ["POST", "/api/brain/add", JSON.stringify({ content: "Odysseus reaches the harbor." })],
      ["POST", "/api/brain/index", "ignored input"],
    ] as const) {
      const response = await t.fetch(path, { method, headers: { "content-type": "application/json" }, body });
      expect({ path, status: response.status }).toEqual({ path, status: 500 });
      expect((await response.json()).error).toContain("Fixture CLI unavailable");
    }
    const sync = await t.fetch("/api/brain/sync", { method: "POST", body: "ignored input" });
    expect(sync.status).toBe(200);
    expect(sync.headers.get("content-type")).toContain("text/event-stream");
    const frames = (await sync.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.some((frame) => frame.type === "progress" && frame.text.includes("Fixture CLI unavailable"))).toBe(true);
    expect(frames.at(-1)).toMatchObject({ type: "done", success: false });
  } finally { await t.close(); }
});
