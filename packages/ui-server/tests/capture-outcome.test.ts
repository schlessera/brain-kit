import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrainClient } from "../src/brain/client";
import { createBrainRoutes } from "../src/routes/brain";

test("capture keeps partial success and retry runs only index through the actual CLI adapter", async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-capture-outcome-"));
  try {
    mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
    const bin = join(root, "node_modules/.bin/brain");
    const calls = join(root, "calls.jsonl");
    writeFileSync(bin, `#!/usr/bin/env bun\nimport {appendFileSync} from "node:fs";
      appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
      if (process.argv[2] === "add") console.log(JSON.stringify({action:"created",path:"notes/topic.md",title:"Topic",type:"note",indexed:false,indexError:"database is locked"}));
      else if (process.argv[2] === "index") { await Bun.sleep(30); console.log("{}"); }
    `);
    chmodSync(bin, 0o755);
    const app = createBrainRoutes({ brain: createBrainClient({ brainPath: root }), brainPath: root, keyterms: {} as any, exec: {} });
    const saved = await app.request("/brain/add", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "Topic" }) });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ success: true, path: "notes/topic.md", indexed: false, indexError: "database is locked" });
    const retries = await Promise.all(Array.from({ length: 3 }, () => app.request("/brain/index", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })));
    for (const retry of retries) expect(await retry.json()).toEqual({ success: true });
    expect(readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line)[0])).toEqual(["add", "index"]);
    const refused = await app.request("/brain/index", { method: "POST" });
    expect(refused.status).toBe(415);
    // A failed index never retries capture, and a later retry is not latched.
    writeFileSync(bin, '#!/usr/bin/env bun\nconsole.error("database is locked");process.exit(2);\n');
    expect((await app.request("/brain/index", { method: "POST", headers: { "content-type": "application/json" } })).status).toBe(500);
    writeFileSync(bin, '#!/usr/bin/env bun\nconsole.log("{}");\n');
    expect((await app.request("/brain/index", { method: "POST", headers: { "content-type": "application/json" } })).status).toBe(200);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
