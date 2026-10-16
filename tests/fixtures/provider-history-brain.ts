import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function git(brain: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", brain, ...args], { env: { PATH: process.env.PATH!, HOME: process.env.HOME!,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Odysseus", GIT_COMMITTER_NAME: "Odysseus",
    GIT_AUTHOR_EMAIL: "odysseus@example.com", GIT_COMMITTER_EMAIL: "odysseus@example.com",
    GIT_AUTHOR_DATE: "2026-07-12T00:00:00Z", GIT_COMMITTER_DATE: "2026-07-12T00:00:00Z" } });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}
export function fixtureBrain(scratch: string, scenario: string): string {
  const brain = join(scratch, scenario);
  cpSync(resolve("packages/core/fixtures/corpus"), brain, { recursive: true });
  const config = join(brain, "brain.config.ts");
  writeFileSync(config, readFileSync(config, "utf8").replace('"@schlessera/brain"', JSON.stringify(resolve("packages/core/src/index.ts"))));
  mkdirSync(join(brain, "notes"), { recursive: true });
  writeFileSync(join(brain, "notes/raft.md"), "---\ntype: note\n---\nOdysseus repairs the raft.\n");
  writeFileSync(join(brain, ".gitignore"), ".brain/\n.brain-kit-ui/\nworkspaces/\nbrain.db*\n");
  git(brain, "init", "-b", "main"); git(brain, "add", "."); git(brain, "commit", "-m", "Odysseus prepares the voyage");
  return brain;
}
export function changeRepository(brain: string, turn: number): void {
  writeFileSync(join(brain, "notes/raft.md"), `Odysseus repairs mast ${turn}.\n`);
  git(brain, "add", "notes/raft.md"); git(brain, "commit", "-m", `Odysseus repairs mast ${turn}`);
  writeFileSync(join(brain, `sail-${turn}.md`), "Athena checks the sail.\n");
}
