export function preserveFontDates(tables, source = null) {
  const head = tables.get("head"), original = source?.get("head");
  if (!head || head.length < 36) return;
  // Font encoders otherwise insert wall-clock timestamps into identical
  // programs, defeating resource reuse when processing crosses a second.
  // Preserve supplied font dates; a raw CFF has no dates to copy.
  head.set(original?.length >= 36 ? original.subarray(20,36) : new Uint8Array(16),20);
}

// Assemble standalone OpenType/TrueType tables with fresh checksums.
export function sfnt(tables) {
  const entries = [...tables].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  let size = 12 + entries.length * 16;
  for (const [, bytes] of entries) size += (bytes.length + 3) & ~3;
  const bytes = new Uint8Array(size),
    view = new DataView(bytes.buffer);
  view.setUint32(0, (tables.has("CFF ") || tables.has("CFF2")) ? 0x4f54544f : 0x00010000);
  const power = Math.floor(Math.log2(entries.length));
  view.setUint16(4, entries.length);
  view.setUint16(6, 16 * 2 ** power);
  view.setUint16(8, power);
  view.setUint16(10, entries.length * 16 - 16 * 2 ** power);
  let offset = 12 + entries.length * 16,
    head;
  const checksum = (start, end) => {
    let sum = 0;
    for (let p = start; p < end; p += 4) sum = (sum + view.getUint32(p)) >>> 0;
    return sum;
  };
  entries.forEach(([tag, data], i) => {
    const record = 12 + 16 * i;
    bytes.set(new TextEncoder().encode(tag), record);
    bytes.set(data, offset);
    if (tag === "head") {
      head = offset;
      view.setUint32(head + 8, 0);
    }
    view.setUint32(
      record + 4,
      checksum(offset, offset + ((data.length + 3) & ~3)),
    );
    view.setUint32(record + 8, offset);
    view.setUint32(record + 12, data.length);
    offset += (data.length + 3) & ~3;
  });
  if (head !== undefined)
    view.setUint32(head + 8, (0xb1b0afba - checksum(0, size)) >>> 0);
  return bytes;
}
export function tablesOf(bytes, directoryOffset = 0) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    tables = new Map();
  for (let i = 0; i < view.getUint16(directoryOffset + 4); i++) {
    const p = directoryOffset + 12 + 16 * i,
      tag = new TextDecoder().decode(bytes.subarray(p, p + 4));
    const offset = view.getUint32(p + 8),
      length = view.getUint32(p + 12);
    tables.set(tag, bytes.slice(offset, offset + length));
  }
  return tables;
}
