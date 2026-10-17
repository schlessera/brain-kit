/** Explicit reviewed measurement refresh; never called by contribution CI. */
import { resolve } from "node:path";
import { browserCostsFromLogs, browserTimingReports, type BrowserCosts } from "./browser-shards";
import { browserPinUsesProducer, parseBrowserPin, resolveBrowserPin } from "./captures/provenance";
import type { API } from "./proof-reuse";

type Domain = "browser" | "layout";
type CostTable = BrowserCosts & { measurement?: unknown; measurements?: Partial<Record<Domain, unknown>> };
const SHA = /^[a-f0-9]{40}$/;
const layoutKey = (key: string) => key.startsWith("ui-react-layout::");
const cleanLog = (log: string) => log.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");

/** Admit complete successful measurements only; retained proof is not a timing source. */
export async function refreshBrowserCosts(domain: Domain, run: number, attempt: number,
  previous: CostTable, image: string, api: API): Promise<CostTable> {
  const info = await api.json(`actions/runs/${run}/attempts/${attempt}`);
  if (info.id !== run || info.run_attempt !== attempt || info.status !== "completed" || info.conclusion !== "success" ||
      info.path !== ".github/workflows/ci.yml" || info.repository?.full_name !== "schlessera/brain-kit" ||
      !["push", "pull_request", "workflow_dispatch", "schedule"].includes(info.event) || !SHA.test(info.head_sha)) throw new Error("A successful attributed CI run/attempt is required");
  const page = await api.json(`actions/runs/${run}/attempts/${attempt}/jobs?per_page=100`);
  if (!Array.isArray(page.jobs) || page.total_count !== page.jobs.length ||
      page.jobs.filter((job: any) => typeof job.name === "string" && job.name.startsWith(`${domain} (`)).length !== 2) throw new Error("Incomplete job inventory");
  const selected = [1, 2].map(shard => {
    const matches = page.jobs.filter((job: any) => job.name === `${domain} (${shard})`);
    const job = matches[0];
    if (matches.length !== 1 || !Number.isSafeInteger(job.id) || job.id <= 0 || job.run_id !== run || job.head_sha !== info.head_sha ||
        job.status !== "completed" || job.conclusion !== "success" ||
        !job.steps?.some((step: any) => step.name === `Complete ${domain} proof` && step.status === "completed" && step.conclusion === "success")) throw new Error("Two fresh successful domain jobs are required");
    return job;
  });
  if (selected[0].id === selected[1].id) throw new Error("Duplicate job identity");
  const logs = await Promise.all(selected.map(job => api.log(job.id)));
  const identities: string[] = [], keys = new Set<string>();
  let inventorySize: number | undefined;
  for (const [index, raw] of logs.entries()) {
    const log = cleanLog(raw);
    const checkoutRows = [...log.matchAll(/git log -1 --format=%H[^\n]*\n[^\n]*? ([a-f0-9]{40})\s*(?:\n|$)/g)];
    if (checkoutRows.length !== 1) throw new Error("Actual checkout evidence is missing or ambiguous");
    identities.push(checkoutRows[0]![1]!);
    const images = [...log.matchAll(/Status: (?:Downloaded newer image|Image is up to date) for ([^\s]+)/g)].map(match => match[1]);
    if (images.length !== 1 || images[0] !== image) throw new Error("Pinned execution image evidence is missing or mismatched");
    const partitions = [...log.matchAll(/Measured browser shard ([12])\/2: (\d+)\/(\d+) specs;/g)];
    const summaries = [...log.matchAll(/Test Files\s+(\d+) passed \((\d+)\)/g)];
    const reports = browserTimingReports(raw);
    const partition = partitions[0], summary = summaries[0];
    if (partitions.length !== 1 || summaries.length !== 1 || Number(partition![1]) !== index + 1 ||
        Number(summary![1]) !== Number(summary![2]) || Number(partition![2]) !== reports.length ||
        reports.length !== Number(summary![1]) || reports.length === 0) throw new Error("Incomplete successful spec timing inventory");
    const total = Number(partition![3]);
    if (inventorySize !== undefined && inventorySize !== total) throw new Error("Mismatched discovered inventories");
    inventorySize = total;
    for (const report of reports) {
      if (report.key.startsWith("ui-react-endurance::") || layoutKey(report.key) !== (domain === "layout") || keys.has(report.key)) throw new Error("Wrong domain or duplicate project/file attribution");
      keys.add(report.key);
    }
  }
  if (new Set(identities).size !== 1 || keys.size !== inventorySize) throw new Error("Measurements do not cover one checkout and complete partition");
  const sha = identities[0]!;
  const commit = await api.json(`git/commits/${sha}`);
  const parents = commit.parents?.map((parent: any) => parent.sha);
  if (commit.sha !== sha || !SHA.test(commit.tree?.sha) || !Array.isArray(parents) || parents.some((parent: unknown) => typeof parent !== "string" || !SHA.test(parent)) ||
      (info.event === "pull_request" ? parents.length !== 2 || parents[1] !== info.head_sha : sha !== info.head_sha)) throw new Error("Immutable checkout/tree/parent attribution does not match the run");
  const source = await api.json(`contents/scripts/visual.mjs?ref=${sha}`);
  if (source.encoding !== "base64" || typeof source.content !== "string") throw new Error("Execution source image pin is unavailable");
  const runnerSource = Buffer.from(source.content, "base64").toString("utf8");
  let producerSource: string | undefined;
  if (browserPinUsesProducer(runnerSource)) {
    const producer = await api.json(`contents/scripts/diagram-export-producer.mjs?ref=${sha}`);
    if (producer.encoding !== "base64" || typeof producer.content !== "string") throw new Error("Execution source producer pin is unavailable");
    producerSource = Buffer.from(producer.content, "base64").toString("utf8");
  }
  const pin = parseBrowserPin(runnerSource, producerSource);
  if (pin.image !== image) throw new Error("Execution source does not declare the measured image pin");
  const manifest = await api.json(`contents/packages/ui-kit/package.json?ref=${sha}`);
  if (manifest.encoding !== "base64" || typeof manifest.content !== "string" ||
      JSON.parse(Buffer.from(manifest.content, "base64").toString("utf8")).devDependencies?.playwright !== pin.playwright) {
    throw new Error("Execution source Playwright version differs from its image pin");
  }
  const measurements = { ...previous.measurements };
  // The original table recorded browser jobs only; retain their full provenance.
  if (previous.measurement && !measurements.browser) measurements.browser = previous.measurement;
  measurements[domain] = { head: info.head_sha, checkout: sha, tree: commit.tree.sha, parents, image, run, attempt,
    jobs: selected.map(job => job.id), units: "seconds", aggregation: "median reported project/file elapsed time", unknownSeconds: 1 };
  const preserved = Object.fromEntries(Object.entries(previous.seconds).filter(([key]) => layoutKey(key) !== (domain === "layout")));
  return { measurements, seconds: Object.fromEntries(Object.entries({ ...preserved, ...browserCostsFromLogs(logs) }).sort(([a], [b]) => a.localeCompare(b))) };
}

if (import.meta.main) {
  try {
    const [rawRun, rawAttempt, domain = "browser"] = process.argv.slice(2);
    if (!rawRun || !rawAttempt || !/^\d+$/.test(rawRun) || !/^\d+$/.test(rawAttempt) ||
        !Number.isSafeInteger(Number(rawRun)) || Number(rawRun) <= 0 || !Number.isSafeInteger(Number(rawAttempt)) || Number(rawAttempt) <= 0 ||
        !["browser", "layout"].includes(domain) || process.argv.length > 5) throw new Error("usage: bun scripts/refresh-browser-costs.ts <run-id> <attempt> [browser|layout]");
    const repo = "schlessera/brain-kit";
    const invoke = async (path: string, log = false): Promise<string> => {
      const child = Bun.spawn(["gh", "api", `repos/${repo}/${path}`, ...(log ? ["--allow-escape-sequences"] : [])], { stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (code !== 0) throw new Error(`Measurement evidence unavailable: ${err}`);
      return out;
    };
    const path = resolve(import.meta.dir, "browser-shard-costs.json");
    const { image } = await resolveBrowserPin(resolve(import.meta.dir, ".."));
    const table = await refreshBrowserCosts(domain as Domain, Number(rawRun), Number(rawAttempt), await Bun.file(path).json(), image,
      { json: async path => JSON.parse(await invoke(path)), log: job => invoke(`actions/jobs/${job}/logs`, true) });
    await Bun.write(path, JSON.stringify(table, null, 2) + "\n");
    console.log(`Recorded ${domain} evidence; ${Object.keys(table.seconds).length} project/file weights in ${path}`);
  } catch (error) { console.error(error); process.exit(1); }
}
