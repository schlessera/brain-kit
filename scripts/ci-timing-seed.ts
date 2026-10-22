/** Import normalized data from the preceding trusted measurement artifact. */
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TimingClient } from "./ci-timing-api";

export async function seedTimings(api: TimingClient, repository: string, branch: string, since: string, until: string, dir: string) {
  const seed = { run: null as number | null, artifact: null as number | null, snapshots: 0, pulls: 0, error: null as string | null };
  let temp: string | undefined;
  try {
    const runs = await api.json(`actions/workflows/ci-timings.yml/runs?branch=${encodeURIComponent(branch)}&status=completed&per_page=5`);
    if (!Array.isArray(runs.workflow_runs)) throw new Error("Invalid seed run inventory");
    for (const run of runs.workflow_runs.slice(0, 5)) {
      if (run.path !== ".github/workflows/ci-timings.yml" || run.head_branch !== branch ||
        run.status !== "completed" || !["schedule", "workflow_dispatch"].includes(run.event) || !Number.isSafeInteger(run.id)) continue;
      const inventory = await api.json(`actions/runs/${run.id}/artifacts?per_page=100`);
      if (!Array.isArray(inventory.artifacts)) throw new Error("Invalid seed artifact inventory");
      const artifact = inventory.artifacts.find((a: any) => a.name === "ci-timings" && !a.expired && Number.isSafeInteger(a.id));
      if (!artifact) continue;
      seed.run = run.id; seed.artifact = artifact.id;
      temp = await mkdtemp(join(tmpdir(), "ci-timing-seed-"));
      const zip = join(temp, "seed.zip"), extracted = join(temp, "normalized");
      await Bun.write(zip, await api.bytes(`actions/artifacts/${artifact.id}/zip`));
      const command = async (args: string[]) => {
        const child = Bun.spawn(["unzip", ...args], { stdout: "pipe", stderr: "pipe", timeout: 60000 });
        const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        if (code !== 0) throw new Error(`Seed archive unavailable: ${err.trim()}`);
        return out;
      };
      const names = (await command(["-Z1", zip])).trim().split("\n")
        .filter(name => /^(?:run-\d+-attempt-\d+|pull-\d+)\.json$/.test(name));
      if (!names.length || names.length > 20000 || new Set(names).size !== names.length) throw new Error("Empty or invalid normalized seed inventory");
      // Only exact, flat normalized filenames are extracted. No archive path,
      // executable, symlink or other metadata can become collector tooling.
      await command(["-q", zip, ...names, "-d", extracted]);
      for (const name of names) {
        const path = join(extracted, name);
        if (!(await lstat(path)).isFile()) throw new Error("Seed contains a non-file observation");
        const value = await Bun.file(path).json();
        if (value.version !== 1 || value.repository !== repository) throw new Error("Seed repository/version mismatch");
        if (name.startsWith("run-")) {
          if (name !== `run-${value.run?.id}-attempt-${value.run?.attempt}.json` || !Array.isArray(value.jobs) ||
            !Array.isArray(value.problems) || !Number.isFinite(Date.parse(value.run.createdAt))) throw new Error("Invalid seed attempt identity");
          if (Date.parse(value.run.createdAt) < Date.parse(since) || Date.parse(value.run.createdAt) > Date.parse(until)) continue;
          seed.snapshots++;
        } else {
          if (name !== `pull-${value.number}.json` || !Array.isArray(value.problems)) throw new Error("Invalid seed PR identity");
          if (value.closedAt && Date.parse(value.closedAt) < Date.parse(since)) continue;
          seed.pulls++;
        }
        if (!await Bun.file(join(dir, name)).exists()) await Bun.write(join(dir, name), JSON.stringify(value, null, 2) + "\n");
      }
      return seed;
    }
    throw new Error("No retained ci-timings seed artifact on the default branch; collecting without a seed");
  } catch (error) { seed.error = String(error); return seed; }
  finally { if (temp) await rm(temp, { recursive: true, force: true }); }
}
