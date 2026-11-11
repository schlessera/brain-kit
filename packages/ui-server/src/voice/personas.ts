/**
 * Live-conversation personas (#3617): authored Markdown at
 * `_voice/personas/<id>.md` in the brain, selected through the ui-server
 * settings store. The file is the source of truth; nothing here is cached as
 * authority, and `brain.db` never sees persona text (core excludes `_voice`).
 *
 * A persona is customization, never authority: it carries a name, one voice
 * per service and plain-text speaking-style instructions. Nothing in this
 * module reaches tools, permissions, task admission or history.
 *
 * Every directory is opened component by component without following links,
 * and later operations are anchored to the open descriptor on Linux (the same
 * containment approach as the schedule definition files). Writes replace a
 * file atomically through a synced temporary file; create links it into place
 * so an existing name is never overwritten.
 */
import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";
import {
  LIVE_PERSONA_LIMITS,
  STANDARD_PERSONA_ID,
  STANDARD_PERSONA_REVISION,
  type ConversationPersonaRef,
  type LivePersona,
  type LivePersonaInvalidReason,
  type LivePersonaProviderStatus,
  type LivePersonaStatus,
  type LivePersonaSummary,
} from "@schlessera/brain-ui-sdk/protocol";
import type { LiveConversationProvider } from "@schlessera/brain-ui-sdk/server";
import { getLivePersonaSelection } from "../db/settings.js";
import type { SettingsWrites } from "../db/settings-writes.js";

const PERSONA_DIR = "_voice/personas";
export const PERSONA_ID = /^[a-z0-9-]{1,48}$/;
const PROVIDER_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VOICE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const CONTROL = /\p{Cc}/u;
const ANCHORED = process.platform === "linux" && existsSync("/proc/self/fd");
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/** A refusal the routes map to a fixed status and code; never carries persona text. */
export class PersonaError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 503, readonly code: string, readonly reason?: LivePersonaInvalidReason) {
    super(code);
  }
}

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
const revisionOf = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** Line endings to LF, then leading and trailing whitespace trimmed. */
export function normalizeInstructions(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

/** Validate authored fields; returns the first reason they cannot be stored. */
export function personaFieldsInvalid(fields: { name: unknown; voices: unknown; instructions: unknown }): LivePersonaInvalidReason | null {
  if (typeof fields.name !== "string") return "name";
  const name = fields.name.trim();
  if (!name || [...name].length > LIVE_PERSONA_LIMITS.maxNameChars || CONTROL.test(name)) return "name";
  const voices = fields.voices;
  if (!voices || typeof voices !== "object" || Array.isArray(voices)) return "voices";
  const entries = Object.entries(voices);
  if (entries.length > LIVE_PERSONA_LIMITS.maxVoices ||
      entries.some(([key, value]) => !PROVIDER_KEY.test(key) || typeof value !== "string" || !VOICE_ID.test(value))) return "voices";
  if (typeof fields.instructions !== "string") return "too_long";
  if (bytes(normalizeInstructions(fields.instructions)) > LIVE_PERSONA_LIMITS.maxInstructionBytes) return "too_long";
  return null;
}

/** Canonical file bytes: JSON-quoted scalars are valid YAML and never reinterpreted. */
export function serializePersona(fields: { name: string; voices: Record<string, string>; instructions: string }): string {
  const voices = Object.keys(fields.voices).sort();
  const map = voices.length ? `\n${voices.map(key => `  ${key}: ${JSON.stringify(fields.voices[key])}`).join("\n")}` : " {}";
  const body = normalizeInstructions(fields.instructions);
  return `---\nschema: 1\nname: ${JSON.stringify(fields.name.trim())}\nvoices:${map}\n---\n${body ? `${body}\n` : ""}`;
}

/** Decode one file. Never throws: an unusable file is listed with its reason. */
export function parsePersona(id: string, data: Uint8Array): LivePersona {
  const revision = revisionOf(data);
  const invalid = (reason: LivePersonaInvalidReason, name = id): LivePersona =>
    ({ id, name, voices: {}, instructionBytes: 0, revision, invalid: reason, instructions: "" });
  if (data.byteLength > LIVE_PERSONA_LIMITS.maxFileBytes) return invalid("too_long");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { return invalid("encoding"); }
  let parsed: ReturnType<typeof parseFrontmatter>;
  try { parsed = parseFrontmatter(text, { dataOnly: true }); } catch { return invalid("front_matter"); }
  if (!parsed.matter.trim()) return invalid("front_matter");
  const data_ = parsed.data as Record<string, unknown>;
  if (data_.schema !== 1) return invalid("schema");
  const name = typeof data_.name === "string" ? data_.name.trim() : "";
  const voices = data_.voices === undefined || data_.voices === null ? {} : data_.voices;
  const instructions = normalizeInstructions(parsed.content);
  const reason = personaFieldsInvalid({ name, voices, instructions });
  const shown = reason === "name" ? id : name;
  if (reason) return { ...invalid(reason, shown), instructionBytes: bytes(instructions) };
  return { id, name, voices: { ...(voices as Record<string, string>) }, instructionBytes: bytes(instructions), revision, instructions };
}

/** Standard: no file, no instructions, every service's default voice. */
export function standardPersona(providers: readonly LiveConversationProvider[]): LivePersona {
  const voices: Record<string, string> = {};
  for (const provider of providers) if (provider.defaultVoice) voices[provider.id] = provider.defaultVoice;
  return { id: STANDARD_PERSONA_ID, name: "Standard", voices, instructionBytes: 0, revision: STANDARD_PERSONA_REVISION, builtIn: true, instructions: "" };
}

/** What one persona means for each persona-capable service. */
export function providerStatus(persona: LivePersonaSummary, providers: readonly LiveConversationProvider[]): Record<string, LivePersonaProviderStatus> {
  const out: Record<string, LivePersonaProviderStatus> = {};
  if (persona.invalid) return out;
  for (const provider of providers) {
    if (!provider.voices || !provider.defaultVoice || provider.personaInstructionBytes === undefined) continue;
    const saved = persona.builtIn ? undefined : persona.voices[provider.id];
    const offered = saved !== undefined && provider.voices.some(voice => voice.id === saved);
    out[provider.id] = {
      voice: offered ? saved : provider.defaultVoice,
      voiceSource: offered ? "persona" : "default",
      ...(saved !== undefined && !offered ? { staleVoice: saved } : {}),
      maxInstructionBytes: provider.personaInstructionBytes,
      overLimit: persona.instructionBytes > provider.personaInstructionBytes,
    };
  }
  return out;
}

const summary = ({ instructions: _text, ...rest }: LivePersona): LivePersonaSummary => rest;

/** Files beyond the cap, ordered by name, stay listed but cannot be selected. */
function capped(personas: LivePersona[]): LivePersona[] {
  const ordered = [...personas].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  let usable = 0;
  return ordered.map(persona => {
    if (persona.invalid) return persona;
    if (++usable <= LIVE_PERSONA_LIMITS.maxPersonas) return persona;
    return { ...persona, invalid: "over_count" as const };
  });
}

// --- anchored file access ---

interface Directory { handle: FileHandle; path: string; dev: number; ino: number; at(name: string): string }

function errno(error: unknown): string | undefined { return (error as NodeJS.ErrnoException | undefined)?.code; }

async function openDirectory(path: string, display: string): Promise<Directory> {
  let handle: FileHandle;
  try { handle = await open(path, DIRECTORY_FLAGS); }
  catch (error) {
    if (errno(error) === "ELOOP" || errno(error) === "ENOTDIR") throw new PersonaError(503, "PERSONA_STORAGE");
    throw error;
  }
  const info = await handle.stat();
  return { handle, path: display, dev: info.dev, ino: info.ino, at: name => ANCHORED ? `/proc/self/fd/${handle.fd}/${name}` : join(display, name) };
}

async function closeChain(chain: Directory[] | null): Promise<void> {
  for (const entry of chain ?? []) await entry.handle.close().catch(() => {});
}

async function directoryChain(root: string, create: boolean): Promise<Directory[] | null> {
  const chain: Directory[] = [];
  try {
    chain.push(await openDirectory(root, root));
    for (const segment of PERSONA_DIR.split("/")) {
      const parent = chain.at(-1)!;
      const target = parent.at(segment), display = join(parent.path, segment);
      try { chain.push(await openDirectory(target, display)); continue; }
      catch (error) { if (errno(error) !== "ENOENT") throw error; }
      if (!create) { await closeChain(chain); return null; }
      try { await mkdir(target, { mode: 0o755 }); }
      catch (error) { if (errno(error) !== "EEXIST") throw error; }
      chain.push(await openDirectory(target, display));
    }
    return chain;
  } catch (error) {
    await closeChain(chain);
    throw error;
  }
}

/** Path-mode fallback: the paths must still name the opened directories. */
async function assertChain(chain: Directory[]): Promise<void> {
  if (ANCHORED) return;
  for (const entry of chain) {
    const info = await lstat(entry.path);
    if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== entry.dev || info.ino !== entry.ino) throw new PersonaError(503, "PERSONA_STORAGE");
  }
}

/** A bounded regular file without following a link; null when absent or not a plain file. */
async function readContained(path: string): Promise<Uint8Array | null> {
  let handle: FileHandle;
  // O_NONBLOCK: a FIFO or device planted at the path must not stall the host.
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (errno(error) === "ENOENT" || errno(error) === "ELOOP") return null;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    const data = Buffer.alloc(LIVE_PERSONA_LIMITS.maxFileBytes + 1);
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    return data.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

async function writeTemporary(dir: Directory, id: string, text: string): Promise<string> {
  const temporary = dir.at(`.${id}.md.${crypto.randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  return temporary;
}

// --- the service ---

export interface LivePersonaWriteFields { name: string; voices: Record<string, string>; instructions: string }

/** What a Start freezes: plain data, held with the conversation entry. */
export interface PersonaSnapshot { id: string; revision: string; voice?: string; instructions: string }

type PersonaStartResult =
  | { ok: true; snapshot: PersonaSnapshot }
  | { ok: false; code: "CONVERSATION_PERSONA_CHANGED" | "CONVERSATION_PERSONA" | "CONVERSATION_PERSONA_TOO_LONG" | "CONVERSATION_PERSONA_VOICE"; message: string };

export interface LivePersonaService {
  /** Standard first, then personas by name. */
  list(): Promise<LivePersonaSummary[]>;
  read(id: string): Promise<LivePersona | null>;
  create(fields: LivePersonaWriteFields & { id?: string }): Promise<LivePersona>;
  update(id: string, baseRevision: string, fields: LivePersonaWriteFields): Promise<LivePersona>;
  remove(id: string, baseRevision: string): Promise<void>;
  selection(): { value: string; revision: number };
  select(expected: number, value: string): Promise<{ saved: boolean; current: { value: string; revision: number } }>;
  /** Reads the files now. */
  status(): Promise<LivePersonaStatus>;
  /** The last status computed; refreshed by every read, write and Start. */
  cached(): LivePersonaStatus;
  /** Called with a fresh status after a write or selection, and when a read finds a change. */
  subscribe(listener: (status: LivePersonaStatus) => void): () => void;
  /** Read the disclosed persona once for a Start, against `providerId`. */
  resolveStart(ref: ConversationPersonaRef | undefined, provider: LiveConversationProvider): Promise<PersonaStartResult>;
}

export function createLivePersonaService(options: {
  brainPath?: string;
  db: Database;
  settingsWrites: Pick<SettingsWrites, "saveLivePersonaSelection">;
  providers: () => readonly LiveConversationProvider[];
}): LivePersonaService {
  const { brainPath, db, settingsWrites, providers } = options;
  const listeners = new Set<(status: LivePersonaStatus) => void>();
  let last: LivePersonaStatus | null = null;
  let lastKey = "";
  // One in-process writer: compare-then-replace stays atomic against itself.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => {});
    return run;
  };

  const readAll = async (): Promise<LivePersona[]> => {
    if (!brainPath) return [];
    const chain = await directoryChain(brainPath, false);
    if (!chain) return [];
    try {
      const dir = chain.at(-1)!;
      const out: LivePersona[] = [];
      const names = (await readdir(dir.at("."))).filter(name => name.endsWith(".md") && PERSONA_ID.test(name.slice(0, -3))).sort();
      // Bounded: a directory flooded with files cannot make every request read all of them.
      for (const name of names.slice(0, 256)) {
        const data = await readContained(dir.at(name));
        if (data) out.push(parsePersona(name.slice(0, -3), data));
      }
      await assertChain(chain);
      return capped(out);
    } finally { await closeChain(chain); }
  };

  const readCurrent = async (id: string): Promise<LivePersona | null> =>
    (await readAll()).find(persona => persona.id === id) ?? null;

  const compute = (personas: readonly LivePersona[]): LivePersonaStatus => {
    const registered = providers();
    const selected = getLivePersonaSelection(db).value;
    const found = selected === STANDARD_PERSONA_ID ? undefined : personas.find(persona => persona.id === selected);
    const missing = selected !== STANDARD_PERSONA_ID && !found;
    const persona = summary(found ?? standardPersona(registered));
    return { selected, selectedMissing: missing, selectedInvalid: !!persona.invalid,
      persona, personaRef: { id: persona.id, revision: persona.revision }, providers: providerStatus(persona, registered) };
  };

  const publish = (status: LivePersonaStatus, notify: boolean): LivePersonaStatus => {
    const key = JSON.stringify(status);
    const changed = key !== lastKey;
    last = status; lastKey = key;
    if (notify || changed) for (const listener of listeners) {
      try { listener(status); } catch { /* one listener never blocks another */ }
    }
    return status;
  };

  const refresh = async (notify = false): Promise<LivePersonaStatus> => {
    try { return publish(compute(await readAll()), notify); }
    catch { return publish(compute([]), notify); }
  };

  const requireRoot = (): string => {
    if (!brainPath) throw new PersonaError(503, "PERSONA_STORAGE");
    return brainPath;
  };

  const validated = (fields: LivePersonaWriteFields): LivePersonaWriteFields => {
    const reason = personaFieldsInvalid(fields);
    if (reason) throw new PersonaError(400, "PERSONA_INVALID", reason);
    return { name: fields.name.trim(), voices: { ...fields.voices }, instructions: normalizeInstructions(fields.instructions) };
  };

  const slug = (name: string): string => name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, LIVE_PERSONA_LIMITS.maxIdChars).replace(/-+$/g, "") || "persona";

  return {
    async list() {
      const personas = await readAll();
      publish(compute(personas), false);
      return [summary(standardPersona(providers())), ...personas.map(summary)];
    },

    async read(id) {
      if (id === STANDARD_PERSONA_ID) return standardPersona(providers());
      if (!PERSONA_ID.test(id)) return null;
      return readCurrent(id);
    },

    create(input) {
      return exclusive(async () => {
        const root = requireRoot();
        const fields = validated(input);
        const id = input.id ?? slug(fields.name);
        if (!PERSONA_ID.test(id) || id === STANDARD_PERSONA_ID) throw new PersonaError(400, "PERSONA_INVALID", "name");
        const existing = await readAll();
        if (existing.some(persona => persona.id === id)) throw new PersonaError(409, "PERSONA_EXISTS");
        if (existing.filter(persona => !persona.invalid).length >= LIVE_PERSONA_LIMITS.maxPersonas) throw new PersonaError(409, "PERSONA_LIMIT");
        const text = serializePersona(fields);
        const chain = (await directoryChain(root, true))!;
        try {
          const dir = chain.at(-1)!;
          await assertChain(chain);
          const temporary = await writeTemporary(dir, id, text);
          try {
            try { await link(temporary, dir.at(`${id}.md`)); }
            catch (error) { if (errno(error) === "EEXIST") throw new PersonaError(409, "PERSONA_EXISTS"); throw error; }
          } finally { await unlink(temporary).catch(() => {}); }
          await dir.handle.sync();
          await assertChain(chain);
        } finally { await closeChain(chain); }
        await refresh(true);
        return parsePersona(id, Buffer.from(text, "utf8"));
      });
    },

    update(id, baseRevision, input) {
      return exclusive(async () => {
        const root = requireRoot();
        if (id === STANDARD_PERSONA_ID) throw new PersonaError(409, "PERSONA_READ_ONLY");
        if (!PERSONA_ID.test(id)) throw new PersonaError(404, "PERSONA_NOT_FOUND");
        const fields = validated(input);
        const chain = await directoryChain(root, false);
        if (!chain) throw new PersonaError(404, "PERSONA_NOT_FOUND");
        const text = serializePersona(fields);
        try {
          const dir = chain.at(-1)!, final = dir.at(`${id}.md`);
          const current = await readContained(final);
          if (!current) throw new PersonaError(404, "PERSONA_NOT_FOUND");
          if (revisionOf(current) !== baseRevision) throw new PersonaError(409, "PERSONA_CHANGED");
          await assertChain(chain);
          const temporary = await writeTemporary(dir, id, text);
          try { await rename(temporary, final); }
          catch (error) { await unlink(temporary).catch(() => {}); throw error; }
          await dir.handle.sync();
          await assertChain(chain);
        } finally { await closeChain(chain); }
        await refresh(true);
        return parsePersona(id, Buffer.from(text, "utf8"));
      });
    },

    remove(id, baseRevision) {
      return exclusive(async () => {
        const root = requireRoot();
        if (id === STANDARD_PERSONA_ID) throw new PersonaError(409, "PERSONA_READ_ONLY");
        if (!PERSONA_ID.test(id)) throw new PersonaError(404, "PERSONA_NOT_FOUND");
        const chain = await directoryChain(root, false);
        if (!chain) throw new PersonaError(404, "PERSONA_NOT_FOUND");
        try {
          const dir = chain.at(-1)!, final = dir.at(`${id}.md`);
          const current = await readContained(final);
          if (!current) throw new PersonaError(404, "PERSONA_NOT_FOUND");
          if (revisionOf(current) !== baseRevision) throw new PersonaError(409, "PERSONA_CHANGED");
          // The selection moves to Standard first; the file goes only after that write succeeded.
          for (let attempt = 0; ; attempt++) {
            const selection = getLivePersonaSelection(db);
            if (selection.value !== id) break;
            if ((await settingsWrites.saveLivePersonaSelection(selection.revision, STANDARD_PERSONA_ID)).saved) break;
            if (attempt >= 3) throw new PersonaError(409, "LIVE_PERSONA_CHANGED");
          }
          await assertChain(chain);
          await unlink(final);
          await dir.handle.sync();
        } finally { await closeChain(chain); }
        await refresh(true);
      });
    },

    selection: () => getLivePersonaSelection(db),

    async select(expected, value) {
      if (value !== STANDARD_PERSONA_ID) {
        const persona = await readCurrent(value);
        if (!persona) throw new PersonaError(400, "PERSONA_NOT_FOUND");
        if (persona.invalid) throw new PersonaError(400, "PERSONA_INVALID", persona.invalid);
      }
      const result = await settingsWrites.saveLivePersonaSelection(expected, value);
      await refresh(result.saved);
      return result;
    },

    status: () => refresh(false),
    cached: () => last ?? publish(compute([]), false),

    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    async resolveStart(ref, provider) {
      // Absent: Standard, exactly the provider's behaviour before personas.
      if (!ref || ref.id === STANDARD_PERSONA_ID) {
        if (ref && ref.revision !== STANDARD_PERSONA_REVISION) {
          await refresh(true);
          return { ok: false, code: "CONVERSATION_PERSONA_CHANGED", message: "The persona changed. Review it and select Start again. Microphone off." };
        }
        return { ok: true, snapshot: { id: STANDARD_PERSONA_ID, revision: STANDARD_PERSONA_REVISION, instructions: "" } };
      }
      let personas: LivePersona[];
      try { personas = await readAll(); }
      catch { return { ok: false, code: "CONVERSATION_PERSONA", message: "The persona can't be read. Nothing was sent to the voice service." }; }
      publish(compute(personas), false);
      const persona = personas.find(entry => entry.id === ref.id);
      if (!persona || persona.revision !== ref.revision) {
        // The refused client gets the current status before the refusal.
        publish(compute(personas), true);
        return { ok: false, code: "CONVERSATION_PERSONA_CHANGED", message: "The persona changed. Review it and select Start again. Microphone off." };
      }
      if (persona.invalid) return { ok: false, code: "CONVERSATION_PERSONA", message: "This persona can't be used. Edit it or use Standard. Nothing was sent to the voice service." };
      const status = providerStatus(persona, [provider])[provider.id];
      if (!status) return { ok: false, code: "CONVERSATION_PERSONA", message: "This voice service doesn't support personas. Use Standard. Nothing was sent to the voice service." };
      if (status.overLimit) {
        const limit = status.maxInstructionBytes.toLocaleString("en-US");
        return { ok: false, code: "CONVERSATION_PERSONA_TOO_LONG", message: `Too long for this voice service (${limit} bytes); shorten it or change service. Nothing was sent to the voice service.` };
      }
      if (status.staleVoice !== undefined && ref.voice !== "default") {
        return { ok: false, code: "CONVERSATION_PERSONA_VOICE", message: "This persona's voice isn't offered by this voice service any more. Use the default voice this time or edit the persona. Nothing was sent to the voice service." };
      }
      return { ok: true, snapshot: { id: persona.id, revision: persona.revision,
        ...(status.voiceSource === "persona" && ref.voice !== "default" ? { voice: status.voice } : {}), instructions: persona.instructions } };
    },
  };
}
