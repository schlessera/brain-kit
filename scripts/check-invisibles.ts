// Refuses raw control and invisible characters in tracked text files.
//
// Why: a single raw NUL byte makes grep and ripgrep classify a source file as
// binary, so it silently vanishes from every search — the symptom that led
// here was `indexer.ts` being invisible to `rg`. Zero-width spaces are the
// milder version: the code works, but nobody can read, diff, or retype the
// literal, and an editor that trims "whitespace" corrupts it without a trace.
//
// The fix is never to change the runtime value — it is to spell the character
// as an escape sequence in the source. Escapes keep the bytes identical (so
// hashes and wire formats do not move) while leaving the file ASCII.
//
// This file deliberately contains no invisible characters of its own: every
// codepoint it hunts for is written as a number.
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join, resolve } from "path";

const CONTROL_NAMES: Record<number, string> = {
  0x00: "NUL",
  0x01: "SOH",
  0x02: "STX",
  0x03: "ETX",
  0x04: "EOT",
  0x05: "ENQ",
  0x06: "ACK",
  0x07: "BEL",
  0x08: "BS",
  0x0b: "VT",
  0x0c: "FF",
  0x0e: "SO",
  0x0f: "SI",
  0x1b: "ESC",
  0x1c: "FS",
  0x1d: "GS",
  0x1e: "RS",
  0x1f: "US",
  0x7f: "DEL",
};

const INVISIBLE_NAMES: Record<number, string> = {
  0x00a0: "NO-BREAK SPACE",
  0x00ad: "SOFT HYPHEN",
  0x200b: "ZERO WIDTH SPACE",
  0x200c: "ZERO WIDTH NON-JOINER",
  0x200d: "ZERO WIDTH JOINER",
  0x200e: "LEFT-TO-RIGHT MARK",
  0x200f: "RIGHT-TO-LEFT MARK",
  0x2028: "LINE SEPARATOR",
  0x2029: "PARAGRAPH SEPARATOR",
  0x202a: "LEFT-TO-RIGHT EMBEDDING",
  0x202b: "RIGHT-TO-LEFT EMBEDDING",
  0x202c: "POP DIRECTIONAL FORMATTING",
  0x202d: "LEFT-TO-RIGHT OVERRIDE",
  0x202e: "RIGHT-TO-LEFT OVERRIDE",
  0x2060: "WORD JOINER",
  0x2066: "LEFT-TO-RIGHT ISOLATE",
  0x2067: "RIGHT-TO-LEFT ISOLATE",
  0x2068: "FIRST STRONG ISOLATE",
  0x2069: "POP DIRECTIONAL ISOLATE",
  0xfeff: "BYTE ORDER MARK",
};

// Extensions whose bytes are meant to be opaque. Everything else is treated as
// source and must stay readable.
const BINARY_EXTENSIONS =
  /\.(png|jpe?g|gif|webp|avif|svgz|ico|icns|pdf|woff2?|ttf|otf|eot|zip|gz|tgz|bz2|xz|7z|db|sqlite3?|wasm|mp4|webm|mov|mp3|wav|ogg|flac|bin|node|onnx)$/i;

// Escape hatch for a file that genuinely needs raw bytes (e.g. a fixture that
// asserts on binary handling). Keep it empty if you can: every entry is a file
// that grep can no longer see.
const ALLOWED_PATHS: string[] = [];

interface Finding {
  file: string;
  line: number;
  column: number;
  name: string;
  codepoint: number;
}

function describe(codepoint: number): string | null {
  if (codepoint === 0x09 || codepoint === 0x0a || codepoint === 0x0d) return null;
  if (codepoint < 0x20 || codepoint === 0x7f) {
    return CONTROL_NAMES[codepoint] ?? `CONTROL-0x${codepoint.toString(16)}`;
  }
  return INVISIBLE_NAMES[codepoint] ?? null;
}

// Renders a codepoint as the escape sequence an author should type. Built by
// concatenation rather than a literal escape, so this file would
// never need an exemption from its own rule.
function escapeHint(codepoint: number): string {
  const digits = codepoint.toString(16).toUpperCase().padStart(4, "0");
  return `${String.fromCharCode(92)}u${digits}`;
}

export function scanText(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  let line = 1;
  let column = 1;
  for (const char of text) {
    const codepoint = char.codePointAt(0)!;
    if (codepoint === 0x0a) {
      line += 1;
      column = 1;
      continue;
    }
    const name = describe(codepoint);
    if (name) findings.push({ file, line, column, name, codepoint });
    column += 1;
  }
  return findings;
}

export function scanRepo(root: string): Finding[] {
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    maxBuffer: 1 << 28,
  })
    .toString("utf-8")
    .split(String.fromCharCode(0))
    .filter(Boolean);

  const findings: Finding[] = [];
  for (const relative of tracked) {
    if (BINARY_EXTENSIONS.test(relative)) continue;
    if (ALLOWED_PATHS.includes(relative)) continue;
    let text: string;
    try {
      text = readFileSync(join(root, relative)).toString("utf-8");
    } catch {
      continue; // Deleted or unreadable in this checkout; not our problem.
    }
    findings.push(...scanText(relative, text));
  }
  return findings;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? process.cwd());
  const findings = scanRepo(root);
  if (findings.length === 0) {
    console.log("No raw control or invisible characters in tracked files.");
    process.exit(0);
  }

  console.error("Raw control/invisible characters found in tracked source:");
  for (const finding of findings) {
    console.error(
      `  ${finding.file}:${finding.line}:${finding.column}: ${finding.name} ` +
        `- write it as ${escapeHint(finding.codepoint)} instead`
    );
  }
  console.error(
    "\nA raw NUL byte makes grep/ripgrep treat the whole file as binary, so it " +
      "disappears from searches. Replacing the raw character with its escape " +
      "sequence keeps the runtime bytes identical."
  );
  process.exit(1);
}
