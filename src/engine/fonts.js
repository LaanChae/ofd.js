import * as mupdf from "mupdf";
import * as fontkit from "fontkit";
import {sha256} from "@noble/hashes/sha256";
import { attr, text, children, numbers, bool } from "./archive.js";
import { delta } from "./geometry.js";
import { bundledFonts } from "./font-catalog.js";
import { documentFont } from "./document-font.js";

const rawName = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[\s_-]/g, "");
// Common localized names refer to the same family, not a visually similar substitute.
const aliases = new Map([
  ["宋体", "simsun"],
  ["新宋体", "nsimsun"],
  ["黑体", "simhei"],
  ["楷体", "kaiti"],
  ["楷体gb2312", "kaitigb2312"],
  ["仿宋", "fangsong"],
  ["等线", "dengxian"],
  ["dengxianregular", "dengxian"],
  ["微软雅黑", "microsoftyahei"],
]);
export const normalizeFontName = (value) =>
  aliases.get(rawName(value)) || rawName(value);
const normalize = normalizeFontName;
export function matchLocalFonts(usages, available) {
  const wanted = usages.filter(
    (f) =>
      !f.embedded &&
      f.selected === "auto" &&
      (f.missing || f.source === "bundled"),
  );
  const result = new Set();
  for (const font of wanted) {
    const exact = available.findIndex((f) =>
      [f.fullName, f.postscriptName].some(
        (n) => n && normalize(n) === normalize(font.name),
      ),
    );
    const family = available.findIndex(
      (f) =>
        [font.name, font.family].some(
          (n) => n && normalize(n) === normalize(f.family),
        ) && /^(regular|normal|常规|标准)$/i.test(f.style || "Regular"),
    );
    if (exact >= 0 || family >= 0) result.add(exact >= 0 ? exact : family);
  }
  return [...result];
}
export class FontStore {
  constructor() {
    this.faces = new Map();
    for (const [id, label, font] of [
      ["sans", "内置无衬线", "Helvetica"],
      ["serif", "内置衬线", "Times-Roman"],
      ["mono", "内置等宽", "Courier"],
      ["cjk", "内置中文", "zh-Hans"],
    ])
      this.faces.set(id, {
        id,
        label,
        font: new mupdf.Font(font),
        names: [normalize(label)],
        chinese: id === "cjk",
        imported: false,
        source: "builtin",
      });
    this.serial = 0;
    this.importCount = 0;
    this.importBytes = 0;
    this.imports = [];
    this.revision = 0;
  }
  import(bytes, bundledId = null) {
    const bundled = bundledFonts.find((font) => font.id === bundledId);
    if (bundledId && !bundled) throw new Error("未知项目字体。");
    const imported = !bundled;
    const existing = this.imports.find(
      (entry) =>
        (!bundledId || entry.ids.includes(bundledId)) &&
        entry.bytes.length === bytes.length &&
        entry.bytes.every((v, i) => v === bytes[i]),
    );
    if (existing) {
      // A user's local copy takes priority, even if its bytes match our bundle.
      if (imported) {
        this.revision++;
        for (const id of existing.ids) {
          this.faces.get(id).imported = true;
          this.faces.get(id).source = "imported";
        }
      }
      return existing.ids;
    }
    if (
      !bytes.length ||
      bytes.length > 100 * 1048576 ||
      (imported &&
        (this.importCount >= 10 ||
          this.importBytes + bytes.length > 200 * 1048576))
    )
      throw new Error(
        "每份文档最多导入 10 个字体文件，合计 200 MB，单文件 100 MB。",
      );
    const parsed = fontkit.create(bytes);
    const fonts = parsed.fonts || [parsed],
      added = [];
    if (
      bundled &&
      (fonts.length !== 1 ||
        normalize(fonts[0].familyName) !== normalize(bundled.name))
    )
      throw new Error(`项目字体与登记名称不符：${bundled.label}`);
    for (let index = 0; index < fonts.length; index++) {
      const f = fonts[index];
      const id = bundledId || `font-${++this.serial}`,
        label =
          bundled?.label ||
          f.fullName ||
          f.postscriptName ||
          `字体 ${index + 1}`;
      const font = documentFont(f.postscriptName || label, bytes, index);
      this.faces.set(id, {
        id,
        label,
        font,
        kit: f,
        bytes,
        index,
        exactNames: [normalize(f.fullName), normalize(f.postscriptName)].filter(
          Boolean,
        ),
        names: [
          normalize(f.familyName),
          normalize(f.fullName),
          normalize(f.postscriptName),
        ].filter(Boolean),
        chinese: font.encodeCharacter("中") !== 0,
        imported,
        source: bundled ? "bundled" : "imported",
      });
      added.push(id);
    }
    if (!added.length) throw new Error("字体没有可用字形。");
    this.imports.push({ bytes, ids: added });
    this.revision++;
    if (imported) {
      this.importCount++;
      this.importBytes += bytes.length;
    }
    return added;
  }
  match(originalName, family) {
    const faces = [...this.faces.values()];
    const find = (faces) =>
      faces.find(
        (f) => originalName && f.exactNames?.includes(normalize(originalName)),
      ) ||
      faces.find(
        (f) =>
          (originalName && f.names.includes(normalize(originalName))) ||
          (family && f.names.includes(normalize(family))),
      );
    return (
      find(faces.filter((f) => f.imported)) ||
      find(faces.filter((f) => !f.imported))
    );
  }
  options() {
    const options = [...this.faces.values()].map(
      ({ id, label, chinese, imported, source }) => ({
        id,
        label,
        chinese,
        imported,
        source,
      }),
    );
    for (const font of bundledFonts)
      if (!this.faces.has(font.id))
        options.push({
          id: font.id,
          label: font.label,
          chinese: true,
          imported: false,
          source: "bundled",
        });
    return options;
  }
  destroy() {
    for (const f of this.faces.values()) f.font.destroy();
    this.faces.clear();
    this.imports = [];
  }
}

export class DocumentFonts {
  constructor(doc, store, choices = {}) {
    this.doc = doc;
    this.store = store;
    this.faces = new Map();
    this.usages = [];
    this.glyphMappings = new Map();
    this.choices = choices;
    this.sync();
  }
  sync() {
    const { doc, store, choices } = this;
    for (const [id, res] of doc.resources.fonts) {
      if (this.faces.has(id)) continue;
      const originalName = attr(res.node, "FontName"),
        family = attr(res.node, "FamilyName");
      const embedded = Boolean(res.path && doc.archive.has(res.path));
      const selected = choices[id] || "auto";
      let face,
        own = false;
      if (selected !== "auto") {
        face = store.faces.get(selected);
        if (!face) throw new Error(`所选字体不存在：${originalName}`);
      } else if (embedded) {
        face = {
          font: null,
          label: "文档内嵌字体",
        };
        own = true;
      } else {
        face = store.match(originalName, family);
        if (!face)
          face = store.faces.get(
            /[宋楷仿]|song|kai|simsun/i.test(originalName)
              ? "cjk"
              : /[黑等雅]|simhei/i.test(originalName)
                ? "cjk"
                : /courier|mono/i.test(originalName)
                  ? "mono"
                  : /times|serif/i.test(originalName)
                    ? "serif"
                    : "cjk",
          );
      }
      const missing =
        !embedded &&
        !store.faces.has(selected) &&
        !store.match(originalName, family);
      const usage = {
        used: false,
        id,
        name: originalName,
        family,
        embedded,
        missing,
        selected,
        replacement: face.label,
        source: embedded && selected === "auto" ? "embedded" : face.source,
        missingCharacters: 0,
        glyphIndexed: false,
        overridden: selected !== "auto",
      };
      this.usages.push(usage);
      const entry = {
        ...face,
        own,
        usage,
        keepGlyphs: embedded && selected === "auto",
        missing: new Set(),
      };
      if (own) Object.defineProperty(entry, "font", {
        get: () => {
          if(entry.loadedFont)return entry.loadedFont;
          const bytes=doc.archive.read(res.path);
          // Different embedded subsets can share even the same six-letter
          // subset prefix. PDF ToUnicode maps must follow the actual program,
          // not that display name; keep the user's label in usage.name.
          const identity=Array.from(sha256(bytes).subarray(0,24),b=>b.toString(16).padStart(2,'0')).join('');
          return entry.loadedFont=documentFont(`OFD-${identity}`,bytes);
        },
      });
      this.faces.set(id, entry);
    }
  }
  destroy() {
    for (const f of this.faces.values()) if (f.own) f.loadedFont?.destroy();
  }
  build(node, recordMappings = true) {
    const id = attr(node, "Font"),
      face = this.faces.get(id);
    if (!face) throw new Error(`找不到字体资源 ${id}`);
    face.usage.used = true;
    const size = Number(attr(node, "Size"));
    if (!Number.isFinite(size) || size <= 0) throw new Error("无效字号。");
    const hscale = Number(attr(node, "HScale", "1")),
      angle = (Number(attr(node, "CharDirection", "0")) * Math.PI) / 180;
    const readDirection = Number(attr(node, "ReadDirection", "0"));
    const verticalFlow =
      (readDirection - Number(attr(node, "CharDirection", "0")) + 360) % 360 === 90;
    if (![0, 90, 180, 270].includes(readDirection) || ![0, 90, 180, 270].includes(Number(attr(node, "CharDirection", "0"))))
      throw Error("文字方向必须是 0、90、180 或 270。");
    if (!Number.isFinite(hscale) || hscale <= 0) throw Error("无效的文字横向缩放。");
    const positions = [];
    let x = 0,
      y = 0;
    // Adapted from ofd.js calTextPoint: retain TextCode X/Y, expand g n delta, use code points.
    for (const code of children(node, "TextCode")) {
      if (code.hasAttribute("X")) x = Number(attr(code, "X"));
      if (code.hasAttribute("Y")) y = Number(attr(code, "Y"));
      const chars = Array.from(
        code.textContent.replace(/\\([0-9a-fA-F]{4})/g, (_, hex) =>
          String.fromCharCode(parseInt(hex, 16)),
        ),
      );
      const dx = delta(attr(code, "DeltaX")),
        dy = delta(attr(code, "DeltaY"));
      let px = x,
        py = y;
      for (let i = 0; i < chars.length; i++) {
        if (i) {
          px += dx[i - 1] ?? dx.at(-1) ?? 0;
          py += dy[i - 1] ?? dy.at(-1) ?? 0;
        }
        positions.push({ char: chars[i], x: px, y: py });
      }
    }
    const transforms = children(node, "CGTransform"),
      mapped = new Map(),
      skip = new Set();
    face.usage.glyphIndexed ||= transforms.length > 0;
    if (face.keepGlyphs)
      for (const t of transforms) {
        const start = Number(attr(t, "CodePosition")),
          count = Number(attr(t, "CodeCount", "1")),
          gids = numbers(text(t, "Glyphs"));
        if (
          !Number.isSafeInteger(start) ||
          start < 0 ||
          !Number.isSafeInteger(count) ||
          count < 1 ||
          start + count > positions.length ||
          gids.length !== Number(attr(t, "GlyphCount", "1"))
        )
          throw new Error("无效 CGTransform 字形映射。");
        mapped.set(start, { count, gids });
        for (let i = 1; i < count; i++) skip.add(start + i);
      }
    const result = new mupdf.Text(),
      c = Math.cos(angle),
      s = Math.sin(angle);
    const italic = bool(node, "Italic", false) && !face.font.isItalic() ? Math.tan(12 * Math.PI / 180) : 0;
    const matrix = (px, py) => [
      size * hscale * c,
      size * hscale * s,
      size * (s + hscale * c * italic),
      size * (-c + hscale * s * italic),
      px,
      py,
    ];
    for (let i = 0; i < positions.length; i++) {
      if (skip.has(i)) continue;
      const pos = positions[i],
        mapping = mapped.get(i);
      if (mapping) {
        let px = pos.x,
          py = pos.y;
        const units = positions
          .slice(i, i + mapping.count)
          .map((p) => p.char.codePointAt(0));
        for (let j = 0; j < Math.max(mapping.gids.length, units.length); j++) {
          const gid = mapping.gids[j] ?? -1,
            uni = units[j] ?? -1;
          const location = positions[i + Math.min(j, mapping.count - 1)];
          if (j < mapping.count) {
            px = location.x;
            py = location.y;
          }
          result.showGlyph(face.font, matrix(px, py), gid, uni);
          if (recordMappings && gid >= 0 && uni >= 0) {
            const key = face.font.getName();
            if (!this.glyphMappings.has(key))
              this.glyphMappings.set(key, new Map());
            const logical =
              mapping.gids.length === 1
                ? units.map((c) => String.fromCodePoint(c)).join("")
                : String.fromCodePoint(uni);
            const prior = this.glyphMappings.get(key).get(gid);
            if (prior && prior !== logical)
              this.doc.warnings.add(
                "同一字形对应多个逻辑字符，导出 PDF 后的复制与搜索可能存在歧义。",
              );
            this.glyphMappings.get(key).set(gid, logical);
          }
          if (gid >= 0 && j >= mapping.count - 1) {
            const advance = face.font.advanceGlyph(gid) * size * hscale;
            const [vx, vy] = { 0: [1, 0], 90: [0, 1], 180: [-1, 0], 270: [0, -1] }[readDirection];
            px += advance * vx; py += advance * vy;
          }
        }
      } else {
        let font = face.font,
          gid = font.encodeCharacter(pos.char.codePointAt(0));
        if (!gid && !/^\s$/.test(pos.char)) {
          const fallback = this.store.faces.get("cjk").font;
          const replacement = fallback.encodeCharacter(pos.char.codePointAt(0));
          if (replacement) {
            font = fallback;
            gid = replacement;
          } else face.missing.add(pos.char);
        }
        result.showGlyph(
          font,
          matrix(pos.x, pos.y),
          gid,
          pos.char.codePointAt(0),
        );
      }
    }
    const weight = Number(attr(node, "Weight", "400"));
    // Table 45 lists 100..900; Annex A CT_Text additionally enumerates 0/1000.
    if (!Number.isInteger(weight) || weight < 0 || weight > 1000 || weight % 100) throw Error("无效的文字字重。");
    // Weight is synthesized only when explicitly requested. A bold embedded
    // face without Weight retains its authored outline.
    result.weightDelta = node.hasAttribute("Weight") ? size * (weight - (face.font.isBold() ? 700 : 400)) / 12000 : 0;
    result.readDirection = readDirection;
    result.verticalFlow = verticalFlow;
    face.usage.missingCharacters = face.missing.size;
    return result;
  }
}
