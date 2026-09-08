/**
 * Skill installation from archives: the shared zip pipeline (frontmatter
 * names, multi-skill archives, zip-slip rejection, conflict/overwrite,
 * builtin protection), GitHub source parsing + zipball flow, and the routes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { zipSync, strToU8 } from "fflate";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  installSkillsFromGitHub,
  installSkillsFromZip,
  InstallError,
  parseGitHubSource,
  unzipWithCaps,
} from "../src/skills/install";
import { resolveGitHubToken } from "../src/config/env";
import { createSkillManager } from "../src/skills/manager";
import { createSkillRoutes } from "../src/routes/skills";

const dirs: string[] = [];
function makeBrain(): string {
  const root = mkdtempSync(join(tmpdir(), "skills-install-"));
  dirs.push(root);
  mkdirSync(join(root, ".agents", "skills"), { recursive: true });
  return root;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SKILL = (name: string) => `---\nname: ${name}\ndescription: Use when testing ${name}.\n---\n\n# ${name}\n`;

function zip(entries: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, strToU8(v)]))
  );
}

describe("installSkillsFromZip", () => {
  test("installs a root-level skill under its frontmatter name", () => {
    const root = makeBrain();
    const outcomes = installSkillsFromZip({ brainPath: root }, zip({
      "SKILL.md": SKILL("my-skill"),
      "helper.ts": "// helper",
    }));
    expect(outcomes).toEqual([{ name: "my-skill", status: "installed", files: 2 }]);
    expect(readFileSync(join(root, ".agents", "skills", "my-skill", "helper.ts"), "utf-8")).toBe(
      "// helper"
    );
  });

  test("installs multiple skills; folder names don't matter, frontmatter does", () => {
    const root = makeBrain();
    const outcomes = installSkillsFromZip({ brainPath: root }, zip({
      "whatever/SKILL.md": SKILL("alpha"),
      "whatever/notes.md": "notes",
      "other/deep/SKILL.md": SKILL("beta"),
    }));
    expect(outcomes.map((o) => `${o.name}:${o.status}`)).toEqual([
      "beta:installed",
      "alpha:installed",
    ]);
    expect(existsSync(join(root, ".agents", "skills", "alpha", "notes.md"))).toBe(true);
    expect(existsSync(join(root, ".agents", "skills", "beta", "SKILL.md"))).toBe(true);
  });

  test("rejects traversal entries outright", () => {
    const root = makeBrain();
    expect(() =>
      installSkillsFromZip({ brainPath: root }, zip({
        "ok/SKILL.md": SKILL("ok"),
        "../evil.md": "boom",
      }))
    ).toThrow(InstallError);
    expect(existsSync(join(root, ".agents", "skills", "ok"))).toBe(false);
  });

  test("skips conflicts by default; overwrite replaces custom (even disabled)", () => {
    const root = makeBrain();
    const manager = createSkillManager(root);
    manager.create("my-skill", SKILL("my-skill"));
    manager.setEnabled("my-skill", false);

    let outcomes = installSkillsFromZip({ brainPath: root }, zip({ "SKILL.md": SKILL("my-skill") }));
    expect(outcomes[0]!.status).toBe("skipped");

    outcomes = installSkillsFromZip(
      { brainPath: root },
      zip({ "SKILL.md": SKILL("my-skill") + "\nv2" }),
      { overwrite: true }
    );
    expect(outcomes[0]!.status).toBe("replaced");
    // The replacement lands ENABLED and the disabled copy is gone.
    expect(existsSync(join(root, ".agents", "skills", "my-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(root, ".agents", "skills-disabled", "my-skill"))).toBe(false);
  });

  test("never overwrites a built-in, even with overwrite: true", () => {
    const root = makeBrain();
    const pkg = join(root, "pkg-skill");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "SKILL.md"), SKILL("add"), "utf-8");
    symlinkSync(pkg, join(root, ".agents", "skills", "add"));

    const outcomes = installSkillsFromZip(
      { brainPath: root },
      zip({ "SKILL.md": SKILL("add") }),
      { overwrite: true }
    );
    expect(outcomes[0]!.status).toBe("skipped");
    expect(outcomes[0]!.reason).toContain("built-in");
  });

  test("bad frontmatter skips that skill, others still install", () => {
    const root = makeBrain();
    const outcomes = installSkillsFromZip({ brainPath: root }, zip({
      "good/SKILL.md": SKILL("good"),
      "bad/SKILL.md": "---\nname: Bad Name!\n---\nno description",
    }));
    expect(outcomes.map((o) => o.status).sort()).toEqual(["installed", "skipped"]);
    expect(existsSync(join(root, ".agents", "skills", "good"))).toBe(true);
  });

  test("archive without any SKILL.md is an error", () => {
    const root = makeBrain();
    expect(() =>
      installSkillsFromZip({ brainPath: root }, zip({ "README.md": "hi" }))
    ).toThrow("No skill found");
  });
});

describe("unzipWithCaps", () => {
  // A tiny archive with a huge inflation ratio stands in for a zip bomb:
  // zeros compress ~1000:1, so the caps must trip during decompression,
  // long before the full payload could materialize.
  const bombish = zipSync({
    "SKILL.md": strToU8(SKILL("bomb")),
    "big.bin": new Uint8Array(4 * 1024 * 1024), // zeros, compresses to ~4KB
  });

  test("per-file cap aborts during decompression", () => {
    expect(() =>
      unzipWithCaps(bombish, { maxFileBytes: 1024 * 1024, maxInflatedBytes: 250 * 1024 * 1024 })
    ).toThrow("big.bin exceeds 1MB.");
  });

  test("total inflated cap aborts during decompression", () => {
    expect(() =>
      unzipWithCaps(bombish, { maxFileBytes: 10 * 1024 * 1024, maxInflatedBytes: 2 * 1024 * 1024 })
    ).toThrow("inflates past the 2MB cap");
  });

  test("archive within caps round-trips all entries", () => {
    const entries = unzipWithCaps(bombish);
    expect(Object.keys(entries).sort()).toEqual(["SKILL.md", "big.bin"]);
    expect(entries["big.bin"]!.length).toBe(4 * 1024 * 1024);
  });

  test("garbage is a readable InstallError, not an fflate throw", () => {
    expect(() => unzipWithCaps(strToU8("not a zip at all"))).toThrow(InstallError);
  });
});

describe("resolveGitHubToken", () => {
  test("specialized token wins, generic is the fallback", () => {
    expect(
      resolveGitHubToken({ BRAIN_UI_SKILLS_GITHUB_TOKEN: "skills", GITHUB_TOKEN: "generic" })
    ).toBe("skills");
    expect(resolveGitHubToken({ GITHUB_TOKEN: "generic" })).toBe("generic");
    expect(resolveGitHubToken({})).toBeUndefined();
  });
});

describe("parseGitHubSource", () => {
  test("accepts the supported spellings", () => {
    expect(parseGitHubSource("owner/repo")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseGitHubSource("https://github.com/owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
    });
    expect(parseGitHubSource("https://github.com/owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
    });
    expect(parseGitHubSource("https://github.com/owner/repo/tree/main/skills/foo")).toEqual({
      owner: "owner",
      repo: "repo",
      ref: "main",
      subpath: "skills/foo",
    });
  });

  test("rejects non-GitHub and junk", () => {
    expect(parseGitHubSource("https://gitlab.com/o/r")).toBeNull();
    expect(parseGitHubSource("not a repo")).toBeNull();
    expect(parseGitHubSource("https://github.com/only-owner")).toBeNull();
  });
});

describe("installSkillsFromGitHub", () => {
  function zipballFor(entries: Record<string, string>): Uint8Array {
    // GitHub zipballs wrap everything in `owner-repo-sha/`.
    const wrapped = Object.fromEntries(
      Object.entries(entries).map(([k, v]) => [`owner-repo-abc123/${k}`, strToU8(v)])
    );
    return zipSync(wrapped);
  }

  test("fetches the zipball, strips the wrapper, honors the subpath", async () => {
    const root = makeBrain();
    const seen: { url?: string; auth?: string | null } = {};
    const fetcher = async (url: string, init?: RequestInit) => {
      seen.url = url;
      seen.auth = new Headers(init?.headers).get("authorization");
      return new Response(Buffer.from(zipballFor({
        "skills/alpha/SKILL.md": SKILL("alpha"),
        "elsewhere/beta/SKILL.md": SKILL("beta"),
      })));
    };
    const outcomes = await installSkillsFromGitHub(
      { brainPath: root },
      { owner: "owner", repo: "repo", ref: "main", subpath: "skills" },
      { token: "tok-123", fetcher }
    );
    expect(seen.url).toBe("https://api.github.com/repos/owner/repo/zipball/main");
    expect(seen.auth).toBe("Bearer tok-123");
    expect(outcomes).toEqual([{ name: "alpha", status: "installed", files: 1 }]);
    expect(existsSync(join(root, ".agents", "skills", "beta"))).toBe(false);
  });

  test("404 without a token explains the private-repo case", async () => {
    const root = makeBrain();
    const fetcher = async () => new Response("nope", { status: 404 });
    await expect(
      installSkillsFromGitHub({ brainPath: root }, { owner: "o", repo: "r" }, { fetcher })
    ).rejects.toThrow("GITHUB_TOKEN");
  });
});

describe("install routes", () => {
  test("zip upload end to end (multipart), sync runs once", async () => {
    const root = makeBrain();
    let syncs = 0;
    const app = createSkillRoutes({
      brainPath: root,
      syncSkills: async () => {
        syncs++;
        return "ok";
      },
    });
    const form = new FormData();
    form.append(
      "file",
      new File([Buffer.from(zip({ "SKILL.md": SKILL("uploaded") }))], "skill.zip", {
        type: "application/zip",
      })
    );
    form.append("overwrite", "false");
    const res = await app.request("/skills/install/zip", { method: "POST", body: form });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      outcomes: Array<{ name: string; status: string; files?: number }>;
    };
    expect(body.outcomes).toEqual([{ name: "uploaded", status: "installed", files: 1 }]);
    expect(syncs).toBe(1);
  });

  test("github route validates the source and uses the token seam", async () => {
    const root = makeBrain();
    const app = createSkillRoutes({
      brainPath: root,
      syncSkills: async () => "ok",
      githubToken: () => "seam-token",
      fetcher: async (_url, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer seam-token");
        return new Response(
          Buffer.from(zipSync({ "wrap/x/SKILL.md": strToU8(SKILL("from-github")) }))
        );
      },
    });

    let res = await app.request("/skills/install/github", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "https://gitlab.com/o/r" }),
    });
    expect(res.status).toBe(400);

    res = await app.request("/skills/install/github", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "owner/repo" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcomes: Array<{ name: string }> };
    expect(body.outcomes[0]!.name).toBe("from-github");
  });
});
