import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installNativeBrainClientFixtures } from "./helpers/native-brain-client-fixture.js";
import { createBrainRoutes } from "../src/routes/brain";
import { completeJsonLines } from "./helpers/json-lines.js";
import { installFakeBrain } from "./helpers/fake-brain-cli";

const { createFixtureBrainClient: createBrainClient } = installNativeBrainClientFixtures();

test("capture keeps partial success and retry runs only index through the actual CLI adapter", async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-capture-outcome-"));
  try {
    const calls = join(root, "calls.jsonl");
    installFakeBrain(root, { argvLog: calls, body: `
      if (process.argv[2] === "add") console.log(JSON.stringify({action:"created",path:"notes/topic.md",title:"Topic",type:"note",indexed:false,indexError:"database is locked"}));
      else if (process.argv[2] === "index") { await Bun.sleep(30); console.log("{}"); }
    ` });
    const app = createBrainRoutes({ brain: createBrainClient({ brainPath: root }), brainPath: root, keyterms: {} as any, exec: {} });
    const saved = await app.request("/brain/add", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "Topic" }) });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ success: true, path: "notes/topic.md", indexed: false, indexError: "database is locked" });
    const retries = await Promise.all(Array.from({ length: 3 }, () => app.request("/brain/index", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })));
    for (const retry of retries) expect(await retry.json()).toEqual({ success: true });
    expect(completeJsonLines<string[]>(calls).map(args => args[0])).toEqual(["add", "index"]);
    const refused = await app.request("/brain/index", { method: "POST" });
    expect(refused.status).toBe(415);
    // A failed index never retries capture, and a later retry is not latched.
    installFakeBrain(root, { body: 'console.error("database is locked");process.exit(2);' });
    expect((await app.request("/brain/index", { method: "POST", headers: { "content-type": "application/json" } })).status).toBe(500);
    installFakeBrain(root, { body: 'console.log("{}");' });
    expect((await app.request("/brain/index", { method: "POST", headers: { "content-type": "application/json" } })).status).toBe(200);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
