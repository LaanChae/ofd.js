import { gzipSync, gunzipSync, zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import * as fontkit from 'fontkit';
import { sha256 } from '@noble/hashes/sha256';
import { sfnt, tablesOf } from './font-container.js';

const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

// Keep original GIDs, outlines, composite references, metrics and hint programs.
// Only glyf/loca change as more glyphs arrive. No shaping or GID renumbering.
export function createFontChunks(bytes, chunkSize = 32) {
  const tables = tablesOf(bytes), head = tables.get('head'), glyf = tables.get('glyf');
  if (!glyf || !head || tables.has('fvar')) throw Error('分包需要静态 TrueType 字体。');
  const count = view(tables.get('maxp')).getUint16(4);
  const loca = view(tables.get('loca')), long = view(head).getInt16(50) === 1;
  const offsets = new Uint8Array((count + 1) * 4), positions = view(offsets);
  for (let gid = 0; gid <= count; gid++) {
    const offset = long ? loca.getUint32(gid * 4) : loca.getUint16(gid * 2) * 2;
    if (offset > glyf.length || (gid && offset < positions.getUint32((gid - 1) * 4)))
      throw Error('字体 loca 偏移无效。');
    positions.setUint32(gid * 4, offset);
  }
  const revision = Array.from(sha256(bytes).subarray(0, 16), b => b.toString(16).padStart(2, '0')).join('');
  const chunks = [];
  for (let gid = 0; gid < count; gid += chunkSize) {
    const end = Math.min(count, gid + chunkSize);
    chunks.push(gzipSync(glyf.subarray(positions.getUint32(gid * 4), positions.getUint32(end * 4)), { level: 9, mtime: 0 }));
  }
  // MuPDF uses scalable outlines for document text, not embedded bitmap strikes.
  // A modified font also cannot retain the source's digital signature.
  for (const tag of ['DSIG', 'EBDT', 'EBLC', 'EBSC']) tables.delete(tag);
  view(head).setInt16(50, 1);
  tables.set('glyf', new Uint8Array());
  tables.set('loca', new Uint8Array((count + 1) * 4));
  return {
    revision, chunks,
    index: zipSync({
      'base.ttf': sfnt(tables),
      'offsets.bin': offsets,
      'info.json': strToU8(JSON.stringify({ revision, count, chunkSize })),
    }, { level: 9, mtime: new Date('2000-01-01T00:00:00Z') }),
  };
}

// Component records: https://learn.microsoft.com/typography/opentype/spec/glyf
export function glyphComponents(bytes) {
  if (!bytes.length) return [];
  const data = view(bytes);
  if (bytes.length < 10) throw Error('字形分包中的轮廓不完整。');
  if (data.getInt16(0) >= 0) return [];
  const result = [];
  let offset = 10, flags;
  do {
    flags = data.getUint16(offset);
    result.push(data.getUint16(offset + 2));
    offset += 4 + (flags & 1 ? 4 : 2) + (flags & 8 ? 2 : flags & 64 ? 4 : flags & 128 ? 8 : 0);
    if (offset > bytes.length) throw Error('复合字形分包不完整。');
  } while (flags & 32);
  return result;
}

export class ChunkedFont {
  constructor(index, fetchChunk) {
    const files = unzipSync(index), info = JSON.parse(strFromU8(files['info.json']));
    this.tables = tablesOf(files['base.ttf']);
    this.kit = fontkit.create(files['base.ttf']);
    this.offsets = view(files['offsets.bin']);
    if (info.count !== this.kit.numGlyphs || !Number.isInteger(info.chunkSize) || info.chunkSize < 1 || info.chunkSize > 256 || !/^[0-9a-f]{32}$/.test(info.revision) || this.offsets.byteLength !== (info.count + 1) * 4)
      throw Error('字体分包索引无效。');
    Object.assign(this, info);
    this.fetchChunk = fetchChunk;
    this.chunks = new Map();
    this.loadedGlyphs = new Set();
    this.characters = new Set();
    this.installed = false;
  }
  glyphBytes(gid) {
    const first = Math.floor(gid / this.chunkSize) * this.chunkSize;
    const chunk = this.chunks.get(first / this.chunkSize);
    const start = this.offsets.getUint32(first * 4);
    return chunk.subarray(this.offsets.getUint32(gid * 4) - start, this.offsets.getUint32((gid + 1) * 4) - start);
  }
  async ensure(characters) {
    const fresh = [...characters].filter(code => !this.characters.has(code));
    let pending = new Set([0, ...fresh.map(code => this.kit.glyphForCodePoint(code).id)]);
    const required = new Set();
    while (pending.size) {
      const next = [...pending].filter(gid => !this.loadedGlyphs.has(gid) && !required.has(gid));
      if (!next.length) break;
      if (next.some(gid => !Number.isInteger(gid) || gid < 0 || gid >= this.count)) throw Error('复合字形索引超出范围。');
      const missing = [...new Set(next.map(gid => Math.floor(gid / this.chunkSize)))].filter(id => !this.chunks.has(id));
      // Bound parallel requests even when exporting an entire document.
      for (let i = 0; i < missing.length; i += 6) await Promise.all(missing.slice(i, i + 6).map(async id => {
        const chunk = gunzipSync(await this.fetchChunk(`${this.revision}/${id}.bin`));
        const first = id * this.chunkSize, end = Math.min(this.count, first + this.chunkSize);
        if (chunk.length !== this.offsets.getUint32(end * 4) - this.offsets.getUint32(first * 4))
          throw Error('字体分包长度不一致。');
        this.chunks.set(id, chunk);
      }));
      pending = new Set();
      for (const gid of next) {
        required.add(gid);
        for (const dependency of glyphComponents(this.glyphBytes(gid))) pending.add(dependency);
      }
    }
    if (!required.size && this.installed) {
      for (const code of fresh) this.characters.add(code);
      return null;
    }
    // Only selected glyphs and their recursive components enter the working
    // font; neighbouring glyphs in the downloaded chunk remain cached bytes.
    const glyphs = new Set([...this.loadedGlyphs, ...required]);
    const loca = new Uint8Array((this.count + 1) * 4), offsets = view(loca);
    let size = 0;
    for (let gid = 0; gid < this.count; gid++) {
      offsets.setUint32(gid * 4, size);
      if (glyphs.has(gid)) size += (this.glyphBytes(gid).length + 3) & ~3;
    }
    offsets.setUint32(this.count * 4, size);
    const glyf = new Uint8Array(size);
    for (const gid of glyphs) glyf.set(this.glyphBytes(gid), offsets.getUint32(gid * 4));
    const tables = new Map(this.tables);
    tables.set('glyf', glyf); tables.set('loca', loca);
    const bytes = sfnt(tables);
    this.loadedGlyphs = glyphs;
    for (const code of fresh) this.characters.add(code);
    this.installed = true;
    return bytes;
  }
}
