/** Internal, bounded WebM/Opus duration accounting. Container clocks are not audio clocks.
 * Packet durations: RFC 6716 §3.1–3.2; element lengths: RFC 8794 §4–6;
 * block layout: https://www.matroska.org/technical/notes.html#block-structure .
 * Unsupported input permanently falls back at the caller. Never buffers a recording.
 */
const MAX_ELEMENT = 1024 * 1024;
const masters = new Set([0x18538067, 0x1f43b675, 0xa0, 0x1654ae6b, 0xae]);

function vint(bytes: number[], offset: number, id = false): { value: number; width: number; unknown: boolean } | null {
  const first = bytes[offset];
  if (first === undefined) return null;
  if (!first) throw new Error("Invalid VINT");
  let width = 1;
  while (!(first & (0x80 >> (width - 1)))) width++;
  if (width > (id ? 4 : 8)) throw new Error("Oversized VINT");
  if (bytes.length < offset + width) return null;
  let value = id ? first : first & (0xff >> width);
  let unknown = !id && value === (0xff >> width);
  for (let i = 1; i < width; i++) {
    const byte = bytes[offset + i]!;
    value = value * 256 + byte;
    unknown &&= byte === 255;
  }
  if (!unknown && !Number.isSafeInteger(value)) throw new Error("Unsafe length");
  return { value, width, unknown };
}

// Validate framing lengths as well as TOC count (RFC 6716 §3.2).
function packetFrames(packet: number[]): number {
  const code = packet[0]! & 3;
  let offset = 1;
  const length = () => {
    const first = packet[offset++];
    if (first === undefined) throw new Error("Missing frame length");
    if (first < 252) return first;
    const second = packet[offset++];
    if (second === undefined) throw new Error("Missing frame length");
    return first + 4 * second;
  };
  let count = code === 0 ? 1 : 2;
  let end = packet.length;
  let vbr = code === 2;
  if (code === 3) {
    const control = packet[offset++];
    if (control === undefined || !(count = control & 63)) throw new Error("Missing frame count");
    vbr = !!(control & 128);
    if (control & 64) {
      let padding = 0, byte: number | undefined;
      do {
        byte = packet[offset++];
        if (byte === undefined) throw new Error("Missing padding");
        padding += byte === 255 ? 254 : byte;
      } while (byte === 255);
      end -= padding;
    }
  }
  if (vbr) {
    let consumed = 0;
    for (let i = 1; i < count; i++) consumed += length();
    if (end - offset - consumed < 0 || end - offset - consumed > 1275) throw new Error("Invalid VBR lengths");
  } else if (end < offset || (end - offset) % count || (end - offset) / count > 1275) throw new Error("Invalid CBR lengths");
  return count;
}

/** Cumulative 48 kHz samples in complete packets, or permanent conservative fallback. */
export function createEncodedDurationMeter(mime: string): { push(bytes: Uint8Array): number | null } {
  let failed = mime !== "audio/webm;codecs=opus";
  let samples = 0;
  let position = 0;
  let header: number[] = [];
  let payload: number[] = [];
  let pending: { id: number; remaining: number } | null = null;
  const stack: { id: number; end: number }[] = [];
  let tracks = 0;
  let opus = false;
  let track = 0;
  function complete(id: number) {
    if (id === 0x86) {
      if (String.fromCharCode(...payload) !== "A_OPUS" || opus) throw new Error("Unsupported codec");
      opus = true;
    } else if (id === 0xd7) {
      track = payload.reduce((n, b) => n * 256 + b, 0);
      if (!track) throw new Error("Invalid track");
    } else if (id === 0xa3 || id === 0xa1) {
      if (tracks !== 1 || !opus || !track) throw new Error("Unsupported tracks");
      const t = vint(payload, 0);
      if (!t || t.unknown || t.value !== track || payload.length < t.width + 4) throw new Error("Invalid block");
      if (payload[t.width + 2]! & 6) throw new Error("Unsupported lacing");
      const packet = payload.slice(t.width + 3);
      const toc = packet[0]!;
      const config = toc >> 3;
      const frame = config < 12 ? [480, 960, 1920, 2880][config % 4]! : config < 16 ? [480, 960][config % 2]! : [120, 240, 480, 960][config % 4]!;
      const count = packetFrames(packet);
      if (frame * count > 5760) throw new Error("Invalid packet");
      samples += frame * count;
    }
    payload = [];
  }
  return { push(bytes) {
    if (failed) return null;
    try {
      for (const byte of bytes) {
        position++;
        if (pending) {
          if ([0x86, 0xd7, 0xa3, 0xa1].includes(pending.id)) payload.push(byte);
          if (--pending.remaining === 0) { complete(pending.id); pending = null; }
          continue;
        }
        if (!header.length) {
          while (stack.length && stack.at(-1)!.end === position - 1) stack.pop();
        }
        header.push(byte);
        const id = vint(header, 0, true);
        if (!id) continue;
        const size = vint(header, id.width);
        if (!size) continue;
        // Unknown-size clusters terminate at the next level-one cluster.
        if (id.value === 0x1f43b675 && stack.at(-1)?.id === 0x1f43b675 && stack.at(-1)!.end === Infinity) stack.pop();
        const end = size.unknown ? Infinity : position + size.value;
        if (size.unknown && id.value !== 0x18538067 && id.value !== 0x1f43b675) throw new Error("Unknown size");
        if (end > (stack.at(-1)?.end ?? Infinity)) throw new Error("Parent overflow");
        if (masters.has(id.value)) {
          if (stack.length >= 8) throw new Error("Excessive nesting");
          if (id.value === 0xae && ++tracks !== 1) throw new Error("Multiple tracks");
          stack.push({ id: id.value, end });
        } else {
          if (size.value > MAX_ELEMENT) throw new Error("Oversized element");
          pending = { id: id.value, remaining: size.value };
          if (size.value === 0) { complete(id.value); pending = null; }
        }
        header = [];
      }
      return samples;
    } catch {
      failed = true; header = []; payload = []; stack.length = 0; pending = null;
      return null;
    }
  } };
}
