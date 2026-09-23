// Isolated HTTP replacement: the real runner, the real RemoteOK adapter and the
// real enrichment, over a listing whose two rows carry no description.
import { ScrapeClient } from "@schlessera/brain-scrape";
import { openDatabase } from "../../src/db.js";
import { RemoteOKAdapter } from "../../src/adapters/remoteok.js";
import { runScrape } from "../../src/scrape.js";

// RemoteOK's feed carries descriptions, so the real board names no detail
// hosts. The fixture listing here carries none; give the board its fixture
// host so the real runner enriches it.
Object.defineProperty(RemoteOKAdapter.prototype, "detailHosts", { value: ["remoteok.example"] });

const [mode, dbPath] = process.argv.slice(2);
const listing = [1, 2].map((id) => ({
  id: String(id),
  position: "Engineer",
  company: "Example Corp",
  url: `https://remoteok.example/remote-jobs/${id}`,
  date: "2025-02-01T00:00:00.000Z",
}));
const detail = (id: string) =>
  `<script type="application/ld+json">${JSON.stringify({
    "@type": "JobPosting",
    title: "Engineer",
    description: `Fetched for job ${id}.`,
  })}</script>`;

const seen: Array<{ url: string; proxy: string | null }> = [];
ScrapeClient.prototype.get = async (url: string, opts: { proxy?: string } = {}) => {
  seen.push({ url, proxy: opts.proxy ?? null });
  if (url.startsWith("https://remoteok.com/")) return new Response(JSON.stringify(listing));
  const id = url.split("/").pop()!;
  if (mode === "fail" && id === "2") return new Response("unavailable", { status: 500 });
  return new Response(detail(id));
};

const report = await runScrape({
  dbPath: dbPath!,
  sources: ["remoteok"],
  incremental: true,
  enrichment: mode === "truncate" ? { maxDetailPages: 1 } : {},
  proxy: mode === "proxy" ? "http://proxy.example:3128" : undefined,
});
const stored = openDatabase(dbPath!);
const rows = stored.query("SELECT source_id, description_text FROM jobs ORDER BY source_id").all();
const run = stored.query("SELECT status, cursor FROM scrape_runs ORDER BY id DESC LIMIT 1").get();
stored.close();
console.log(JSON.stringify({ report, stored: rows, run, seen }));
