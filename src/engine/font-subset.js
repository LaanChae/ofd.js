import * as fontkit from "fontkit";
import opentype from "opentype.js";
import { rebuildSubsetFont } from "./font-subset-rebuild.js";
import { sfnt, tablesOf, preserveFontDates } from "./font-container.js";

// fontkit subsets target PDF embedding. Add the standalone tables required by
// OFD, rebuilding every table that contains glyph indices after remapping.
export function subsetFont(bytes, glyphMap, unicodes, {onRepair} = {}) {
  const font = fontkit.create(bytes);
  // The output GID is the contract with every OFD Text/CGTransform, not the
  // insertion order of a caller's Map. Validate it before trying either encoder.
  glyphMap=new Map([...glyphMap].sort((a,b)=>a[1]-b[1]));
  if(glyphMap.get(0)!==0||[...glyphMap].some(([oldId,newId],index)=>
    !Number.isInteger(oldId)||oldId<0||oldId>=font.numGlyphs||newId!==index))
    throw new Error("字体子集的字形映射无效。");
  try {return encodeSubset(bytes,font,glyphMap,unicodes);}
  catch(error) {
    let result;
    try {result=rebuildSubsetFont(bytes,font,glyphMap,unicodes);}
    catch(repair) {throw new Error(`字体子集编码失败：${error.message}；重建子集也失败：${repair.message}`);}
    onRepair?.(error.message);
    return result;
  }
}

function encodeSubset(bytes, font, glyphMap, unicodes) {
  const subset = font.createSubset();
  for (const [oldId, newId] of glyphMap) {
    if (subset.includeGlyph(oldId) !== newId)
      throw new Error("字体子集的字形编号与文字对象不一致。");
  }
  // Encoding adds composite dependencies after the explicitly used glyphs,
  // leaving the IDs already written to all page TextObjects unchanged.
  const program = subset.encode(),
    original = tablesOf(bytes),
    isCff = original.has("CFF ");
  const glyphs = subset.glyphs.map((oldId, id) => {
    const source = font.getGlyph(oldId);
    return new opentype.Glyph({
      name: id === 0 ? ".notdef" : `gid${id}`,
      unicode: unicodes.get(oldId),
      advanceWidth: source.advanceWidth,
      path: new opentype.Path(),
    });
  });
  const metadata = new opentype.Font({
    familyName: font.familyName || "EmbeddedFont",
    styleName: font.subfamilyName || "Regular",
    unitsPerEm: font.unitsPerEm,
    ascender: font.ascent,
    descender: font.descent,
    glyphs,
  });
  const generated = tablesOf(new Uint8Array(metadata.toArrayBuffer())),
    tables = isCff ? new Map() : tablesOf(program);
  if (isCff) {
    tables.set("CFF ", program);
    tables.set("head", original.get("head"));
    const hhea = original.get("hhea");
    new DataView(hhea.buffer, hhea.byteOffset, hhea.byteLength).setUint16(
      34,
      glyphs.length,
    );
    tables.set("hhea", hhea);
    tables.set("maxp", generated.get("maxp"));
    // Keep the real left side bearings as well as the original advances.
    const hmtx = new Uint8Array(glyphs.length * 4),
      view = new DataView(hmtx.buffer);
    subset.glyphs.forEach((oldId, id) => {
      const metrics = font.hmtx.metrics.get(
        Math.min(oldId, font.hhea.numberOfMetrics - 1),
      );
      const bearing =
        oldId < font.hhea.numberOfMetrics
          ? metrics.bearing
          : font.hmtx.bearings.get(oldId - font.hhea.numberOfMetrics);
      view.setUint16(id * 4, metrics.advance);
      view.setInt16(id * 4 + 2, bearing);
    });
    tables.set("hmtx", hmtx);
  }
  // Preserve names, licensing flags and font-wide metrics; never copy stale
  // layout, kerning or glyph-name tables indexed by the original glyph IDs.
  for (const tag of ["name", "OS/2"])
    tables.set(tag, original.get(tag) || generated.get(tag));
  for (const tag of ["cmap", "post"]) tables.set(tag, generated.get(tag));
  preserveFontDates(tables,original);
  const result = sfnt(tables);
  if (fontkit.create(result).numGlyphs !== glyphs.length)
    throw new Error("字体子集的字形数量校验失败。");
  return result;
}
