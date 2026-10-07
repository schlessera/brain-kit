import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { type LoadedModule } from "@schlessera/brain";
import { discoverSkills } from "../../core/src/lib/skills/discover.js";
import { lintSkills } from "../../core/src/lib/skills/lint.js";

import manifest, { configSchema } from "../src/module";

const contribution = manifest.setup(configSchema.parse({}));

const loaded: LoadedModule = {
  key: "@schlessera/brain-module-images",
  manifest: { name: manifest.name, ...contribution },
  dir: resolve(import.meta.dir, ".."),
  config: {},
};

describe("images manifest", () => {
  it("registers the image command and ships its skills", () => {
    expect(manifest.name).toBe("images");
    expect(contribution.commands).toHaveProperty("image");
    expect(contribution.skills).toBe("./skills");
  });

  it("contributes no taxonomy types", () => {
    // Generated images are assets filed wherever the caller puts them; this
    // module owns no directory of its own.
    expect(contribution.taxonomy).toBeUndefined();
  });

  it("defaults the images directory and accepts an override", () => {
    expect(configSchema.parse({}).imagesDir).toBe("assets/images");
    expect(configSchema.parse({ imagesDir: "media" }).imagesDir).toBe("media");
  });

  it("rejects an images directory that escapes the repo", () => {
    expect(() => configSchema.parse({ imagesDir: "../outside" })).toThrow();
  });
});

describe("shipped skills", () => {
  function skills() {
    const { skills, warnings } = discoverSkills(
      { root: mkdtempSync(join(tmpdir(), "brain-images-skills-")), modules: [loaded] },
      { coreSkillsDir: resolve(import.meta.dir, "no-such-core-skills") }
    );
    expect(warnings).toEqual([]);
    expect(skills.length).toBeGreaterThan(0);
    return skills;
  }

  it("ships image-gen", () => {
    expect(skills().map((s) => s.name)).toEqual(["image-gen"]);
  });

  it("passes the lint rules with no errors or warnings", () => {
    const findings = lintSkills(skills()).filter((f) => f.severity !== "info");
    expect(findings).toEqual([]);
  });

  it("describes when to use it, not what it does", () => {
    const offenders = skills()
      .filter((s) => !s.description.startsWith("Use "))
      .map((s) => s.name);
    expect(offenders).toEqual([]);
  });
});
