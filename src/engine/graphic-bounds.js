import * as m from "mupdf";
import { attr, bool, child, children, name, number, numbers, text } from "./archive.js";
import { IDENTITY, multiply, ofdPath, translate } from "./geometry.js";

const empty = () => [Infinity, Infinity, -Infinity, -Infinity];
const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
export const intersectBounds = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
export const hasBounds = b => b[2] > b[0] && b[3] > b[1];
const transformed = (b, matrix) => hasBounds(b) ? m.Rect.transform(b, matrix) : empty();
const boxRect = ([x, y, w, h]) => [x, y, x + w, y + h];

// Conservative painted bounds, in the caller's coordinate system. An OFD
// Boundary is often the entire page even for a tiny transparent plot marker.
// Never allocate a page-sized transparency buffer just because of that box.
export class GraphicBounds {
  constructor(renderer) {
    this.renderer = renderer;
    this.composites = new WeakMap();
  }
  shape(node, matrix, style) {
    const isText = ["Text", "TextObject"].includes(name(node)),
      object = isText ? this.renderer.fonts.build(node,false) : ofdPath(text(node, "AbbreviatedData"));
    let stroke;
    try {
      const fill = bool(node, "Fill", isText), stroked = bool(node, "Stroke", !isText);
      let bounds = fill ? object.getBounds(null, matrix) : empty();
      if (stroked) {
        stroke = this.renderer.stroke(style);
        bounds = union(bounds, object.getBounds(stroke, matrix));
      }
      if (fill && object.weightDelta) {
        const weight = this.renderer.stroke({ LineWidth: Math.abs(object.weightDelta) * 2, Join: "Round" });
        try { bounds = union(bounds, object.getBounds(weight, matrix)); }
        finally { weight.destroy(); }
      }
      return bounds;
    } finally { stroke?.destroy(); object.destroy(); }
  }
  clips(node, matrix, style, bounds) {
    for (const clip of children(child(node, "Clips"), "Clip")) {
      let clipBounds = empty();
      for (const area of children(clip, "Area")) {
        const am = multiply(matrix, numbers(attr(area, "CTM", "1 0 0 1 0 0"), 6)),
          inherited = this.renderer.doc.drawing(area, style);
        for (const item of children(area)) {
          if (!["Path", "Text"].includes(name(item))) continue;
          const box = numbers(attr(item, "Boundary", "0 0 0 0"), 4),
            im = multiply(am, multiply(translate(box[0], box[1]), numbers(attr(item, "CTM", "1 0 0 1 0 0"), 6)));
          clipBounds = union(clipBounds, this.shape(item, im, this.renderer.doc.drawing(item, inherited)));
        }
      }
      bounds = intersectBounds(bounds, clipBounds);
    }
    return bounds;
  }
  composite(node, style, depth = 0) {
    if (depth > 128) throw new Error("图元嵌套过深或存在循环引用。");
    // Only line style affects bounds; colors do not. This also distinguishes
    // uses of the same resource with inherited DrawParams of different widths.
    const key = JSON.stringify([style.LineWidth, style.Cap, style.Join, style.MiterLimit, style.DashPattern, style.DashOffset]);
    let cache = this.composites.get(node);
    if (!cache) this.composites.set(node, cache = new Map());
    if (!cache.has(key)) {
      const bounds = this.node(child(node, "Content"), IDENTITY, style, depth + 1);
      cache.set(key, intersectBounds(bounds, [0, 0, number(node, "Width", 0), number(node, "Height", 0)]));
    }
    return cache.get(key);
  }
  node(node, parent = IDENTITY, inherited = {}, depth = 0) {
    if (!node) return empty();
    if (depth > 128) throw new Error("图元嵌套过深或存在循环引用。");
    const kind = name(node), style = this.renderer.doc.drawing(node, inherited);
    if (["Content", "PageBlock", "Layer", "Appearance", "CellContent"].includes(kind)) {
      let bounds = empty();
      for (const item of children(node)) bounds = union(bounds, this.node(item, parent, style, depth + 1));
      return bounds;
    }
    if (!["PathObject", "TextObject", "ImageObject", "CompositeObject"].includes(kind) || !bool(node, "Visible", true)) return empty();
    const box = numbers(attr(node, "Boundary"), 4),
      local = multiply(parent, translate(box[0], box[1])),
      matrix = multiply(local, numbers(attr(node, "CTM", "1 0 0 1 0 0"), 6)),
      boundary = transformed(boxRect(box), parent);
    let bounds;
    if (kind === "CompositeObject") {
      const resource = this.renderer.doc.resources.composites.get(attr(node, "ResourceID"));
      if (!resource) throw new Error("复合图元引用了不存在的资源。");
      bounds = transformed(this.composite(resource.node, style, depth), matrix);
    } else if (kind === "ImageObject") {
      // Include the optional border and its joins conservatively.
      bounds = child(node, "Border") ? boundary : transformed([0, 0, 1, 1], matrix);
    } else bounds = this.shape(node, matrix, style);
    return this.clips(node, local, style, intersectBounds(bounds, boundary));
  }
}
