/**
 * A minimal ustar writer for staging: regular files only, fixed owner and
 * time, so one bundle always produces the same bytes. GNU tar creates the
 * parent directories on extraction. Every file is mode 0644: a SourceBundle
 * carries no mode, so an executable bit is not kept.
 */

const BLOCK = 512;

function field(header: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = new TextEncoder().encode(value);
  header.set(bytes.subarray(0, length), offset);
}

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0") + "\u0000";
}

/** Split a path into ustar `prefix` and `name`, or undefined when it cannot fit. */
function splitPath(path: string): { prefix: string; name: string } | undefined {
  const bytes = (s: string) => new TextEncoder().encode(s).byteLength;
  if (bytes(path) <= 100) return { prefix: "", name: path };
  for (let i = path.indexOf("/"); i !== -1; i = path.indexOf("/", i + 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (bytes(prefix) <= 155 && bytes(name) <= 100 && name !== "") return { prefix, name };
  }
  return undefined;
}

export interface TarEntry {
  path: string;
  data: Uint8Array;
}

/** The archive bytes, or the first path that does not fit a ustar header. */
export function writeTar(entries: TarEntry[]): { ok: true; bytes: Uint8Array } | { ok: false; path: string } {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (const entry of entries) {
    const parts = splitPath(entry.path);
    if (!parts) return { ok: false, path: entry.path };
    const header = new Uint8Array(BLOCK);
    field(header, 0, 100, parts.name);
    field(header, 100, 8, octal(0o644, 8));
    field(header, 108, 8, octal(0, 8));
    field(header, 116, 8, octal(0, 8));
    field(header, 124, 12, octal(entry.data.byteLength, 12));
    field(header, 136, 12, octal(0, 12));
    field(header, 148, 8, "        ");
    field(header, 156, 1, "0");
    field(header, 257, 6, "ustar\u0000");
    field(header, 263, 2, "00");
    field(header, 345, 155, parts.prefix);
    let sum = 0;
    for (const byte of header) sum += byte;
    field(header, 148, 8, sum.toString(8).padStart(6, "0") + "\u0000 ");
    const padded = Math.ceil(entry.data.byteLength / BLOCK) * BLOCK;
    const body = new Uint8Array(padded);
    body.set(entry.data);
    chunks.push(header, body);
    total += BLOCK + padded;
  }
  chunks.push(new Uint8Array(BLOCK * 2));
  total += BLOCK * 2;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: out };
}
