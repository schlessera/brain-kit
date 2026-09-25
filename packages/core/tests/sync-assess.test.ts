import { describe, test, expect } from "bun:test";
import { writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { makeTempBrain, cleanup, runCli } from "./cli-harness";

describe("sync exact paths", () => {
  test("preserves modified, renamed, Unicode, newline and arrow paths", async () => {
    const root = makeTempBrain();
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", "-C", root, ...args]);
      expect(result.exitCode).toBe(0);
    };
    try {
      git("init", "-q", "-b", "main");
      git("config", "user.name", "Alex Example");
      git("config", "user.email", "alex@example.test");
      writeFileSync(join(root, "credentials.json"), "{}\n");
      writeFileSync(join(root, "old.md"), "rename body\n");
      git("add", "credentials.json", "old.md");
      git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
      writeFileSync(join(root, "credentials.json"), '{"fixture":true}\n');
      renameSync(join(root, "old.md"), join(root, "new -> note.md"));
      git("add", "old.md", "new -> note.md");
      const names = ["résumé.md", "line\nbreak.md", "-option.md", "quote\"note.md"];
      for (const name of names) writeFileSync(join(root, name), "note");
      mkdirSync(join(root, "new-folder"));
      writeFileSync(join(root, "new-folder/credentials.json"), "{}");
      const result = await runCli(root, ["sync", "assess", "--json"]);
      expect(result.code).toBe(0);
      const body = JSON.parse(result.stdout);
      expect(body.files).toContainEqual({ path: "credentials.json", class: "SENSITIVE", status: "M" });
      expect(body.files).toContainEqual({ path: "new-folder/credentials.json", class: "SENSITIVE", status: "?" });
      expect(body.files).toContainEqual({ path: "new -> note.md", class: "TRACK", status: "R" });
      for (const path of names) expect(body.files).toContainEqual({ path, class: "TRACK", status: "?" });
      const grouped = JSON.parse((await runCli(root, ["sync", "group", "--json"])).stdout);
      expect(grouped.groups.some((g: { path: string }) => g.path.includes("credentials"))).toBe(false);
    } finally { cleanup(root); }
  });

  test("classifies tool leftovers as ARTIFACT", async () => {
    const root = makeTempBrain();
    try {
      expect(Bun.spawnSync(["git", "-C", root, "init", "-q", "-b", "main"]).exitCode).toBe(0);
      const leftovers = ["photo.jpg:Zone.Identifier", "cv.aux", "cv.synctex.gz", "notes/draft.md~"];
      mkdirSync(join(root, "notes"), { recursive: true });
      for (const path of leftovers) writeFileSync(join(root, path), "x");
      const result = await runCli(root, ["sync", "assess", "--json"]);
      expect(result.code).toBe(0);
      const files = JSON.parse(result.stdout).files as { path: string; class: string; status: string }[];
      for (const path of leftovers) expect(files).toContainEqual({ path, class: "ARTIFACT", status: "?" });
    } finally { cleanup(root); }
  });
});
