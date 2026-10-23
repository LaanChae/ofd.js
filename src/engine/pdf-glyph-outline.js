import * as m from "mupdf";
import { xmlParse, children, name, attr } from "./archive.js";
import { IDENTITY, multiply, svgTransform, ofdPath } from "./geometry.js";
import { pathData } from "./svg-path.js";

// MuPDF can outline Type 1 and simple Type 3 programs that cannot be embedded
// as standalone OpenType. Keep its native font interpreter; do not substitute
// fonts or rasterize the page. This accepts a single monochrome filled path.
export function nativeGlyphPath(font, gid) {
  const buffer = new m.Buffer(), writer = new m.DocumentWriter(buffer, "svg", "text=path"),
    text = new m.Text();
  let device;
  try {
    device = writer.beginPage([0, 0, 1, 1]);
    text.showGlyph(font, IDENTITY, gid, 0xfffd);
    device.fillText(text, IDENTITY, m.ColorSpace.DeviceRGB, [0, 0, 0], 1);
    writer.endPage(); writer.close();
    const root = xmlParse(buffer.asString()), definitions = new Map(), paths = [];
    const index = node => {
      if (attr(node, "id")) definitions.set(attr(node, "id"), node);
      for (const part of children(node)) index(part);
    };
    index(root);
    const visit = (node, parent = IDENTITY, depth = 0) => {
      if (depth > 32) throw new Error("字体轮廓嵌套过深");
      const kind = name(node);
      if (kind === "defs") return;
      for (const property of ["clip-path", "mask", "filter", "style", "stroke", "opacity", "fill-opacity", "fill-rule"])
        if (node.hasAttribute(property)) throw new Error("字体外观包含无法直接合并为轮廓的绘制效果");
      if (node.hasAttribute("fill") && !["black", "#000000"].includes(attr(node, "fill")))
        throw new Error("字体外观包含多色绘制，无法转换为单色轮廓");
      const transform = multiply(parent, svgTransform(attr(node, "transform")));
      if (kind === "use") {
        const referenced = definitions.get((attr(node, "xlink:href") || attr(node, "href")).replace(/^#/, ""));
        if (!referenced) throw new Error("字体轮廓引用无效");
        visit(referenced, transform, depth + 1);
      } else if (["svg", "g"].includes(kind)) {
        for (const part of children(node)) visit(part, transform, depth + 1);
      } else if (kind === "path") paths.push({ data: pathData(attr(node, "d")), transform });
      else throw new Error(`字体外观包含 ${kind}，无法转换为路径轮廓`);
    };
    visit(root);
    if (paths.length > 1) throw new Error("字体外观包含多个独立绘制对象，无法转换为单一路径轮廓");
    const path = ofdPath(paths[0]?.data || "");
    if (paths.length) path.transform(paths[0].transform);
    return path;
  } finally { device?.destroy(); text.destroy(); writer.destroy(); buffer.destroy(); }
}
