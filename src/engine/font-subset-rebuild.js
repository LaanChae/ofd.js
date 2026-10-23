import * as m from 'mupdf';
import opentype from 'opentype.js';
import * as fontkit from 'fontkit';
import {sfnt,tablesOf,preserveFontDates} from './font-container.js';
import {nativeGlyphPath} from './pdf-glyph-outline.js';

// Rebuild a static, standalone OpenType subset when the source program cannot
// be subset-encoded. OFD already stores shaping/positions and logical text, so
// only the used glyph geometry, advances and exact assigned GIDs are required.
// This preserves curves; it does not turn text into page outlines or images.
export function rebuildSubsetFont(bytes, font, glyphMap, unicodes) {
  const units=font.unitsPerEm;
  if(!Number.isInteger(units)||units<16||units>16384)throw Error('字体单位无法用于重建子集。');
  if(['COLR','CBDT','sbix','SVG '].some(tag=>font.directory.tables[tag]))
    throw Error('不能将彩色或位图字体静默重建为单色子集。');
  let native;
  const nativeFont=()=>native??=new m.Font('SubsetRepair',bytes);
  const nativePath=gid=>{
    const outline=nativeGlyphPath(nativeFont(),gid),path=new opentype.Path();
    try {
      outline.walk({
        moveTo:(x,y)=>path.moveTo(x*units,y*units),
        lineTo:(x,y)=>path.lineTo(x*units,y*units),
        curveTo:(...values)=>path.curveTo(...values.map(value=>value*units)),
        closePath:()=>path.close(),
      });
      return path;
    } finally {outline.destroy();}
  };
  try {
    const glyphs=[],usedUnicode=new Set();
    for(const [oldId,newId] of glyphMap) {
      let path,advance;
      try {
        const source=font.getGlyph(oldId);path=new opentype.Path();
        for(const {command,args} of source.path.commands) {
          if(!['moveTo','lineTo','quadraticCurveTo','bezierCurveTo','closePath'].includes(command)||!args.every(Number.isFinite))
            throw Error('字体轮廓命令无效。');
          path[command](...args);
        }
        advance=source.advanceWidth;
      } catch {path=nativePath(oldId);advance=nativeFont().advanceGlyph(oldId)*units;}
      if(!Number.isFinite(advance)||advance<0||advance>65535)throw Error(`字形 ${oldId} 的宽度无效。`);
      let unicode=unicodes.get(oldId);
      // cmap has one glyph per Unicode; explicit OFD CGTransform retains any
      // ambiguous aliases, ligatures or alternative glyphs independently.
      if(usedUnicode.has(unicode))unicode=undefined;
      else if(unicode!==undefined)usedUnicode.add(unicode);
      glyphs.push(new opentype.Glyph({name:newId===0?'.notdef':`gid${newId}`,unicode,advanceWidth:Math.round(advance),path}));
    }
    const metric=(read,fallback)=>{try{const value=read();return Number.isFinite(value)&&Math.abs(value)<=32767?Math.round(value):fallback;}catch{return fallback;}};
    const rebuilt=new opentype.Font({
      familyName:font.familyName||'SubsetRepair',styleName:font.subfamilyName||'Regular',unitsPerEm:units,
      ascender:metric(()=>font.ascent,units),descender:metric(()=>font.descent,-Math.round(units/4)),glyphs,
    });
    const tables=tablesOf(new Uint8Array(rebuilt.toArrayBuffer())),original=tablesOf(bytes);
    preserveFontDates(tables,original);
    // Retain identity/copyright/license metadata, but rebuild glyph-indexed
    // layout tables and geometry-dependent metrics for this compact program.
    if(original.has('name'))tables.set('name',original.get('name'));
    const sourceOS2=original.get('OS/2');
    if(sourceOS2?.length>=10)tables.get('OS/2').set(sourceOS2.subarray(8,10),8);
    const result=sfnt(tables),parsed=fontkit.create(result);
    if(parsed.numGlyphs!==glyphMap.size)throw Error('重建子集的字形数量不一致。');
    for(const [,gid] of glyphMap) {
      const actual=parsed.getGlyph(gid),expected=glyphs[gid];
      if(actual.advanceWidth!==expected.advanceWidth)throw Error('重建子集的字形宽度不一致。');
      const original=expected.path.getBoundingBox(),bounds=actual.bbox;
      for(const [a,b] of [[original.x1,bounds.minX],[original.y1,bounds.minY],[original.x2,bounds.maxX],[original.y2,bounds.maxY]])
        if((expected.path.commands.length&&!Number.isFinite(b))||(Number.isFinite(b)&&Math.abs(a-b)>2))throw Error('重建子集的字形边界不一致。');
    }
    const check=new m.Font('SubsetRepair',result);check.destroy();
    return result;
  } finally {native?.destroy();}
}
