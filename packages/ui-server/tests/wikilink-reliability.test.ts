import { expect, test, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWikilinkMap } from "../src/files/walker";
import { createFilesRoutes } from "../src/routes/files";

test("wikilinks visit a directory once despite cycles and repeated aliases", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "brain-wiki-cycles-"));
  try {
    await fs.writeFile(join(root, "topic.md"), "topic");
    await fs.writeFile(join(root, "constructor.md"), "ordinary filename");
    await fs.symlink(".", join(root, "a"));
    await fs.symlink(".", join(root, "b"));
    await fs.mkdir(join(root, "notes"));
    await fs.writeFile(join(root, "notes/other.md"), "other");
    await fs.symlink("..", join(root, "notes/back"));
    await fs.symlink("notes", join(root, "alias"));
    const map = await buildWikilinkMap(root);
    expect(map.topic).toBe("topic.md");
    expect(map["constructor"]).toBe("constructor.md");
    expect(Object.keys(map).sort()).toEqual(["constructor", "other", "topic"]);
    expect(await fs.readFile(join(root, map.other), "utf8")).toBe("other");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("concurrent refresh requests share one traversal and a later refresh rebuilds", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "brain-wiki-cache-"));
  await fs.writeFile(join(root, "topic.md"), "topic");
  const read = spyOn(fs, "readdir");
  try {
    const app = createFilesRoutes({ brainRoot: root });
    const responses = await Promise.all(Array.from({ length: 8 }, () => app.request("/files/wikilinks?refresh=1")));
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect((await res.json()).slugs).toEqual({ topic: "topic.md" });
    }
    expect(read.mock.calls.filter(([path]) => path === root)).toHaveLength(1);
    await fs.writeFile(join(root, "new.md"), "new");
    const refreshed = await app.request("/files/wikilinks?refresh=1");
    expect((await refreshed.json()).count).toBe(2);
    expect(read.mock.calls.filter(([path]) => path === root)).toHaveLength(2);
  } finally { read.mockRestore(); await fs.rm(root, { recursive: true, force: true }); }
});
