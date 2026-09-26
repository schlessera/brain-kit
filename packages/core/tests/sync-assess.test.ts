import { describe, test, expect } from "bun:test";
import { writeFileSync, mkdirSync, readFileSync, renameSync, symlinkSync } from "node:fs";
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
      // Review round 1: a newline in the name is still matched.
      const leftovers = ["photo.jpg:Zone.Identifier", "cv.aux", "cv.synctex.gz", "notes/draft.md~", "line\nbreak.aux", "line\nbreak.jpg:Zone.Identifier"];
      mkdirSync(join(root, "notes"), { recursive: true });
      for (const path of leftovers) writeFileSync(join(root, path), "x");
      const result = await runCli(root, ["sync", "assess", "--json"]);
      expect(result.code).toBe(0);
      const files = JSON.parse(result.stdout).files as { path: string; class: string; status: string }[];
      for (const path of leftovers) expect(files).toContainEqual({ path, class: "ARTIFACT", status: "?" });
    } finally { cleanup(root); }
  });

  describe("media", () => {
    /** A git brain with an optional media block, and the files given. */
    async function assessWith(files: Record<string, number>, media?: string) {
      const root = makeTempBrain();
      try {
        expect(Bun.spawnSync(["git", "-C", root, "init", "-q", "-b", "main"]).exitCode).toBe(0);
        if (media) {
          const config = join(root, "brain.config.ts");
          const text = readFileSync(config, "utf8");
          expect(text).toContain("  taxonomy: {\n");
          writeFileSync(config, text.replace("  taxonomy: {\n", `  media: ${media},\n  taxonomy: {\n`));
        }
        for (const [path, bytes] of Object.entries(files)) {
          mkdirSync(join(root, path, ".."), { recursive: true });
          writeFileSync(join(root, path), Buffer.alloc(bytes, 7));
        }
        const result = await runCli(root, ["sync", "assess", "--json"]);
        expect(result.code, result.stderr).toBe(0);
        return JSON.parse(result.stdout).files as { path: string; class: string; status: string; bytes?: number }[];
      } finally { cleanup(root); }
    }

    test("an untracked 6 MB PNG is LARGE and a 20 KB PNG is MEDIA, each with its size", async () => {
      const files = await assessWith({ "assets/render.png": 6_000_000, "assets/icon.png": 20_000 });
      expect(files).toContainEqual({ path: "assets/render.png", class: "LARGE", status: "?", bytes: 6_000_000 });
      expect(files).toContainEqual({ path: "assets/icon.png", class: "MEDIA", status: "?", bytes: 20_000 });
    });

    test("any file over the limit is LARGE, whatever its kind", async () => {
      const files = await assessWith({ "notes/huge.md": 6_000_000 });
      expect(files).toContainEqual({ path: "notes/huge.md", class: "LARGE", status: "?", bytes: 6_000_000 });
    });

    test("media.ignore makes it ARTIFACT, media.track makes it TRACK, ignore wins over track, and maxTrackedBytes moves the limit", async () => {
      const files = await assessWith(
        { "assets/iterations/v3.png": 6_000_000, "assets/iterations/logo.png": 20_000, "assets/logo.png": 20_000, "assets/cover.png": 2_000 },
        `{ ignore: ["assets/iterations/*"], track: ["logo.png"], maxTrackedBytes: 1000 }`
      );
      expect(files).toContainEqual({ path: "assets/iterations/v3.png", class: "ARTIFACT", status: "?" });
      expect(files).toContainEqual({ path: "assets/logo.png", class: "TRACK", status: "?" });
      // Matched by both: ignore wins.
      expect(files).toContainEqual({ path: "assets/iterations/logo.png", class: "ARTIFACT", status: "?" });
      expect(files).toContainEqual({ path: "assets/cover.png", class: "LARGE", status: "?", bytes: 2_000 });
    });

    // Review round 1: a presentation is media, not an artifact.
    test("a small PPTX is MEDIA and an oversized one LARGE", async () => {
      const files = await assessWith({ "talks/slides.pptx": 20_000, "talks/keynote.pptx": 6_000_000 });
      expect(files).toContainEqual({ path: "talks/slides.pptx", class: "MEDIA", status: "?", bytes: 20_000 });
      expect(files).toContainEqual({ path: "talks/keynote.pptx", class: "LARGE", status: "?", bytes: 6_000_000 });
    });

    test("a symlink is weighed as the link git stores, not its target", async () => {
      const outside = makeTempBrain({ empty: true });
      try {
        writeFileSync(join(outside, "huge.png"), Buffer.alloc(6_000_000, 7));
        const root = makeTempBrain();
        try {
          expect(Bun.spawnSync(["git", "-C", root, "init", "-q", "-b", "main"]).exitCode).toBe(0);
          symlinkSync(join(outside, "huge.png"), join(root, "linked.png"));
          const result = await runCli(root, ["sync", "assess", "--json"]);
          const files = JSON.parse(result.stdout).files as { path: string; class: string }[];
          expect(files.find((f) => f.path === "linked.png")?.class).toBe("UNKNOWN");
        } finally { cleanup(root); }
      } finally { cleanup(outside); }
    });

    test("an artifact pattern wins over LARGE: a 6 MB log is still ARTIFACT", async () => {
      const files = await assessWith({ "build.log": 6_000_000 });
      expect(files).toContainEqual({ path: "build.log", class: "ARTIFACT", status: "?" });
    });

    test("a secret-shaped name stays SENSITIVE even when media.track matches it", async () => {
      const files = await assessWith({ "credentials.png": 20_000 }, `{ track: ["*.png"] }`);
      expect(files).toContainEqual({ path: "credentials.png", class: "SENSITIVE", status: "?" });
    });
  });
});
