import * as m from "mupdf";
import {pathData} from "./svg-path.js";
import {fmt,matrixText,esc} from "./ofd-write-utils.js";
import {xmlParse,children,name,attr,numbers} from "./archive.js";
import {MM,IDENTITY,multiply,scale,translate,svgTransform} from "./geometry.js";
function color(value = "black") {
  if (value === "black") return [0, 0, 0];
  if (value === "white") return [255, 255, 255];
  if (/^#[0-9a-f]{6}$/i.test(value))
    return [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
  if (/^#[0-9a-f]{3}$/i.test(value))
    return [...value.slice(1)].map((v) => parseInt(v + v, 16));
  throw new Error(`PDF 使用尚未映射的颜色 ${value}。请使用页面图像模式转换。`);
}
function imageBytes(node) {
  const href = attr(node, "xlink:href") || attr(node, "href");
  const match = /^data:image\/(?:png|jpeg);base64,([\s\S]+)$/.exec(href);
  if (!match) throw new Error("PDF 图片数据格式无法识别。");
  return Uint8Array.from(atob(match[1].replace(/\s/g, "")), (c) =>
    c.charCodeAt(0),
  );
}

export function vectorPage(svg, pkg, w, h) {
  const root = xmlParse(svg),
    defs = new Map(),
    objects = [];
  const boundary = `0 0 ${fmt(w)} ${fmt(h)}`,
    imageCache = new Map();
  const index = (node) => {
    if (attr(node, "id")) defs.set(attr(node, "id"), node);
    for (const c of children(node)) index(c);
  };
  index(root);
  const ref = (value) =>
    defs.get(value.replace(/^url\(#(.+)\)$/, "$1").replace(/^#/, ""));
  const clipsXml = (clips, matrix) =>
    clips.length
      ? `<ofd:Clips>${clips.map((parts) => `<ofd:Clip>${parts.map((p) => `<ofd:Area CTM="${matrixText(p.matrix)}"><ofd:Path Boundary="${boundary}" Fill="true" Stroke="false" Rule="${p.rule}"><ofd:AbbreviatedData>${p.path}</ofd:AbbreviatedData></ofd:Path></ofd:Area>`).join("")}</ofd:Clip>`).join("")}</ofd:Clips>`
      : "";
  const pathOf = (n) =>
    name(n) === "rect"
      ? `M ${attr(n, "x", "0")} ${attr(n, "y", "0")} h ${attr(n, "width")} v ${attr(n, "height")} h ${-Number(attr(n, "width"))} Z`
      : attr(n, "d");
  function singleImage(node, matrix = IDENTITY) {
    if (name(node) === "image")
      return {
        node,
        matrix: multiply(matrix, svgTransform(attr(node, "transform"))),
      };
    const parts = children(node);
    if (parts.length !== 1) return null;
    return singleImage(
      parts[0],
      multiply(matrix, svgTransform(attr(node, "transform"))),
    );
  }
  function visit(
    node,
    parent = scale(1 / MM),
    style = {},
    clips = [],
    depth = 0,
  ) {
    if (depth > 128) throw new Error("PDF 图形嵌套过深。");
    const kind = name(node);
    if (["defs", "clipPath", "mask"].includes(kind)) return;
    let matrix = multiply(parent, svgTransform(attr(node, "transform"))),
      values = { ...style };
    for (const key of [
      "fill",
      "stroke",
      "stroke-width",
      "stroke-linecap",
      "stroke-linejoin",
      "stroke-miterlimit",
      "stroke-dasharray",
      "stroke-dashoffset",
      "fill-rule",
      "fill-opacity",
      "stroke-opacity",
    ])
      if (node.hasAttribute(key)) values[key] = attr(node, key);
    if (attr(node, "style") || attr(node, "filter"))
      throw new Error("PDF 包含复杂混合或滤镜，请使用页面图像模式转换。");
    if (attr(node, "clip-path")) {
      const def = ref(attr(node, "clip-path"));
      if (!def) throw new Error("PDF 裁剪引用无效。");
      const parts = children(def).map((p) => {
        if (!["path", "rect"].includes(name(p)))
          throw new Error("PDF 裁剪类型暂不支持。");
        return {
          matrix: multiply(matrix, svgTransform(attr(p, "transform"))),
          path: pathData(pathOf(p)),
          rule: attr(p, "clip-rule") === "evenodd" ? "Even-Odd" : "NonZero",
        };
      });
      clips = [...clips, parts];
    }
    const opacity =
      Number(attr(node, "opacity", "1")) * (style.useOpacity ?? 1);
    delete values.useOpacity;
    if (opacity === 0) return;
    if (["svg", "g"].includes(kind)) {
      if (attr(node, "mask")) {
        const source = singleImage(node),
          mask = singleImage(ref(attr(node, "mask")));
        if (
          !source ||
          !mask ||
          source.matrix.some((n, i) => Math.abs(n - mask.matrix[i]) > 1e-6)
        )
          throw new Error("PDF 包含复杂软蒙版，请使用页面图像模式转换。");
        const id=pkg.image(imageBytes(source.node)),maskId=pkg.image(imageBytes(mask.node));
        const im=multiply(parent,multiply(source.matrix,scale(Number(attr(source.node,"width")),Number(attr(source.node,"height")))));
        objects.push(`<ofd:ImageObject ID="${pkg.next()}" ResourceID="${id}" ImageMask="${maskId}" Boundary="${boundary}" CTM="${matrixText(im)}" Alpha="${Math.round(opacity*255)}">${clipsXml(clips,im)}</ofd:ImageObject>`);
        return;
      }
      if (opacity !== 1)
        throw new Error("PDF 包含透明图形组，请使用页面图像模式转换。");
      for (const c of children(node))
        visit(c, matrix, values, clips, depth + 1);
      return;
    }
    if (kind === "use") {
      values.useOpacity = opacity;
      const def = ref(attr(node, "xlink:href") || attr(node, "href"));
      if (!def) throw new Error("PDF 图元引用无效。");
      visit(
        def,
        multiply(
          matrix,
          translate(Number(attr(node, "x", "0")), Number(attr(node, "y", "0"))),
        ),
        values,
        clips,
        depth + 1,
      );
      return;
    }
    let image;
    if (attr(node, "mask")) {
      const mask = ref(attr(node, "mask")),
        parts = children(mask);
      if (
        kind !== "rect" ||
        parts.length !== 1 ||
        name(parts[0]) !== "image" ||
        attr(parts[0], "transform") ||
        Number(attr(node, "x", "0")) ||
        Number(attr(node, "y", "0"))
      )
        throw new Error("PDF 包含复杂软蒙版，请使用页面图像模式转换。");
      const source = new m.Image(imageBytes(parts[0])),
        pixels = source.toPixmap(),
        rgb = color(values.fill || "black");
      const output = new m.Pixmap(
        m.ColorSpace.DeviceRGB,
        [0, 0, pixels.getWidth(), pixels.getHeight()],
        true,
      );
      try {
        const input = pixels.getPixels(),
          out = output.getPixels(),
          stride = pixels.getNumberOfComponents();
        for (let i = 0, j = 0; i < input.length; i += stride, j += 4) {
          const a = input[i];
          out[j] = Math.round((rgb[0] * a) / 255);
          out[j + 1] = Math.round((rgb[1] * a) / 255);
          out[j + 2] = Math.round((rgb[2] * a) / 255);
          out[j + 3] = a;
        }
        image = pkg.image(output.asPNG());
      } finally {
        source.destroy();
        pixels.destroy();
        output.destroy();
      }
    } else if (kind === "image") {
      const key = attr(node, "id") || attr(node, "xlink:href");
      if (!imageCache.has(key))
        imageCache.set(key, pkg.image(imageBytes(node)));
      image = imageCache.get(key);
    }
    if (image) {
      matrix = multiply(
        matrix,
        multiply(
          translate(Number(attr(node, "x", "0")), Number(attr(node, "y", "0"))),
          scale(Number(attr(node, "width")), Number(attr(node, "height"))),
        ),
      );
      objects.push(
        `<ofd:ImageObject ID="${pkg.next()}" ResourceID="${image}" Boundary="${boundary}" CTM="${matrixText(matrix)}" Alpha="${Math.round(opacity * 255)}">${clipsXml(clips, matrix)}</ofd:ImageObject>`,
      );
      return;
    }
    if (["path", "rect"].includes(kind)) {
      const fill = values.fill !== "none",
        stroke = !!values.stroke && values.stroke !== "none";
      const properties = [
        // MuPDF's SVG writer omits stroke-width for PDF hairlines; every
        // nonzero width is explicit. SVG's default 1 would thicken the line.
        `LineWidth="${esc(values["stroke-width"] ?? 0)}"`,
        `Cap="${{ round: "Round", square: "Square" }[values["stroke-linecap"]] || "Butt"}"`,
        `Join="${{ round: "Round", bevel: "Bevel" }[values["stroke-linejoin"]] || "Miter"}"`,
        `MiterLimit="${esc(values["stroke-miterlimit"] || 4)}"`,
      ];
      if (values["stroke-dasharray"] && values["stroke-dasharray"] !== "none")
        properties.push(
          `DashPattern="${numbers(values["stroke-dasharray"]).join(" ")}"`,
          `DashOffset="${esc(values["stroke-dashoffset"] || 0)}"`,
        );
      objects.push(
        `<ofd:PathObject ID="${pkg.next()}" Boundary="${boundary}" CTM="${matrixText(matrix)}" Fill="${fill}" Stroke="${stroke}" Rule="${values["fill-rule"] === "evenodd" ? "Even-Odd" : "NonZero"}" Alpha="${Math.round(opacity * 255)}" ${properties.join(" ")}>${clipsXml(clips, matrix)}${stroke ? `<ofd:StrokeColor Value="${color(values.stroke).join(" ")}" Alpha="${Math.round(Number(values["stroke-opacity"] || 1) * 255)}"/>` : ""}${fill ? `<ofd:FillColor Value="${color(values.fill).join(" ")}" Alpha="${Math.round(Number(values["fill-opacity"] || 1) * 255)}"/>` : ""}<ofd:AbbreviatedData>${pathData(pathOf(node))}</ofd:AbbreviatedData></ofd:PathObject>`,
      );
      return;
    }
    throw new Error(
      `PDF 包含暂未映射的 ${kind} 图元，请使用页面图像模式转换。`,
    );
  }
  visit(root);
  return objects.join("");
}

