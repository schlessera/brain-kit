/**
 * The storage breakdown of Odysseus's brain as measured at 06:40 on
 * 2026-07-12 (#4544). Synthetic, decimal units, On disk basis.
 *
 * Shaped the way the breakdown's caller holds it after derivation: one entry
 * per child of the current folder, an owner, a kind, a pre-formatted meta
 * line, and either a known size in bytes or `null` with the reason it is
 * unknown. The stories derive map tiles, legend totals and rows from these;
 * the kit components take only the derived props.
 */

export type StorageFixtureOwner = "brain" | "app" | "operator";

export interface StorageEntry {
  id: string;
  name: string;
  owner: StorageFixtureOwner;
  kind: "folder" | "file" | "store";
  meta?: string;
  /** Known bytes in the active basis, or `null` when not measured. */
  bytes: number | null;
  /** Partial coverage: `bytes` is a lower bound. */
  atLeast?: boolean;
  /** A `StorageRoot.reason` string. */
  reason?: string | null;
}

const GB = 1_000_000_000;
const MB = 1_000_000;

/** The top level, All: App-heavy, Brain-light, an Operator backup, and two unknown stores. */
export const storageAll: StorageEntry[] = [
  { id: "packs", name: "Packs", owner: "app", kind: "folder", meta: "git · 1,204 files", bytes: 9.8 * GB },
  { id: "models", name: "Models", owner: "app", kind: "folder", meta: "models · 14 files", bytes: 6.0 * GB },
  { id: "logs", name: "Logs", owner: "app", kind: "folder", meta: "logs · 3,412 files", bytes: 4.1 * GB },
  { id: "backups", name: "Backups", owner: "operator", kind: "folder", meta: "backup · 9 archives", bytes: 3.0 * GB },
  { id: "attachments", name: "Attachments", owner: "brain", kind: "folder", meta: "content · 2,103 files", bytes: 2.4 * GB },
  { id: "cache", name: "Cache", owner: "app", kind: "folder", meta: "scratch · 812 files", bytes: 2.2 * GB },
  { id: "index", name: "index-2026-07.db", owner: "app", kind: "file", meta: "database", bytes: 1.9 * GB },
  { id: "notes", name: "Voyage notes", owner: "brain", kind: "folder", meta: "content · 1,560 notes", bytes: 1.2 * GB },
  { id: "git", name: "Git history", owner: "brain", kind: "folder", meta: "git · objects", bytes: 1.2 * GB },
  { id: "sessions", name: "Sessions", owner: "app", kind: "folder", meta: "transcripts · 96 files", bytes: 180 * MB },
  { id: "drafts", name: "Drafts", owner: "app", kind: "folder", meta: "staging · 4 files", bytes: 120 * MB },
  { id: "receipts", name: "Receipts", owner: "app", kind: "folder", meta: "journal · 31 files", bytes: 90 * MB },
  { id: "retained", name: "Native retained store", owner: "app", kind: "store", meta: "recovery", bytes: null, reason: "metadata-unavailable" },
  { id: "host-backups", name: "Host backups", owner: "operator", kind: "store", meta: "backup", bytes: null, reason: "unsupported-platform" },
];

/** A brain with nothing in it yet: the Brain categories are measured and empty. */
export const storageBrainEmpty: StorageEntry[] = [
  { id: "packs", name: "Packs", owner: "app", kind: "folder", meta: "git · 6 files", bytes: 42 * MB },
  { id: "cache", name: "Cache", owner: "app", kind: "folder", meta: "scratch · 12 files", bytes: 18 * MB },
  { id: "index", name: "index-2026-07.db", owner: "app", kind: "file", meta: "database", bytes: 6.1 * MB },
  { id: "attachments", name: "Attachments", owner: "brain", kind: "folder", meta: "content · none", bytes: 0 },
  { id: "notes", name: "Voyage notes", owner: "brain", kind: "folder", meta: "content · none", bytes: 0 },
];

/** One folder dominated by App, with the Brain and Operator mix kept small. */
export const storageAppDominant: StorageEntry[] = [
  { id: "models", name: "Models", owner: "app", kind: "folder", meta: "models · 14 files", bytes: 18.4 * GB },
  { id: "packs", name: "Packs", owner: "app", kind: "folder", meta: "git · 1,204 files", bytes: 9.8 * GB },
  { id: "logs", name: "Logs", owner: "app", kind: "folder", meta: "logs · 3,412 files", bytes: 4.1 * GB },
  { id: "cache", name: "Cache", owner: "app", kind: "folder", meta: "scratch · 812 files", bytes: 2.2 * GB },
  { id: "backups", name: "Backups", owner: "operator", kind: "folder", meta: "backup · 9 archives", bytes: 1.1 * GB },
  { id: "notes", name: "Voyage notes", owner: "brain", kind: "folder", meta: "content · 1,560 notes", bytes: 0.9 * GB },
];

/** Storage › Packs › objects › pack: three levels down, one big pack and many small ones. */
export const storageDrillTrail = [
  { id: "root", label: "Storage" },
  { id: "packs", label: "Packs" },
  { id: "objects", label: "objects" },
  { id: "pack", label: "pack" },
];

export const storagePackFolder: StorageEntry[] = [
  { id: "pack-3f2a", name: "pack-3f2a.pack", owner: "app", kind: "file", meta: "git pack", bytes: 1.4 * GB },
  { id: "pack-77c1", name: "pack-77c1.pack", owner: "app", kind: "file", meta: "git pack", bytes: 0.8 * GB },
  { id: "pack-9b0e", name: "pack-9b0e.pack", owner: "app", kind: "file", meta: "git pack", bytes: 0.31 * GB },
  { id: "pack-3f2a-idx", name: "pack-3f2a.idx", owner: "app", kind: "file", meta: "pack index", bytes: 0.12 * GB },
  // 212 small packs, each well under 1% of the folder: the "N smaller" aggregate.
  ...Array.from({ length: 212 }, (_, i): StorageEntry => ({
    id: `small-${i}`,
    name: `pack-${(0x1000 + i * 37).toString(16)}.pack`,
    owner: "app",
    kind: "file",
    meta: "git pack",
    bytes: 2.4 * MB + (i % 7) * 0.1 * MB,
  })),
];

/** A scan that stopped early and stores it could not read: every reason the copy covers. */
export const storagePartial: StorageEntry[] = [
  { id: "transcripts", name: "Transcripts", owner: "app", kind: "folder", meta: "transcripts", bytes: 4.2 * GB, atLeast: true, reason: "partial" },
  { id: "packs", name: "Packs", owner: "app", kind: "folder", meta: "git · 1,204 files", bytes: 3.1 * GB },
  { id: "attachments", name: "Attachments", owner: "brain", kind: "folder", meta: "content · 2,103 files", bytes: 2.4 * GB },
  { id: "backups", name: "Backups", owner: "operator", kind: "store", meta: "backup", bytes: null, reason: "metadata-unavailable" },
  { id: "host-backups", name: "Host backups", owner: "operator", kind: "store", meta: "backup", bytes: null, reason: "unsupported-platform" },
  { id: "sessions", name: "Sessions", owner: "app", kind: "store", meta: "transcripts", bytes: null, reason: "cancelled" },
  { id: "workspaces", name: "Workspaces", owner: "app", kind: "store", meta: "worktrees", bytes: null, reason: "root-budget" },
  { id: "remote", name: "Remote copy", owner: "operator", kind: "store", meta: "remote", bytes: null, reason: null },
];

/** Names that do not fit: two lines, then an ellipsis, in the list; an ellipsis on a tile. */
export const storageLongNames: StorageEntry[] = [
  {
    id: "harbor",
    name: "Ithaca-harbor-survey-of-the-eastern-mooring-before-the-suitors-arrived-final-revised-copy.pdf",
    owner: "brain",
    kind: "file",
    meta: "attachment",
    bytes: 48.2 * MB,
  },
  {
    id: "sirens",
    name: "Sirens-score-transcribed-from-memory-while-lashed-to-the-mast-with-beeswax-notes.pdf",
    owner: "brain",
    kind: "file",
    meta: "attachment",
    bytes: 31.5 * MB,
  },
  { id: "aeaea", name: "Aeaea-herb-garden-inventory-and-the-moly-question", owner: "app", kind: "folder", meta: "scratch · 240 files", bytes: 22.0 * MB },
  { id: "backup", name: "nightly-backup-2026-07-12-ogygia-raft-yard.tar", owner: "operator", kind: "file", meta: "backup", bytes: 12.4 * MB },
];

export interface StorageLargeFile {
  id: string;
  name: string;
  folder: string;
  bytes: number | null;
  git: "tracked" | "untracked" | "unknown";
  links: number | null;
  eligibility: "can-remove" | "check" | "kept" | "cant-tell";
  why?: string;
}

/** Find large files, Larger than 100 MB: one row for each eligibility word. */
export const storageLargeFiles: StorageLargeFile[] = [
  { id: "model", name: "model-q8.gguf", folder: "Models/", bytes: 4.1 * GB, git: "untracked", links: 1, eligibility: "can-remove" },
  { id: "pack", name: "pack-3f2a.pack", folder: "Packs/", bytes: 1.4 * GB, git: "tracked", links: 1, eligibility: "kept", why: "tracked by Git" },
  { id: "export", name: "export-2026-06.zip", folder: "Exports/", bytes: 0.9 * GB, git: "untracked", links: 2, eligibility: "check", why: "other links exist" },
  { id: "wav", name: "transcript-0612.wav", folder: "Inbox/", bytes: null, git: "unknown", links: null, eligibility: "cant-tell", why: "not measured" },
];

/** Decimal, three significant figures (storage.md): 9.80 GB, 120 MB. */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units: [number, string][] = [
    [GB, "GB"],
    [MB, "MB"],
    [1_000, "kB"],
  ];
  for (const [size, unit] of units) if (bytes >= size) return `${(bytes / size).toPrecision(3)} ${unit}`;
  return `${bytes} B`;
}
