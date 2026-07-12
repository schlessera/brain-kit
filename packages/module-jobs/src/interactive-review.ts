import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import type { JobRow, ReviewStatus } from "./types";
import { getReviewQueue, setReviewStatus, deleteJob, type ReviewOptions } from "./review";

/** Open a URL in the default browser, detecting WSL2 and suppressing output. */
export function openUrl(url: string): void {
  const isWSL = existsSync("/proc/sys/fs/binfmt_misc/WSLInterop");
  const cmd = isWSL ? "wslview" : process.platform === "darwin" ? "open" : "xdg-open";
  Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" });
}

// ANSI escape helpers
const ESC = "\x1b";
const CLEAR = `${ESC}[2J${ESC}[H`;
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const YELLOW = `${ESC}[33m`;
const GREEN = `${ESC}[32m`;
const RED = `${ESC}[31m`;
const CYAN = `${ESC}[36m`;
const MAGENTA = `${ESC}[35m`;
const WHITE = `${ESC}[97m`;
const BG_RED = `${ESC}[41m`;
const SHOW_CURSOR = `${ESC}[?25h`;
const HIDE_CURSOR = `${ESC}[?25l`;

/** Turn a breakdown key ("distributed-systems") into a display label. */
function humanizeKey(key: string): string {
  return key.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

interface SessionCounters {
  starred: number;
  interested: number;
  dismissed: number;
  archived: number;
  deleted: number;
  skipped: number;
}

interface TuiState {
  jobs: JobRow[];
  currentIndex: number;
  totalLoaded: number;
  history: number[];
  flash: string | null;
  confirmDelete: boolean;
  counters: SessionCounters;
  startTime: number;
  done: boolean;
  atEnd: boolean; // past last job after skips
  /** Max points per breakdown key, for proportional bars (from criteria). */
  scoreMaxes: Record<string, number>;
}

function wordWrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.length <= width) {
      lines.push(rawLine);
      continue;
    }
    let remaining = rawLine;
    while (remaining.length > width) {
      let breakAt = remaining.lastIndexOf(" ", width);
      if (breakAt <= 0) breakAt = width;
      lines.push(remaining.slice(0, breakAt));
      remaining = remaining.slice(breakAt).trimStart();
    }
    if (remaining) lines.push(remaining);
  }
  return lines;
}

function scoreColor(score: number): string {
  if (score >= 70) return GREEN;
  if (score >= 50) return YELLOW;
  return RED;
}

function statusColor(status: string): string {
  switch (status) {
    case "starred": return MAGENTA;
    case "interested": return GREEN;
    case "queued": return YELLOW;
    case "pending": return DIM;
    case "dismissed": return RED;
    case "archived": return DIM;
    case "applied": return CYAN;
    default: return RESET;
  }
}

function hRule(width: number): string {
  return DIM + "═".repeat(width) + RESET;
}

function thinRule(label: string, width: number): string {
  const prefix = `${DIM}── ${RESET}${BOLD}${label}${RESET} ${DIM}`;
  // Account for ANSI codes in prefix: visible chars = "-- " + label + " "
  const visiblePrefix = 3 + label.length + 1;
  return prefix + "─".repeat(Math.max(0, width - visiblePrefix)) + RESET;
}

function renderFooter(state: TuiState): string {
  if (state.confirmDelete) {
    return `${BG_RED}${WHITE}${BOLD} Delete this job permanently? ${RESET}  ${BOLD}y${RESET} yes  ${BOLD}n${RESET} cancel`;
  }

  const keys = [
    `${BOLD}p${RESET} priority`,
    `${BOLD}b${RESET} backlog`,
    `${BOLD}d${RESET} dismiss`,
    `${BOLD}a${RESET} archive`,
    `${BOLD}x${RESET} delete`,
    `${BOLD}o${RESET} open`,
    `${BOLD}s${RESET} skip`,
    `${BOLD}k${RESET} back`,
    `${BOLD}q${RESET} quit`,
  ];
  return keys.join("  ");
}

function renderJobCard(
  job: JobRow,
  index: number,
  total: number,
  cols: number,
  maxDescLines: number,
  scoreMaxes: Record<string, number>
): string[] {
  const lines: string[] = [];
  const score = Math.round(job.relevance_score);

  // Header line: position + status + score
  const posStr = `Job ${index + 1} of ${total}`;
  const statusStr = `[${job.review_status}]`;
  const scoreStr = `Score: ${score}/100`;
  const rightSide = `${statusColor(job.review_status)}${statusStr}${RESET} ${scoreColor(score)}${scoreStr}${RESET}`;
  const rightVisible = statusStr.length + 1 + scoreStr.length;
  const pad = Math.max(1, cols - posStr.length - rightVisible);
  lines.push(`${DIM}${posStr}${RESET}${" ".repeat(pad)}${rightSide}`);

  lines.push(hRule(cols));

  // Title + ID
  const idStr = `#${job.id}`;
  const titlePad = Math.max(1, cols - job.title.length - idStr.length);
  lines.push(`${BOLD}${WHITE}${job.title}${RESET}${" ".repeat(titlePad)}${DIM}${idStr}${RESET}`);

  // Company | Location | Salary
  const meta: string[] = [`${CYAN}${job.company}${RESET}`];
  if (job.location) meta.push(job.location);
  if (job.salary_raw) {
    meta.push(`${GREEN}${job.salary_raw}${RESET}`);
  } else if (job.salary_min || job.salary_max) {
    const min = job.salary_min ? `€${Math.round(job.salary_min / 100).toLocaleString()}` : "?";
    const max = job.salary_max ? `€${Math.round(job.salary_max / 100).toLocaleString()}` : "?";
    meta.push(`${GREEN}${min} - ${max}${RESET}`);
  }
  lines.push(meta.join(` ${DIM}|${RESET} `));

  // Source + date
  const info: string[] = [`Source: ${job.source}`];
  if (job.published_at) info.push(`Published: ${job.published_at.split("T")[0]}`);
  if (job.remote_type && job.remote_type !== "unknown") info.push(`Remote: ${job.remote_type}`);
  if (job.job_type && job.job_type !== "unknown") info.push(`Type: ${job.job_type}`);
  lines.push(`${DIM}${info.join(" | ")}${RESET}`);

  // Tags
  if (job.tags) {
    try {
      const tags = JSON.parse(job.tags) as string[];
      if (tags.length > 0) {
        lines.push(`${DIM}Tags:${RESET} ${tags.slice(0, 12).join(", ")}${tags.length > 12 ? ` (+${tags.length - 12})` : ""}`);
      }
    } catch {}
  }

  // URL
  if (job.url) {
    lines.push(`${DIM}${job.url}${RESET}`);
  }

  lines.push("");

  // Score breakdown — keyed by the user's own criteria groups.
  if (job.score_breakdown) {
    try {
      const bd = JSON.parse(job.score_breakdown) as Record<string, number>;
      const entries = Object.entries(bd).filter(([key]) => key !== "total");
      if (entries.length > 0) {
        lines.push(`${BOLD}Score Breakdown${RESET}`);
        const labelWidth = Math.min(
          20,
          Math.max(...entries.map(([key]) => humanizeKey(key).length))
        );
        for (const [key, val] of entries) {
          const max = scoreMaxes[key] ?? Math.max(val, 1);
          const label = humanizeKey(key).padEnd(labelWidth);
          const valStr = `${val}`.padStart(2);
          const filled = Math.max(0, Math.min(val, max));
          const bar = filled > 0
            ? (filled >= max ? GREEN : YELLOW) + "█".repeat(filled) + DIM + "░".repeat(Math.max(0, max - filled)) + RESET
            : DIM + "░".repeat(max) + RESET;
          lines.push(`  ${label} ${valStr}/${max}  ${bar}`);
        }
        lines.push("");
      }
    } catch {}
  }

  // Description
  const descText = job.description_text?.trim();
  if (descText) {
    lines.push(thinRule("Description", cols));
    const wrapped = wordWrap(descText, cols - 1);
    const descLines = wrapped.slice(0, maxDescLines);
    lines.push(...descLines);
    if (wrapped.length > maxDescLines) {
      lines.push(`${DIM}[...truncated, press o to view full listing]${RESET}`);
    }
  } else {
    lines.push(`${DIM}No description available.${RESET}`);
  }

  return lines;
}

function render(state: TuiState): void {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  let output = CLEAR + HIDE_CURSOR;

  if (state.atEnd) {
    const skipped = state.jobs.length;
    output += `\n${BOLD}End of queue.${RESET}\n\n`;
    output += `${skipped} job${skipped !== 1 ? "s" : ""} skipped (still in queue).\n\n`;
    output += `Press ${BOLD}k${RESET} to go back or ${BOLD}q${RESET} to quit.\n`;
    // Position footer at bottom
    output += `${ESC}[${rows};1H`;
    output += renderFooter(state);
    process.stdout.write(output);
    return;
  }

  const job = state.jobs[state.currentIndex];
  if (!job) {
    output += `\n${BOLD}No more jobs in queue.${RESET}\n`;
    output += `${ESC}[${rows};1H`;
    output += `${BOLD}q${RESET} quit`;
    process.stdout.write(output);
    return;
  }

  // Reserve lines: 1 for footer, 1 for flash, 1 for bottom rule
  const footerLines = state.flash ? 3 : 2;

  // First pass with 0 desc lines to measure actual header height
  const probe = renderJobCard(job, state.currentIndex, state.totalLoaded, cols, 0, state.scoreMaxes);
  const headerLines = probe.length;
  const maxDescLines = Math.max(3, rows - headerLines - footerLines);

  const cardLines = renderJobCard(
    job,
    state.currentIndex,
    state.totalLoaded,
    cols,
    maxDescLines,
    state.scoreMaxes
  );

  output += cardLines.join("\n") + "\n";

  // Position at bottom area
  output += `${ESC}[${rows - (state.flash ? 2 : 1)};1H`;
  if (state.flash) {
    output += `${state.flash}\n`;
  }
  output += hRule(cols) + "\n";
  output += renderFooter(state);

  process.stdout.write(output);
}

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const s = secs % 60;
  return mins > 0 ? `${mins}m ${s}s` : `${s}s`;
}

function printSummary(state: TuiState): void {
  const c = state.counters;
  const total = c.starred + c.interested + c.dismissed + c.archived + c.deleted;
  const elapsed = formatDuration(Date.now() - state.startTime);
  const skipped = state.jobs.length;

  console.log(`\n${DIM}──${RESET} ${BOLD}Triage Summary${RESET} ${DIM}──${RESET}`);
  console.log(`  Reviewed: ${total} jobs in ${elapsed}`);
  const parts: string[] = [];
  if (c.starred > 0) parts.push(`${MAGENTA}Starred: ${c.starred}${RESET}`);
  if (c.interested > 0) parts.push(`${GREEN}Backlog: ${c.interested}${RESET}`);
  if (c.dismissed > 0) parts.push(`${RED}Dismissed: ${c.dismissed}${RESET}`);
  if (c.archived > 0) parts.push(`Archived: ${c.archived}`);
  if (c.deleted > 0) parts.push(`${RED}Deleted: ${c.deleted}${RESET}`);
  if (parts.length > 0) console.log(`  ${parts.join(" | ")}`);
  if (skipped > 0) console.log(`  Skipped: ${skipped} (still in queue)`);
  console.log();
}

function cleanup(): void {
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write(SHOW_CURSOR + RESET);
}

export async function runInteractiveReview(
  db: Database,
  opts: Omit<ReviewOptions, "limit"> = {},
  scoreMaxes: Record<string, number> = {}
): Promise<void> {
  const jobs = getReviewQueue(db, { ...opts, limit: 500 });

  if (jobs.length === 0) {
    console.log("No jobs to review. Run 'scrape' first or adjust filters.");
    return;
  }

  const state: TuiState = {
    jobs,
    currentIndex: 0,
    totalLoaded: jobs.length,
    history: [],
    flash: null,
    confirmDelete: false,
    counters: { starred: 0, interested: 0, dismissed: 0, archived: 0, deleted: 0, skipped: 0 },
    startTime: Date.now(),
    done: false,
    atEnd: false,
    scoreMaxes,
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  const onResize = () => render(state);
  process.on("SIGWINCH", onResize);

  const onSignal = () => {
    cleanup();
    printSummary(state);
    process.exit(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  render(state);

  try {
    for await (const data of process.stdin) {
      const key = typeof data === "string" ? data : data.toString("utf8");

      // Ignore escape sequences (arrow keys etc)
      if (key.startsWith("\x1b[")) continue;

      state.flash = null;

      if (state.confirmDelete) {
        if (key === "y" || key === "Y") {
          const job = state.jobs[state.currentIndex];
          deleteJob(db, job.id);
          state.counters.deleted++;
          state.flash = `${RED}Deleted${RESET} #${job.id} "${job.title}"`;
          state.jobs.splice(state.currentIndex, 1);
          if (state.jobs.length === 0) { state.done = true; break; }
          if (state.currentIndex >= state.jobs.length) state.atEnd = true;
        } else {
          state.flash = `${DIM}Delete cancelled${RESET}`;
        }
        state.confirmDelete = false;
        render(state);
        continue;
      }

      const job = state.atEnd ? null : state.jobs[state.currentIndex];

      switch (key) {
        case "p": {
          if (!job) break;
          setReviewStatus(db, job.id, "starred" as ReviewStatus);
          state.counters.starred++;
          state.flash = `${MAGENTA}Starred${RESET} #${job.id} "${job.title}"`;
          state.jobs.splice(state.currentIndex, 1);
          if (state.jobs.length === 0) { state.done = true; break; }
          if (state.currentIndex >= state.jobs.length) state.atEnd = true;
          break;
        }
        case "b": {
          if (!job) break;
          setReviewStatus(db, job.id, "interested");
          state.counters.interested++;
          state.flash = `${GREEN}Backlog${RESET} #${job.id} "${job.title}"`;
          state.jobs.splice(state.currentIndex, 1);
          if (state.jobs.length === 0) { state.done = true; break; }
          if (state.currentIndex >= state.jobs.length) state.atEnd = true;
          break;
        }
        case "d": {
          if (!job) break;
          setReviewStatus(db, job.id, "dismissed");
          state.counters.dismissed++;
          state.flash = `${RED}Dismissed${RESET} #${job.id} "${job.title}"`;
          state.jobs.splice(state.currentIndex, 1);
          if (state.jobs.length === 0) { state.done = true; break; }
          if (state.currentIndex >= state.jobs.length) state.atEnd = true;
          break;
        }
        case "a": {
          if (!job) break;
          setReviewStatus(db, job.id, "archived" as ReviewStatus);
          state.counters.archived++;
          state.flash = `Archived #${job.id} "${job.title}"`;
          state.jobs.splice(state.currentIndex, 1);
          if (state.jobs.length === 0) { state.done = true; break; }
          if (state.currentIndex >= state.jobs.length) state.atEnd = true;
          break;
        }
        case "x": {
          if (!job) break;
          state.confirmDelete = true;
          render(state);
          continue;
        }
        case "o": {
          if (!job) {
            state.flash = `${DIM}No job selected${RESET}`;
            break;
          }
          const url = job.url || job.source_url;
          if (url) {
            openUrl(url);
            state.flash = `${CYAN}Opened in browser${RESET}`;
          } else {
            state.flash = `${DIM}No URL available${RESET}`;
          }
          break;
        }
        case "s": {
          if (!job) break;
          state.counters.skipped++;
          state.history.push(state.currentIndex);
          state.currentIndex++;
          if (state.currentIndex >= state.jobs.length) state.atEnd = true;
          break;
        }
        case "k": {
          if (state.atEnd) {
            state.atEnd = false;
            if (state.history.length > 0) {
              state.currentIndex = state.history.pop()!;
              state.counters.skipped--;
            } else {
              state.currentIndex = Math.max(0, state.jobs.length - 1);
            }
          } else if (state.history.length > 0) {
            state.currentIndex = state.history.pop()!;
            state.counters.skipped--;
          } else {
            state.flash = `${DIM}Already at first job${RESET}`;
          }
          break;
        }
        case "q":
        case "\x03": { // Ctrl+C
          state.done = true;
          break;
        }
        default:
          continue;
      }

      if (state.done) break;
      render(state);
    }
  } finally {
    cleanup();
    process.removeListener("SIGWINCH", onResize);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    printSummary(state);
  }
}
