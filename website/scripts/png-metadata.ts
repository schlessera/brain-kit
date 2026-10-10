// Native screenshot provenance, inserted without touching the captured pixels.
export function pngMetadata(bytes: Uint8Array, metadata: object) {
  const body = Buffer.from(`impeccable:prompt\0Source: actual production UI and native Chromium rendering; fictional Odyssey data only. No model generation. ${JSON.stringify(metadata)}`, 'utf8');
  const type = Buffer.from('tEXt');
  const chunk = Buffer.alloc(body.length + 12);
  chunk.writeUInt32BE(body.length, 0); type.copy(chunk, 4); body.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([type, body])) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return Buffer.concat([bytes.slice(0, -12), chunk, bytes.slice(-12)]);
}
