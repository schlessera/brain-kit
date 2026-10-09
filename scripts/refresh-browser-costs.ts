/** Explicit reviewed measurement refresh; never called by contribution CI. */
import { resolve } from "node:path";
import { browserCostsFromLogs } from "./browser-shards";

if (import.meta.main) {
  try {
    const [run, attempt] = process.argv.slice(2);
    if (!run || !attempt || !/^\d+$/.test(run) || !/^\d+$/.test(attempt) || process.argv.length !== 4) throw new Error("usage: bun scripts/refresh-browser-costs.ts <run-id> <attempt>");
    const repo = "schlessera/brain-kit";
    const invoke = async (args: string[]): Promise<string> => {
      const child = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (code !== 0) throw new Error(`Measurement evidence unavailable: ${err}`);
      return out;
    };
    const info = JSON.parse(await invoke(["api", `repos/${repo}/actions/runs/${run}/attempts/${attempt}`]));
    const jobs = JSON.parse(await invoke(["api", `repos/${repo}/actions/runs/${run}/attempts/${attempt}/jobs?per_page=100`]));
    const selected = jobs.jobs.filter((job: { name: string }) => job.name.startsWith("browser ("));
    if (selected.length !== 2 || selected.some((job: { conclusion: string }) => job.conclusion !== "success")) throw new Error("Two successful browser jobs are required as evidence");
    const logs = await Promise.all(selected.map((job: { id: number }) => invoke(["api", `repos/${repo}/actions/jobs/${job.id}/logs`, "--allow-escape-sequences"])));
    const checkout = logs.map((log: string) => {
      const lines = log.split("\n"); const at = lines.findIndex(line => line.includes("git log -1 --format=%H"));
      const sha = lines[at + 1]?.trim().split(" ").at(-1);
      if (at < 0 || !sha || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("Actual browser checkout evidence is missing");
      return sha;
    });
    if (new Set(checkout).size !== 1) throw new Error("Browser measurements use different checkouts");
    const commit = JSON.parse(await invoke(["api", `repos/${repo}/git/commits/${checkout[0]}`]));
    const table = { measurement: { head: info.head_sha, checkout: checkout[0], tree: commit.tree.sha,
      parents: commit.parents.map((parent: { sha: string }) => parent.sha), image: "mcr.microsoft.com/playwright:v1.63.0-noble", run: Number(run), attempt: Number(attempt),
      jobs: selected.map((job: { id: number }) => job.id), units: "seconds", aggregation: "median reported project/file elapsed time", unknownSeconds: 1 }, seconds: browserCostsFromLogs(logs) };
    const path = resolve(import.meta.dir, "browser-shard-costs.json");
    await Bun.write(path, JSON.stringify(table, null, 2) + "\n");
    console.log(`Recorded ${Object.keys(table.seconds).length} project/file weights in ${path}`);
  } catch (error) { console.error(error); process.exit(1); }
}
