import { z } from "zod";
import type { KeyedLock } from "./keyed-lock.js";

/** Exact effects, never command replay. Hashes are SHA-256 of UTF-8 bytes. */
export const BRAIN_APPLICATION_MAX_BYTES = 1_048_576;
const base = z.string().regex(/^[a-f0-9]{64}$/).nullable();
const file = z.object({ path: z.string().min(1).max(1024), expectedBaseHash: base, content: z.string() }).strict();
export const brainApplicationInput = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("write"), ...file.shape }).strict(),
  z.object({ operation: z.literal("edit"), path: file.shape.path, expectedBaseHash: base,
    old_string: z.string().min(1), new_string: z.string() }).strict(),
  z.object({ operation: z.literal("staged"), files: z.array(file).min(1).max(32) }).strict(),
  z.object({ operation: z.literal("add"), content: z.string().min(1), type: z.string().optional(),
    title: z.string().optional(), tags: z.array(z.string()).optional(),
    target: z.string().optional(), expectedBaseHash: base.optional() }).strict(),
  z.object({ operation: z.literal("update"), path: file.shape.path, expectedBaseHash: base,
    summary: z.string().optional(), status: z.enum(["active", "archived", "draft"]).optional(),
    relevance: z.enum(["primary", "secondary", "historical"]).optional(),
    tags: z.array(z.string()).optional(), deadline: z.string().optional(), next_review: z.string().optional(),
    append_content: z.string().optional() }).strict(),
  z.object({ operation: z.literal("archive"), path: file.shape.path, expectedBaseHash: base,
    dry_run: z.boolean().optional() }).strict(),
]);
export type BrainApplicationInput = z.infer<typeof brainApplicationInput>;
export type BrainApplicationOperation = BrainApplicationInput["operation"];
export interface BrainApplicationResult {
  ok: boolean;
  code?: string;
  message: string;
  /** Only effects actually committed to authoritative Markdown. */
  changes: { path: string; contentHash: string | null }[];
  outcome?: Record<string, unknown>;
  indexed?: boolean;
}
/** Trusted parent-side backend policy; never supplied over a worker pipe. */
export interface BrainApplicationPolicy {
  autoAllowed: readonly BrainApplicationOperation[];
  available: readonly BrainApplicationOperation[];
  /** Remembered grants cannot answer outside an enforced turn membership. */
  enforceAllowedTools?: boolean;
  lock: Pick<KeyedLock, "withLock">;
}

/** Hosted names are fixed by operation; a caller-supplied tool name grants nothing. */
export const BRAIN_APPLICATION_TOOLS = Object.freeze({
  add: "brain_add", update: "brain_update", archive: "brain_archive",
  write: "write_file", edit: "edit_file", staged: "apply_staged_changes",
});
export const BRAIN_APPLICATION_DESCRIPTIONS = Object.freeze({
  add: "Capture into the authoritative brain in one server-validated step, then index. Terminal users use brain add.",
  update: "Set document frontmatter or append content, then index. Read brain_read_base first and pass its expectedBaseHash. Archiving requires confirmation.",
  archive: "Archive a document and move active projects, then index. Requires confirmation. Read brain_read_base first and pass its expectedBaseHash.",
  write: "Write exact UTF-8 Markdown through server validation. Existing files require the SHA-256 returned by brain_read_base; null means create only.",
  edit: "Replace one exact unique string in the base read from brain_read_base, through server validation.",
  staged: "Apply only named Markdown files and their exact proposed content, each with its SHA-256 base (null means create). Never executes a command.",
});
