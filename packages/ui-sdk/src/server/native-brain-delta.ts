/** Candidate extraction only: never replay a send stream or follow its paths. */
export interface NativeBrainRootIdentity {
  uuid: string;
  transaction: bigint;
}

export interface NativeBrainDeltaCandidate {
  paths: string[];
  /** Expand only endpoints that are directories in either sealed root. */
  rename?: { from: string; to: string };
}

export class NativeBrainDeltaError extends Error {
  readonly reason = "native_brain_delta_invalid";
}

// Protocol v1: packed LE headers, CRC32C seed zero, checksum field zeroed.
// https://btrfs.readthedocs.io/en/latest/dev/dev-send-stream.html
// https://github.com/torvalds/linux/blob/v6.16/fs/btrfs/send.h
const MAGIC = new TextEncoder().encode("btrfs-stream\0");
const MAX_COMMAND = 64 * 1024;
const HEADER_BYTES = 10;
const PATH = 15, PATH_TO = 16, PATH_LINK = 17, CLONE_PATH = 22;
const SNAPSHOT = 2, SYMLINK = 8, RENAME = 9, LINK = 10, END = 21;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// Required attributes. Only UTIMES additionally accepts the defined OTIME.
const attributes = new Map<number, readonly number[]>([
  [SNAPSHOT, [PATH, 1, 2, 20, 21]],
  [3, [PATH, 3]], [4, [PATH, 3]], [5, [PATH, 3, 5, 8]],
  [6, [PATH, 3]], [7, [PATH, 3]], [SYMLINK, [PATH, 3, PATH_LINK]],
  [RENAME, [PATH, PATH_TO]], [LINK, [PATH, PATH_LINK]],
  [11, [PATH]], [12, [PATH]], [13, [PATH, 13, 14]], [14, [PATH, 13]],
  // WRITE is intentionally absent: the owner must request --no-data.
  [16, [PATH, 18, 24, 20, 21, CLONE_PATH, 23]],
  [17, [PATH, 4]], [18, [PATH, 5]], [19, [PATH, 6, 7]],
  [20, [PATH, 11, 10, 9]], [END, []], [22, [PATH, 18, 4]],
]);
const u64 = new Set([2, 3, 4, 5, 6, 7, 8, 18, 21, 23, 24]);

function invalid(message: string): never { throw new NativeBrainDeltaError(message); }

function crc32c(bytes: Uint8Array): number {
  let crc = 0;
  for (let index = 0; index < bytes.length; index++) {
    crc ^= index >= 6 && index < 10 ? 0 : bytes[index]!;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
  }
  return crc >>> 0;
}

function text(bytes: Uint8Array): string {
  try { return decoder.decode(bytes); }
  catch { return invalid("Native delta contains a non-UTF-8 name."); }
}

function relative(bytes: Uint8Array, rootAllowed = false): string {
  const value = text(bytes);
  if (value === "" && rootAllowed) return value;
  if (!value || value.includes("\0") || value.startsWith("/") || value.split("/").some(part => !part || part === "." || part === "..")) {
    invalid("Native delta contains an invalid relative path.");
  }
  return value;
}

function fields(command: number, data: Uint8Array): Map<number, Uint8Array> {
  const required = attributes.get(command);
  if (!required) invalid("Native delta contains an unsupported command.");
  const result = new Map<number, Uint8Array>();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let offset = 0; offset < data.length;) {
    if (data.length - offset < 4) invalid("Native delta has a truncated attribute header.");
    const kind = view.getUint16(offset, true), size = view.getUint16(offset + 2, true);
    offset += 4;
    if (size > data.length - offset) invalid("Native delta has a truncated attribute.");
    if (!required.includes(kind) && !(command === 20 && kind === 12)) invalid("Native delta contains an unexpected attribute.");
    if (result.has(kind)) invalid("Native delta contains a duplicate attribute.");
    if ((u64.has(kind) && size !== 8) || ([1, 20].includes(kind) && size !== 16) || (kind >= 9 && kind <= 12 && size !== 12)) {
      invalid("Native delta contains an invalid attribute size.");
    }
    result.set(kind, data.subarray(offset, offset + size));
    offset += size;
  }
  if (required.some(kind => !result.has(kind))) invalid("Native delta is missing a required attribute.");
  return result;
}

function identity(values: Map<number, Uint8Array>, uuid: number, transaction: number): NativeBrainRootIdentity {
  const bytes = values.get(transaction)!;
  return { uuid: [...values.get(uuid)!].map(byte => byte.toString(16).padStart(2, "0")).join(""),
    transaction: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true) };
}
const same = (a: NativeBrainRootIdentity, b: NativeBrainRootIdentity) => a.uuid === b.uuid && a.transaction === b.transaction;

/**
 * Parse one incremental v1 --no-data stream for the exact sealed root pair.
 * Candidates are provisional until natural EOF after END and helper exit 0.
 * The caller expands directory rename endpoints in BOTH sealed roots and
 * changed inode aliases through its maintained metadata index. Other directory
 * metadata (especially root/parent UTIMES) never requests subtree expansion.
 * Synthetic send paths can be absent from both roots; discard them only after
 * rename expansion. This parser does not claim completeness on its own.
 */
export async function* parseNativeBrainDelta(chunks: AsyncIterable<Uint8Array>, options: {
  before: NativeBrainRootIdentity; after: NativeBrainRootIdentity; signal?: AbortSignal;
}): AsyncGenerator<NativeBrainDeltaCandidate> {
  for (const root of [options.before, options.after]) {
    if (!/^[a-f0-9]{32}$/.test(root.uuid) || typeof root.transaction !== "bigint" || root.transaction < 0n || root.transaction > 0xffffffffffffffffn) invalid("Invalid expected native root identity.");
  }
  const iterator = chunks[Symbol.asyncIterator]();
  let chunk: Uint8Array = new Uint8Array(), position = 0, eof = false;
  async function next(): Promise<void> {
    options.signal?.throwIfAborted();
    const result = await new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
      const stop = () => reject(options.signal!.reason);
      options.signal?.addEventListener("abort", stop, { once: true });
      iterator.next().then(value => { options.signal?.removeEventListener("abort", stop); resolve(value); },
        error => { options.signal?.removeEventListener("abort", stop); reject(error); });
    });
    options.signal?.throwIfAborted();
    if (result.done) { eof = true; return; }
    if (!(result.value instanceof Uint8Array) || !result.value.length || result.value.length > MAX_COMMAND) invalid("Native delta input chunk is empty or exceeds its bounded buffer.");
    chunk = result.value; position = 0;
  }
  async function read(size: number, allowEof = false): Promise<Uint8Array | null> {
    const result = new Uint8Array(size);
    let copied = 0;
    while (copied < size) {
      options.signal?.throwIfAborted();
      if (position === chunk.length && !eof) await next();
      if (eof) {
        if (allowEof && copied === 0) return null;
        invalid("Native delta ended before its declared bytes.");
      }
      const count = Math.min(size - copied, chunk.length - position);
      result.set(chunk.subarray(position, position + count), copied);
      position += count; copied += count;
    }
    return result;
  }
  try {
    const header = (await read(MAGIC.length + 4))!;
    if (!MAGIC.every((byte, index) => header[index] === byte) || new DataView(header.buffer).getUint32(MAGIC.length, true) !== 1) {
      invalid("Native delta requires the v1 send stream header.");
    }
    let started = false, ended = false;
    for (;;) {
      const commandHeader = await read(HEADER_BYTES, true);
      if (!commandHeader) {
        if (!ended) invalid("Native delta is missing its terminal END command.");
        return;
      }
      if (ended) invalid("Native delta contains data after END.");
      const view = new DataView(commandHeader.buffer), size = view.getUint32(0, true), command = view.getUint16(4, true);
      if (size > MAX_COMMAND - HEADER_BYTES) invalid("Native delta command exceeds the v1 bound.");
      const record = new Uint8Array(HEADER_BYTES + size);
      record.set(commandHeader); record.set((await read(size))!, HEADER_BYTES);
      if (crc32c(record) !== view.getUint32(6, true)) invalid("Native delta command checksum failed.");
      const values = fields(command, record.subarray(HEADER_BYTES));
      if (!started) {
        if (command !== SNAPSHOT) invalid("Native delta must start with one incremental SNAPSHOT.");
        relative(values.get(PATH)!);
        if (!same(identity(values, 1, 2), options.after) || !same(identity(values, 20, 21), options.before)) invalid("Native delta does not match its sealed root pair.");
        started = true; continue;
      }
      if (command === SNAPSHOT) invalid("Native delta contains multiple snapshots.");
      if (command === END) { ended = true; continue; }
      const path = relative(values.get(PATH)!, [13, 14, 18, 19, 20].includes(command));
      const paths = path ? [path] : [];
      if (command === RENAME) {
        const to = relative(values.get(PATH_TO)!);
        yield { paths: [path, to], rename: { from: path, to } }; continue;
      }
      if (command === LINK) paths.push(relative(values.get(PATH_LINK)!));
      if (command === SYMLINK) {
        // Link text is data, not a traversal candidate; absolute targets are valid.
        const target = text(values.get(PATH_LINK)!);
        if (!target || target.includes("\0")) invalid("Native delta contains an empty or NUL symlink target.");
      }
      if (command === 16) {
        const source = identity(values, 20, 21);
        if (!same(source, options.before) && !same(source, options.after)) invalid("Native delta references an unadmitted clone root.");
        paths.push(relative(values.get(CLONE_PATH)!));
      }
      if (paths.length) yield { paths };
    }
  } finally {
    // Cancellation must not await a pending read; the owner terminates its child.
    void iterator.return?.().catch(() => {});
  }
}
