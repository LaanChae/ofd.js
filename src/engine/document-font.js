import { Font } from "mupdf";
import { sfnt, tablesOf } from "./font-container.js";

// MuPDF's PDF writer also enforces fsType. Normalize only its working copy;
// keep the source font, glyph IDs, metrics and all unrelated tables unchanged.
export function documentFont(name, bytes, index = 0) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const signature = view.getUint32(0);
  if (signature === 0x74746366) {
    if (index < 0 || index >= view.getUint32(8)) throw new Error("字体集合索引无效。");
    offset = view.getUint32(12 + 4 * index);
  } else if (![0x00010000, 0x4f54544f, 0x74727565].includes(signature)) {
    return new Font(name, bytes, index);
  }
  for (let i = 0; i < view.getUint16(offset + 4); i++) {
    const record = offset + 12 + 16 * i;
    if (view.getUint32(record) !== 0x4f532f32) continue;
    const table = view.getUint32(record + 8), length = view.getUint32(record + 12);
    if (length < 10 || view.getUint16(table + 8) === 0) break;
    const tables = tablesOf(bytes, offset), os2 = tables.get("OS/2");
    new DataView(os2.buffer, os2.byteOffset, os2.byteLength).setUint16(8, 0);
    // A modified font cannot retain the original digital signature.
    tables.delete("DSIG");
    return new Font(name, sfnt(tables));
  }
  return new Font(name, bytes, index);
}
