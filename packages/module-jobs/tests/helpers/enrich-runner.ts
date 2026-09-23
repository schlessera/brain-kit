// Isolated HTTP replacement: the real runner, the real RemoteOK adapter and the
// real enrichment, over a listing whose two rows carry no description.
import { ScrapeClient } from "@schlessera/brain-scrape";
import { openDatabase } from "../../src/db.js";
import { runScrape } from "../../src/scrape.js";

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

ScrapeClient.prototype.get = async (url: string) => {
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
});
const stored = openDatabase(dbPath!);
const rows = stored.query("SELECT source_id, description_text FROM jobs ORDER BY source_id").all();
const run = stored.query("SELECT status, cursor FROM scrape_runs ORDER BY id DESC LIMIT 1").get();
stored.close();
console.log(JSON.stringify({ report, stored: rows, run }));
