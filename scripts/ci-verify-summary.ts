/** Best effort after step failure; forced job cancellation may prevent this step entirely. */
import { appendFileSync, readFileSync } from "node:fs";

const lines = [
  `Frozen install (1-minute setup partition): ${process.env.INSTALL_OUTCOME || "missing"}`,
  `Affected planning (1-minute setup partition): ${process.env.PLAN_OUTCOME || "missing"}`,
  `Strict types and selected fast tests (4-minute proof limit): ${process.env.PROOF_OUTCOME || "missing"}`,
];
let complete = false;
try {
  const raw = readFileSync(process.env.CI_COMMAND_RECEIPTS ?? "tmp/verify-commands.jsonl", "utf8");
  const events = raw.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const starts = events.filter(e => e.event === "start");
  const finishes = events.filter(e => e.event === "finish");
  const missing = starts.filter(start => !finishes.some(end => end.id === start.id));
  complete = events.at(-1)?.event === "complete" && starts.length === finishes.length &&
    new Set(starts.map(e => e.id)).size === starts.length &&
    starts.every(start => finishes.filter(end => end.id === start.id && end.exitCode === 0 && !end.signal).length === 1);
  lines.push(`Command completion evidence: ${complete ? "complete" : "missing or nonpassing"}`);
  for (const start of missing) lines.push(`Missing end receipt: ${start.name}; completion unknown`);
  lines.push("", "```json", raw.trim() || "No command receipts", "```");
} catch {
  lines.push("Command completion evidence: missing or unreadable; completion unknown");
}
lines.push("", "Summary is best effort; forced job cancellation may prevent summary/cleanup.");
const summary = `${lines.join("\n")}\n`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
// A successful step label alone cannot replace affirmative completion evidence.
if (process.env.PROOF_OUTCOME === "success" && !complete) process.exitCode = 1;
