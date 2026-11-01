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
  const ends = events.filter(e => e.event === "finish" || e.event === "interrupted");
  complete = events.at(-1)?.event === "complete" && starts.length === finishes.length &&
    new Set(starts.map(e => e.id)).size === starts.length &&
    starts.every(start => finishes.filter(end => end.id === start.id && end.exitCode === 0 && !end.signal).length === 1);
  lines.push(`Command completion evidence: ${complete ? "complete" : "missing or nonpassing"}`);
  for (const start of starts) {
    const end = ends.find(e => e.id === start.id);
    if (!end) lines.push(`Missing end receipt: ${start.name}; completion unknown`);
    else if (end.event === "interrupted") lines.push(`Command ${start.name}: interrupted (exit ${end.exitCode}, signal ${end.signal ?? "none"})`);
    else if (end.signal) lines.push(`Command ${start.name}: terminated by signal ${end.signal} (exit ${end.exitCode})`);
    else if (end.exitCode !== 0) lines.push(`Command ${start.name}: failed (exit ${end.exitCode})`);
    else lines.push(`Command ${start.name}: finished successfully`);
  }
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
