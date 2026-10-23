import * as m from "mupdf";
import * as fontkit from "fontkit";
import opentype from "opentype.js";
import { esc } from "./ofd-write-utils.js";

import { sfnt, tablesOf, preserveFontDates } from "./font-container.js";
import { subsetFont } from "./font-subset.js";
import { usableUnicode, reverseCharacterMap } from "./pdf-character-map.js";
import { nativeGlyphPath } from "./pdf-glyph-outline.js";

// FreeType addresses standalone CID-keyed CFF glyphs by CID. OpenType and
// fontkit use the physical CharStrings index, which may differ in a subset.
function cffGlyphCids(cff) {
  if (!cff.isCIDFont) return null;
  const charset = cff.topDict.charset;
  const cids = [0];
  if (charset.version === 0) cids.push(...charset.glyphs);
  else if (charset.version === 1 || charset.version === 2) {
    for (const { first, nLeft } of charset.ranges)
      for (let i = 0; i <= nLeft; i++) cids.push(first + i);
  } else throw new Error("CID CFF 字体的 charset 格式无效");
  if (
    cids.length !== cff.topDict.CharStrings.length ||
    new Set(cids).size !== cids.length ||
    cids.some((cid) => !Number.isInteger(cid) || cid < 0 || cid > 65535)
  )
    throw new Error("CID CFF 字体的字形映射无效");
  return cids;
}

function fontProgram(pdf, font) {
  const ref = pdf.addFont(font),
    descriptor = ref.get("DescendantFonts", 0, "FontDescriptor");
  try {
    const type1 = descriptor.get("FontFile");
    try {
      if (type1.isStream())
        throw new Error("暂不支持传统 PostScript Type 1 字体程序（非 CFF）");
    } finally {
      type1.destroy();
    }
    for (const key of ["FontFile2", "FontFile3"]) {
      const stream = descriptor.get(key);
      try {
        if (!stream.isStream()) continue;
        const buffer = stream.readStream();
        try {
          return buffer.asUint8Array().slice();
        } finally {
          buffer.destroy();
        }
      } finally {
        stream.destroy();
      }
    }
    throw new Error("无法取得可嵌入的字体程序");
  } finally {
    descriptor.destroy();
    ref.destroy();
  }
}
export class PdfFontExporter {
  constructor(pkg, subsetFonts = false) {
    this.subsetFonts = subsetFonts;
    this.pkg = pkg;
    this.pdf = new m.PDFDocument();
    this.fonts = new Map();
  }
  get(font) {
    if (this.fonts.has(font.pointer)) return this.fonts.get(font.pointer);
    const name = font.getName();
    try {
      const bytes = fontProgram(this.pdf, font);
      let kit, cff, units, widths, cidToGid;
      if (bytes[0] === 1 && bytes[2] >= 4) {
        kit = fontkit.create(sfnt(new Map([["CFF ", bytes]])));
        cff = kit["CFF "];
        const fm = cff.topDict.FontMatrix || [0.001, 0, 0, 0.001, 0, 0];
        if (fm[1] || fm[2] || fm[4] || fm[5] || fm[0] !== fm[3] || fm[0] <= 0)
          throw new Error("CFF 字体使用特殊 FontMatrix");
        units = Math.round(1 / fm[0]);
        const count = cff.topDict.CharStrings.length;
        if (count < 1 || count > 65535 || units < 16 || units > 16384)
          throw new Error("CFF 字体规模或单位无效");
        const cids = cffGlyphCids(cff);
        if (cids) cidToGid = new Map(cids.map((cid, gid) => [cid, gid]));
        widths = Array.from({ length: count }, (_, gid) =>
          Math.round(font.advanceGlyph(cids ? cids[gid] : gid) * units),
        );
      } else {
        kit = fontkit.create(bytes);
        if (kit.fonts || !kit.numGlyphs)
          throw new Error("不支持该字体程序格式");
      }
      const id = this.pkg.next();
      const entry = {
        id,
        name,
        bytes,
        sourceBytes:bytes,
        kit,
        cff,
        units,
        widths,
        cidToGid,
        font: new m.Font(font.pointer),
        unicodes: new Map(),
        glyphMap: this.subsetFonts ? new Map([[0, 0]]) : null,
        glyphCount: cff ? widths.length : kit.numGlyphs,
        mappingIssues: new Map(),
      };
      try { entry.bytes = this.prepare(entry); }
      catch (error) { entry.font.destroy(); throw error; }
      this.fonts.set(font.pointer, entry);
      return entry;
    } catch (error) {
      const outlineReason = error.message.includes("no font file")
        ? "字体没有可直接嵌入的 OpenType 程序" : error.message;
      const entry = { name, font: new m.Font(font.pointer), outlineReason, mappingIssues: new Map() };
      this.fonts.set(font.pointer, entry);
      return entry;
    }
  }
  glyphIndex(entry, gid) {
    if (entry.cidToGid) gid = entry.cidToGid.get(gid);
    if (!Number.isInteger(gid) || gid < 0 || gid >= entry.glyphCount)
      throw new Error(`字体“${entry.name}”字形索引超出范围。`);
    return gid;
  }
  resolveText(entry, gid, unicodes, pageNumber) {
    if (unicodes.every(usableUnicode)) return unicodes;
    const index = this.glyphIndex(entry, gid);
    // Only a single unknown character can be recovered from a font cmap.
    // An incomplete cluster has no reliable logical text for this glyph.
    let recovered;
    if (unicodes.length === 1 && !entry.cff) {
      entry.characterMap ??= reverseCharacterMap(entry.kit);
      recovered = entry.characterMap.get(index);
    }
    const kind = Number.isInteger(recovered) ? "recovered" : "unknown";
    if (!entry.mappingIssues.has(kind)) entry.mappingIssues.set(kind, new Set());
    entry.mappingIssues.get(kind).add(pageNumber);
    return kind === "recovered" ? [recovered] : null;
  }
  warnings() {
    const result = [];
    for (const entry of this.fonts.values()) {
      for (const [kind, pages] of entry.mappingIssues) {
        const numbers = [...pages].sort((a, b) => a - b);
        const where = `第 ${numbers.slice(0, 12).join("、")}${numbers.length > 12 ? ` 等 ${numbers.length}` : ""} 页`;
        result.push(`字体“${entry.name}”（${where}）：` + (kind === "recovered"
          ? "已依据内嵌字体的唯一字符映射恢复缺失文字，保留原字形。"
          : `${kind === "unknown" ? "原 PDF 的部分字符映射缺失或无效" : kind}，对应字形已${kind === "unknown" ? "转为轮廓" : "保存为轮廓或复合图形对象"}；仅这些字形不能选择、搜索或复制，其余文字保留。`));
      }
    }
    return result;
  }
  noteOutline(entry, pageNumber, reason) {
    if (!entry.mappingIssues.has(reason)) entry.mappingIssues.set(reason, new Set());
    entry.mappingIssues.get(reason).add(pageNumber);
  }
  useGlyph(entry, gid, unicodes) {
    gid = this.glyphIndex(entry, gid);
    if (!entry.unicodes.has(gid)) entry.unicodes.set(gid, unicodes[0]);
    if (!entry.glyphMap) return gid;
    if (!entry.glyphMap.has(gid)) entry.glyphMap.set(gid, entry.glyphMap.size);
    return entry.glyphMap.get(gid);
  }
  nativeGlyphPath(entry,gid) { return nativeGlyphPath(entry.font,gid); }
  glyphPath(entry, gid) {
    if (entry.outlineReason) {
      entry.outlines ??= new Map();
      if (!entry.outlines.has(gid)) entry.outlines.set(gid, nativeGlyphPath(entry.font, gid));
      const path = new m.Path();
      entry.outlines.get(gid).walk({
        moveTo: (...p) => path.moveTo(...p), lineTo: (...p) => path.lineTo(...p),
        curveTo: (...p) => path.curveTo(...p), closePath: () => path.closePath(),
      });
      return path;
    }
    const path = new m.Path();
    let x = 0, y = 0;
    try {
      for (const { command, args } of entry.kit.getGlyph(this.glyphIndex(entry, gid)).path.commands) {
        if (command === "quadraticCurveTo") {
          const [cx, cy, ex, ey] = args;
          path.curveTo(x + (cx - x) * 2 / 3, y + (cy - y) * 2 / 3,
            ex + (cx - ex) * 2 / 3, ey + (cy - ey) * 2 / 3, ex, ey);
        } else if (command === "bezierCurveTo") path.curveTo(...args);
        else if (command === "closePath") path.closePath();
        else if (command === "moveTo") path.moveTo(...args);
        else if (command === "lineTo") path.lineTo(...args);
        else throw new Error(`无法读取字形轮廓：${command}`);
        if (args.length) [x, y] = args.slice(-2);
      }
      path.transform(m.Matrix.scale(1 / (entry.units || entry.kit.unitsPerEm), 1 / (entry.units || entry.kit.unitsPerEm)));
      return path;
    } catch (error) { path.destroy(); throw error; }
  }
  prepare(entry) {
    let bytes = entry.sourceBytes;
    if (entry.cff) {
      const glyphs = entry.widths.map(
        (advanceWidth, i) =>
          new opentype.Glyph({
            name: i === 0 ? ".notdef" : `gid${i}`,
            advanceWidth,
            unicode: entry.unicodes.get(i),
            path: new opentype.Path(),
          }),
      );
      const font = new opentype.Font({
        familyName: entry.name,
        styleName: "Regular",
        unitsPerEm: entry.units,
        ascender: entry.units,
        descender: -Math.round(entry.units / 4),
        glyphs,
      });
      const tables = tablesOf(new Uint8Array(font.toArrayBuffer()));
      preserveFontDates(tables);
      tables.set("CFF ", entry.sourceBytes);
      const bbox = entry.cff.topDict.FontBBox;
      if (bbox?.length === 4) {
        const head = tables.get("head"),
          view = new DataView(head.buffer, head.byteOffset, head.byteLength);
        bbox.forEach((v, i) => {
          if (!Number.isFinite(v) || v < -32768 || v > 32767)
            throw new Error("CFF 字体边界超出 OpenType 范围。");
          view.setInt16(36 + 2 * i, i < 2 ? Math.floor(v) : Math.ceil(v));
        });
      }
      bytes = sfnt(tables);
      // Validate the finished standalone OpenType, not merely a renamed .cff.
      if (fontkit.create(bytes).numGlyphs !== entry.glyphCount)
        throw new Error("OpenType 字形数量校验失败。");
    }
    if (entry.cidToGid)
      bytes = subsetFont(bytes, new Map(entry.widths.map((_, gid) => [gid, gid])), entry.unicodes, {onRepair:reason=>{
        this.pkg.documentWarnings.add(`字体“${entry.name}”CID CFF 规范化编码失败，已重建字形程序；原字体 hinting（小字号像素微调）不保留。原因：${reason}`);
      }});
    // Loading the finished program also checks the font consumed by preview.
    const check = new m.Font(entry.name, bytes);
    check.destroy();
    return bytes;
  }
  finish() {
    for (const entry of this.fonts.values()) {
      if (entry.outlineReason || !entry.unicodes.size) continue;
      let bytes = entry.bytes;
      if(entry.cff) {
        try {bytes=this.prepare(entry);}
        catch(error) {this.pkg.documentWarnings.add(`字体“${entry.name}”字符表更新失败，保留已验证的字体及文字对象映射：${error.message}`);}
      }
      if (entry.glyphMap) {
        bytes = subsetFont(bytes, entry.glyphMap, entry.unicodes, {onRepair:reason=>{
          this.pkg.documentWarnings.add(`字体“${entry.name}”原始子集编码失败，已按实际使用的字形重建紧凑 OpenType 子集，保留文字和字形编号；原字体 hinting（小字号像素微调）不保留，细小边缘可能有差异。原因：${reason}`);
        }});
      }
      const file = this.pkg.binary(bytes, "otf");
      this.pkg.fonts.push(`<ofd:Font ID="${entry.id}" FontName="${esc(entry.name)}"><ofd:FontFile>${file}</ofd:FontFile></ofd:Font>`);
    }
  }
  destroy() {
    for (const entry of this.fonts.values()) {
      entry.font.destroy();
      for (const path of entry.outlines?.values() || []) path.destroy();
    }
    this.pdf.destroy();
  }
}
