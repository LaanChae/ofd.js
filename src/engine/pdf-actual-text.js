import { transformPoint } from "./geometry.js";

export class PdfActualTextError extends Error {}

const unsupported = () => {
  throw new PdfActualTextError("无法定位 ActualText 替代文本所对应的字形，不能安全地局部转轮廓。");
};
const key = (font, origin) => `${font}:${origin.map(n => n.toFixed(3)).join(":")}`;
function characters(text) {
  const result = [];
  text.walk({ onChar(c, origin, font, size, quad) {
    try { result.push({ code: c.codePointAt(0), font: font.pointer, origin, size, quad }); }
    finally { font.destroy(); }
  } });
  return result;
}

const sameFootprint = (a, b) => a.font === b.font && a.size === b.size &&
  a.origin.every((n, j) => n === b.origin[j]) && a.quad.every((n, j) => n === b.quad[j]);
const footprint = c => JSON.stringify([c.font, c.size, c.origin, c.quad]);
const fingerprint = c => `${c.code}:${footprint(c)}`;
const continuation = (c, previous) => c.font === previous.font && c.size === previous.size &&
  c.quad[0] === c.quad[2] && c.quad[1] === c.quad[3] &&
  c.quad[4] === c.quad[6] && c.quad[5] === c.quad[7] &&
  [0, 1, 4, 5].every(i => c.quad[i] === previous.quad[i + 2]);

// Preserve exactly aligned replacements; otherwise outline only the original
// glyphs whose text/footprint changed. Normal text is matched by full geometry
// and character identity, not by a page-wide string diff or approximate boxes.
export function actualTextMap(page, bounds) {
  const options = "preserve-ligatures,preserve-whitespace,inhibit-spaces";
  let actual, original;
  try {
    actual = page.toStructuredText(options);
    original = page.toStructuredText(options + ",ignore-actualtext");
    if (actual.asText() === original.asText()) return null;
    const a = characters(actual), b = characters(original), positions = new Map(), changed = new Set();
    const aligned = a.length === b.length && a.every((c, i) => sameFootprint(c, b[i]));
    const exact = new Map(), footprints = new Map(), matched = new Set();
    if (!aligned) {
      b.forEach((c, i) => {
        for (const [map, k] of [[exact, fingerprint(c)], [footprints, footprint(c)]]) {
          if (!map.has(k)) map.set(k, []);
          map.get(k).push(i);
        }
      });
      let anchor = [];
      a.forEach((c, i) => {
        const indices = exact.get(fingerprint(c));
        if (indices?.length) {
          const index = indices.shift();
          matched.add(index); anchor = [index];
        } else {
          const originals = footprints.get(footprint(c));
          if (originals) anchor = originals;
          else if (!i || !anchor.length || !continuation(c, a[i - 1])) unsupported();
          // MuPDF appends extra ActualText characters as zero-width quads at
          // the preceding character's edge. Include that anchor glyph even if
          // its first character itself stayed unchanged (e.g. f -> ffi).
          for (const index of anchor) changed.add(index);
        }
      });
    }
    b.forEach((c, i) => {
      const position = key(c.font, c.origin);
      if (!positions.has(position)) positions.set(position, []);
      positions.get(position).push(i);
      if (aligned) {
        if (c.code !== a[i].code) changed.add(i);
      } else {
        if (!matched.has(i)) changed.add(i);
      }
    });
    if (!changed.size) unsupported();
    const pending = new Set(changed);
    return {
      resolve(font, glyph, ctm) {
        const origin = transformPoint(ctm, glyph.trm[4], glyph.trm[5]);
        origin[0] += bounds[0]; origin[1] += bounds[1];
        const candidates = (positions.get(key(font.pointer, origin)) || []).filter(i =>
          glyph.unicodes.every((code, j) => b[i + j]?.code === code && b[i + j].font === font.pointer));
        if (!candidates.length) return glyph.unicodes;
        for (const i of candidates) for (let j = 0; j < glyph.unicodes.length; j++) pending.delete(i + j);
        if (!aligned) return candidates.some(i => glyph.unicodes.some((_, j) => changed.has(i + j)))
          ? null : glyph.unicodes;
        const codes = a.slice(candidates[0], candidates[0] + glyph.unicodes.length).map(c => c.code);
        if (candidates.some(i => codes.some((code, j) => a[i + j].code !== code))) return null;
        return codes;
      },
      finish() { if (pending.size) unsupported(); },
    };
  } finally { actual?.destroy(); original?.destroy(); }
}
