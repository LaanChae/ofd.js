import { readNavigation, resolveDeferredDestination } from "./navigation.js";
import { drawPrintableRemarks } from "./remark-print.js";
import { readPageInteractions } from "./interactions.js";
import * as m from "mupdf";
import { Renderer } from "./render.js";
import { MM } from "./geometry.js";
import { RenderProgram, RenderProgramCache } from "./render-program.js";
import { finishRender, scheduleRender, RENDER_SLICE_MS } from "./render-task.js";
import { drawDirectPattern } from "./direct-patterns.js";
import { attr } from "./archive.js";
import {readAttachments, attachmentContent} from "./attachments.js";

export class DirectDocument {
  constructor(doc, store, choices = {}) {
    this.doc = doc;
    this.fontRevision = store.revision;
    this.backend = { forms: { paint() {} }, pattern: drawDirectPattern };
    this.renderer = new Renderer(doc, store, choices, this.backend);
    this.textCache = new Map();
    this.programs = new RenderProgramCache();
  }
  metadata() {
    return {
      pages: this.doc.pages.length,
      documents: this.doc.documents,
      selection: this.doc.selection,
      navigation: this.navigation ??= readNavigation(this.doc, true),
      properties: this.doc.properties,
      fonts: this.renderer.fonts.usages.filter(
        (f) => f.used || this.doc.referencedFonts.has(f.id),
      ),
      warnings: [...this.doc.warnings],
    };
  }
  page(index) { return this.doc.page(index); }
  pageInfo(index) {
    const page = this.page(index);
    this.renderer.fonts.sync();
    return { id: page.id, physicalBox: page.box,
      view: [0, 0, page.box[2] * MM, page.box[3] * MM],
      fonts: this.renderer.fonts.usages.filter(f => f.used || this.doc.referencedFonts.has(f.id)),
      warnings: [...this.doc.warnings] };
  }
  pageInteractions(index) { return readPageInteractions(this.doc, index, true); }
  destination(key) {
    const destinations = (this.navigation ??= readNavigation(this.doc, true)).destinations;
    const value = Object.hasOwn(destinations, key) ? destinations[key] : key;
    return Array.isArray(value) ? value : resolveDeferredDestination(this.doc, value);
  }
  render(index, matrix, width, height, intent = "display") {
    return finishRender(this.renderSteps(index, matrix, width, height, intent));
  }
  renderAsync(index, matrix, width, height, intent = "display", signal) {
    return scheduleRender(this.renderSteps(index, matrix, width, height, intent), signal);
  }
  *renderSteps(index, matrix, width, height, intent) {
    const page = this.page(index);
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width * height > 32 * 1024 * 1024 ||
      !Array.isArray(matrix) ||
      matrix.length !== 6 ||
      matrix.some((v) => !Number.isFinite(v)) ||
      Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]) < 1e-12
    )
      throw new Error("页面绘制尺寸或变换无效。");
    const pixmap = new m.Pixmap(
        m.ColorSpace.DeviceRGB,
        [0, 0, width, height],
        true,
      ),
      device = new m.DrawDevice(matrix, pixmap);
    pixmap.clear(255);
    let program = this.programs.get(index), compiled = false, complete = false;
    try {
      if (!program) {
        const started = performance.now();
        try { program = new RenderProgram().compile(this.renderer, page); }
        finally { this.renderer.releaseImages(); }
        compiled = true;
        // Process a pending zoom/scroll cancellation before drawing a costly page.
        if (performance.now() - started >= RENDER_SLICE_MS) yield;
      }
      yield* program.steps(device, matrix, width, height);
      if (intent === "print") drawPrintableRemarks(device, this.pageInteractions(index), [0,0,page.box[2]*MM,page.box[3]*MM]);
      device.close();
      complete = true;
      return {
        pixels: pixmap.getPixels().slice(),
        width,
        height,
        warnings: [...this.doc.warnings],
        fonts: this.renderer.fonts.usages.filter(
          (f) => f.used || this.doc.referencedFonts.has(f.id),
        ),
      };
    } finally {
      device.destroy();
      pixmap.destroy();
      if (compiled) {
        if (complete) this.programs.set(index, program);
        else program.destroy();
      }
    }
  }
  textContent(index, withSources = false) {
    const page = this.page(index);
    const cacheKey = withSources ? `official:${index}` : index;
    if (this.textCache.has(cacheKey)) return this.textCache.get(cacheKey);
    const box = [0, 0, page.box[2] * MM, page.box[3] * MM],
      runs = [],
      device = new m.Device({}),
      previous = this.renderer.forms,
      previousPattern = this.backend.pattern;
    this.renderer.forms = { paint() {} };
    let capture;
    const startRun = (direction = null) => {
      const list = new m.DisplayList(box);
      runs.push({ list, direction });
      capture = new m.DisplayListDevice(list);
    };
    const closeRun = () => {
      if (!capture) return;
      try { capture.close(); } finally { capture.destroy(); capture = null; }
    };
    this.backend.text = (object, matrix, node) => {
      if (withSources) closeRun();
      if (!object.verticalFlow) {
        if (!capture) startRun();
        if (withSources) runs.at(-1).sourceId = attr(node, "ID");
        capture.ignoreText(object, matrix);
        return;
      }
      closeRun();
      const angle = object.readDirection * Math.PI / 180,
        vx = Math.cos(angle), vy = Math.sin(angle),
        direction = [matrix[0] * vx + matrix[2] * vy, matrix[1] * vx + matrix[3] * vy],
        length = Math.hypot(...direction);
      startRun(direction.map(v => v / length));
      if (withSources) runs.at(-1).sourceId = attr(node, "ID");
      try {
        // Vertical advances describe reading order, not the glyph's painted
        // bounds. Extract upright quads at the authored origins for selection.
        capture.ignoreText(object, matrix);
      } finally { closeRun(); }
    };
    // Decorative patterns do not contribute logical document text.
    this.backend.pattern = () => {};
    let structured;
    try {
      this.renderer.page(device, page);
      closeRun();
      device.close();
      const items = [], styles = {};
      for (const run of runs) {
        const firstItem = items.length;
        structured = run.list.toStructuredText(
          // TextCode already supplies logical spaces. Guessing additional spaces
          // from font advances changes text when PDF widths differ from hmtx.
          "preserve-ligatures,preserve-whitespace,inhibit-spaces",
        );
        let direction = [1, 0],
          last;
        structured.walk({
          beginLine(_box, _mode, dir) {
            direction = dir;
            last = null;
          },
          onChar(c, origin, font, size, quad, _color, bidi) {
            try {
              if (!size || !c) return;
              const [dx, dy] = direction,
                ascent =
                  ((origin[0] - quad[0]) * -dy + (origin[1] - quad[1]) * dx) /
                  size,
                descent =
                  ((origin[0] - quad[4]) * -dy + (origin[1] - quad[5]) * dx) /
                  size,
                fontName = `ofd_${font.getName()}_${ascent.toFixed(4)}_${descent.toFixed(4)}`;
              styles[fontName] = {
                fontFamily: font.isSerif() ? "serif" : "sans-serif",
                ascent,
                descent,
                vertical: false,
              };
              const width = Math.hypot(quad[2] - quad[0], quad[3] - quad[1]);
              // Extra Unicode characters of one glyph (e.g. "fi") arrive with
              // zero-width quads. Keep them in the same selectable PDF.js span.
              if (width === 0 && last?.fontName === fontName) {
                last.str += c;
                return;
              }
              last = {
                str: c,
                dir: bidi % 2 ? "rtl" : "ltr",
                width,
                height: size,
                transform: [
                  dx * size,
                  -dy * size,
                  dy * size,
                  dx * size,
                  origin[0],
                  box[3] - origin[1],
                ],
                fontName,
                hasEOL: false,
              };
              if (withSources) {
                last.sourceId = run.sourceId;
                const xs = [quad[0],quad[2],quad[4],quad[6]], ys = [quad[1],quad[3],quad[5],quad[7]];
                last.sourceRect = [Math.min(...xs), box[3]-Math.max(...ys), Math.max(...xs), box[3]-Math.min(...ys)];
              }
              items.push(last);
            } finally {
              font.destroy();
            }
          },
          endLine() {
            if (last) last.hasEOL = true;
          },
        });
        if (run.direction) {
          const [dx, dy] = run.direction;
          for (let i = firstItem; i + 1 < items.length; i++) {
            const a = items[i], b = items[i + 1],
              x = b.transform[4] - a.transform[4],
              y = a.transform[5] - b.transform[5],
              along = x * dx + y * dy,
              across = Math.abs(x * dy - y * dx),
              size = Math.max(a.height, b.height);
            a.hasEOL = !(along > 0 && along <= size * 2 && across < size / 2);
          }
        }
        structured.destroy();
        structured = null;
      }
      const result = { items, styles, lang: "zh-CN" };
      if (this.textCache.size >= 8)
        this.textCache.delete(this.textCache.keys().next().value);
      this.textCache.set(cacheKey, result);
      return result;
    } finally {
      this.renderer.forms = previous;
      this.backend.text = null;
      this.backend.pattern = previousPattern;
      structured?.destroy();
      device.destroy();
      closeRun();
      for (const run of runs) run.list.destroy();
    }
  }
  attachments() {
    const entries=readAttachments(this.doc).filter(item=>item.path&&item.visible);
    return entries.length ? Object.fromEntries(entries.map(item=>[item.id,item])) : null;
  }
  attachmentContent(id) {
    return attachmentContent(this.doc,id);
  }
  destroy() {
    this.textCache.clear();
    this.programs.destroy();
    this.renderer.destroy();
  }
}
