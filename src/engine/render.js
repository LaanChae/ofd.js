import { writePrintableRemarks } from "./remark-print.js";
import { writePdfAttachments } from "./attachments.js";
import { GraphicBounds, hasBounds, intersectBounds } from "./graphic-bounds.js";
import { paintWeightedText, pdfClipText } from "./text-style.js";
import { pdfStrokeColor } from "./pdf-stroke-color.js";
import { readInteractions, writePdfInteractions } from "./interactions.js";
import { drawPattern } from "./patterns.js";
import { PdfForms } from "./pdf-forms.js";
import * as m from "mupdf";
import {pixelImage} from "./image-samples.js";
import {drawCompositeGroup} from "./pdf-composite.js";
import { parseASN1 } from "./signatures.js";
import {
  name,
  children,
  child,
  text,
  attr,
  numbers,
  number,
  bool,
  resolve,
} from "./archive.js";
import {
  MM,
  IDENTITY,
  multiply,
  translate,
  scale,
  rectangle,
  roundedRectangle,
  ofdPath,
} from "./geometry.js";
import { DocumentFonts } from "./fonts.js";
import { drawGradient } from "./gradients.js";
import { OfdDocument } from "./document.js";
import { writePdfNavigation } from "./navigation.js";
import { writePdfExtensions } from "./extensions.js";

const alpha = (node) =>
  Math.max(0, Math.min(255, number(node, "Alpha", 255))) / 255;
const BLACK = { space: m.ColorSpace.DeviceRGB, values: [0, 0, 0], alpha: 1 };
export class Renderer {
  constructor(doc, store, choices = {}, backend = null) {
    this.doc = doc;
    this.store = store;
    this.fonts = new DocumentFonts(doc, store, choices);
    this.images = new Map();
    this.styledFonts = [];
    this.colorSpaces = new Map();
    this.depth = 0;
    this.backend = backend;
    this.forms = backend?.forms || new PdfForms();
    this.graphicBounds = new GraphicBounds(this);
  }
  destroy() {
    this.fonts.destroy();
    for (const font of this.styledFonts) font.destroy();
    this.releaseImages();
    for (const c of this.colorSpaces.values()) c.destroy();
  }
  releaseImages(){for(const image of this.images.values())image.destroy();this.images.clear();}
  color(node) {
    if (!node) return BLACK;
    const resource = this.doc.resources.colors.get(
      attr(node, "ColorSpace") || text(this.doc.common, "DefaultCS"),
    );
    const definition = resource?.node;
    const type = attr(definition, "Type", "RGB"),
      bits = number(definition, "BitsPerComponent", 8),
      max = 2 ** bits - 1;
    let source = attr(node, "Value");
    if (!node.hasAttribute("Value") && node.hasAttribute("Index"))
      source = text(
        children(child(definition, "Palette"), "CV")[number(node, "Index", 0)],
      );
    if (!source && children(node).length)
      return { complex: children(node)[0], alpha: alpha(node) };
    const values = String(
      source || { GRAY: "0", RGB: "0 0 0", CMYK: "0 0 0 0" }[type],
    )
      .trim()
      .split(/\s+/)
      .map((v) =>
        v.startsWith("#") ? parseInt(v.slice(1), 16) / max : Number(v) / max,
      );
    let space = {
      GRAY: m.ColorSpace.DeviceGray,
      RGB: m.ColorSpace.DeviceRGB,
      CMYK: m.ColorSpace.DeviceCMYK,
    }[type];
    const profile = attr(definition, "Profile");
    if (profile) {
      const key = resource.id;
      if (!this.colorSpaces.has(key))
        this.colorSpaces.set(
          key,
          new m.ColorSpace(
            this.doc.archive.read(resolve(resource.base, profile)),
            type,
          ),
        );
      space = this.colorSpaces.get(key);
    }
    if (
      !space ||
      values.length !== space.getNumberOfComponents() ||
      values.some((v) => !Number.isFinite(v))
    )
      throw new Error(`无效的 ${type} 颜色。`);
    return {
      space,
      profile: profile
        ? this.doc.archive.read(resolve(resource.base, profile))
        : null,
      values: values.map((v) => Math.min(1, Math.max(0, v))),
      alpha: alpha(node),
    };
  }
  stroke(style) {
    const data = {
      lineWidth: Number(style.LineWidth ?? 0.353),
      lineCap: style.Cap || "Butt",
      lineJoin: style.Join || "Miter",
      miterLimit: Number(style.MiterLimit ?? 3.528),
      dashPhase: Number(style.DashOffset ?? 0),
      dashes: style.DashPattern ? numbers(style.DashPattern) : [],
    };
    if (!data.dashes.length) return new m.StrokeState(data);
    if (data.dashes.some((n) => n < 0) || !data.dashes.some((n) => n > 0))
      throw new Error("无效虚线数组。");
    // MuPDF 1.28.1's JS StrokeState constructor allocates but does not set dash_len.
    // Parse the PDF graphics state through its public API; do not poke WASM memory.
    const doc = new m.PDFDocument();
    let state;
    const content = `${data.lineWidth} w ${Math.max(0, m.StrokeState.LINE_CAP.indexOf(data.lineCap))} J ${Math.max(0, m.StrokeState.LINE_JOIN.indexOf(data.lineJoin))} j ${data.miterLimit} M [${data.dashes.join(" ")}] ${data.dashPhase} d 0 0 m 100 0 l S`;
    const ref = doc.addPage([0, 0, 100, 100], 0, {}, content);
    doc.insertPage(-1, ref);
    ref.destroy();
    const page = doc.loadPage(0),
      capture = new m.Device({
        strokePath(path, stroke, matrix, space) {
          state = stroke;
          path.destroy();
          space.destroy();
        },
      });
    try {
      page.run(capture, IDENTITY);
      capture.close();
      if (!state) throw new Error("无法创建虚线样式。");
      return state;
    } finally {
      capture.destroy();
      page.destroy();
      doc.destroy();
    }
  }
  image(id) {
    if (!this.images.has(id)) {
      const res = this.doc.resources.images.get(id);
      if (!res?.path) throw new Error(`找不到图片资源 ${id}`);
      const image=new m.Image(this.doc.archive.read(res.path));
      try{this.images.set(id,pixelImage(image));}finally{image.destroy();}
    }
    return this.images.get(id);
  }
  maskedImage(id, maskId) {
    const key=`${id}:mask:${maskId}`;
    if(!this.images.has(key)){
      const image=this.image(id),mask=this.image(maskId),width=Math.max(image.getWidth(),mask.getWidth()),height=Math.max(image.getHeight(),mask.getHeight());
      if(width*height>40e6)throw new Error("图像与蒙版组合超过 4000 万像素。");
      const pixels=new m.Pixmap(m.ColorSpace.DeviceRGB,[0,0,width,height],true),device=new m.DrawDevice(IDENTITY,pixels),matrix=[width,0,0,height,0,0];
      try{
        pixels.clear();device.clipImageMask(mask,matrix);
        const intrinsic=image.getMask();
        try {
          if(intrinsic)device.clipImageMask(intrinsic,matrix);
          device.fillImage(image,matrix,1);
          if(intrinsic)device.popClip();
        } finally {intrinsic?.destroy();}
        device.popClip();device.close();
        // Combine at image-sample resolution before scaling the premultiplied
        // image. Separately filtering color and mask creates colored fringes.
        const combined=new m.Image(pixels);
        try{this.images.set(key,pixelImage(combined));}finally{combined.destroy();}
      }finally{device.destroy();pixels.destroy();}
    }
    return this.images.get(key);
  }
  clipBox(device, box, matrix) {
    const p = rectangle(box);
    try {
      device.clipPath(p, false, matrix);
    } finally {
      p.destroy();
    }
  }
  explicitClips(device, node, matrix, style, depth = 0) {
    if(depth>128)throw Error("裁剪区嵌套过深。");
    let count = 0;
    for (const clip of children(child(node, "Clips"), "Clip")) {
      const areas = children(clip, "Area"),
        items =
          areas.length === 1
            ? children(areas[0]).filter((n) =>
                ["Path", "Text"].includes(name(n)),
              )
            : [];
      if (items.length === 1) {
        const area = areas[0],
          item = items[0],
          box = numbers(attr(item, "Boundary", "0 0 0 0"), 4);
        const im = multiply(
          matrix,
          multiply(
            numbers(attr(area, "CTM", "1 0 0 1 0 0"), 6),
            multiply(
              translate(box[0], box[1]),
              numbers(attr(item, "CTM", "1 0 0 1 0 0"), 6),
            ),
          ),
        );
        const isText = name(item) === "Text",
          fill = bool(item, "Fill", isText),
          stroke = bool(item, "Stroke", !isText);
        if (fill !== stroke && (this.backend || !stroke) && (!isText || this.backend) && !(isText && fill && item.hasAttribute("Weight")) && !child(item,"Clips")) {
          const object = isText
            ? this.fonts.build(item,false)
            : ofdPath(text(item, "AbbreviatedData"));
          const state = this.stroke(
            this.doc.drawing(item, this.doc.drawing(area, style)),
          );
          try {
            if(item.hasAttribute("Boundary")) {
              this.clipBox(device,box,multiply(matrix,numbers(attr(area,"CTM","1 0 0 1 0 0"),6)));
              count++;
            }
            if (isText) {
              if (fill) device.clipText(object, im);
              else device.clipStrokeText(object, state, im);
            } else {
              if (fill)
                device.clipPath(object, attr(item, "Rule") === "Even-Odd", im);
              else device.clipStrokePath(object, state, im);
            }
          } finally {
            object.destroy();
            state.destroy();
          }
          count++;
          continue;
        }
      }
      // A Clip is the union of Areas; successive Clips intersect. An alpha mask handles
      // path/text/stroked areas without cancelling opposite contour orientations.
      this.clipBox(device, [this.bounds[0], this.bounds[1],
        this.bounds[2] - this.bounds[0], this.bounds[3] - this.bounds[1]], IDENTITY);
      count++;
      device.beginMask(this.bounds, false, m.ColorSpace.DeviceGray, [0]);
      for (const area of children(clip, "Area")) {
        const am = multiply(
          matrix,
          numbers(attr(area, "CTM", "1 0 0 1 0 0"), 6),
        );
        for (const item of children(area).filter((n) =>
          ["Path", "Text"].includes(name(n)),
        )) {
          const box = numbers(attr(item, "Boundary", "0 0 0 0"), 4);
          const im = multiply(
            am,
            multiply(
              translate(box[0], box[1]),
              numbers(attr(item, "CTM", "1 0 0 1 0 0"), 6),
            ),
          );
          const params = this.doc.drawing(item, this.doc.drawing(area, style));
          const object =
            name(item) === "Path"
              ? ofdPath(text(item, "AbbreviatedData"))
              : this.fonts.build(item,false);
          const stroke = this.stroke(params);
          const bounded=item.hasAttribute("Boundary");
          if(bounded)this.clipBox(device,box,am);
          let clips=bounded?1:0;
          try {
            if(child(item,"Clips"))clips+=this.explicitClips(device,item,multiply(am,translate(box[0],box[1])),params,depth+1);
            if (name(item) === "Path") {
              if (bool(item, "Fill", false))
                device.fillPath(
                  object,
                  attr(item, "Rule") === "Even-Odd",
                  im,
                  m.ColorSpace.DeviceGray,
                  [1],
                  1,
                );
              if (bool(item, "Stroke", true))
                device.strokePath(
                  object,
                  stroke,
                  im,
                  m.ColorSpace.DeviceGray,
                  [1],
                  1,
                );
            } else {
              if (bool(item, "Fill", true)) {
                if(object.weightDelta)paintWeightedText(this,device,object,im,
                  {space:m.ColorSpace.DeviceGray,values:[1],alpha:1},1,params);
                else if(!this.backend)pdfClipText(this,device,object,im,stroke,true);
                else device.fillText(object, im, m.ColorSpace.DeviceGray, [1], 1);
              }
              if (bool(item, "Stroke", false)) {
                if(!this.backend)pdfClipText(this,device,object,im,stroke,false);
                else device.strokeText(
                  object,
                  stroke,
                  im,
                  m.ColorSpace.DeviceGray,
                  [1],
                  1,
                );
              }
            }
          } finally {
            while(clips-->0)device.popClip();
            object.destroy();
            stroke.destroy();
          }
        }
      }
      // PDF device retains the last mask CTM. Restore the enclosing identity CTM
      // inside the mask before ending it so subsequent object transforms remain correct.
      const reset = new m.Path();
      try {
        device.fillPath(
          reset,
          false,
          IDENTITY,
          m.ColorSpace.DeviceGray,
          [0],
          0,
        );
      } finally {
        reset.destroy();
      }
      device.endMask();
      count++;
    }
    return count;
  }
  paint(device, node, matrix, style, opacity, visibleBounds = () => this.bounds) {
    const kind = name(node),
      isText = kind === "TextObject";
    const object = isText
      ? this.fonts.build(node)
      : ofdPath(text(node, "AbbreviatedData"));
    const stroke = this.stroke(style);
    if (isText) this.backend?.text?.(object, matrix, node);
    try {
      for (const [which, enabled] of [
        ["Fill", bool(node, "Fill", isText)],
        ["Stroke", bool(node, "Stroke", !isText)],
      ]) {
        if (
          !enabled ||
          (!style[which + "Color"] &&
            ((isText && which === "Stroke") || (!isText && which === "Fill")))
        )
          continue;
        const color = this.color(style[which + "Color"]);
        if (isText && which === "Fill" && object.weightDelta) {
          device.ignoreText(object,matrix);
          paintWeightedText(this,device,object,matrix,color,opacity,style,visibleBounds);
        } else if (color.complex) {
          if (which === "Stroke" && !this.backend) {
            if (isText && !bool(node, "Fill", true)) device.ignoreText(object, matrix);
            pdfStrokeColor(this, device, object, stroke, matrix, color, opacity, style, isText);
            continue;
          }
          if (which === "Fill") {
            if (isText) device.clipText(object, matrix);
            else
              device.clipPath(
                object,
                attr(node, "Rule") === "Even-Odd",
                matrix,
              );
          } else {
            if (isText) device.clipStrokeText(object, stroke, matrix);
            else device.clipStrokePath(object, stroke, matrix);
          }
          try {
            this.complexColor(
              device,
              color.complex,
              matrix,
              opacity * color.alpha,
              style,
              visibleBounds(),
            );
          } finally {
            device.popClip();
          }
        } else if (isText) {
          if (which === "Fill")
            device.fillText(
              object,
              matrix,
              color.space,
              color.values,
              opacity * color.alpha,
            );
          else
            device.strokeText(
              object,
              stroke,
              matrix,
              color.space,
              color.values,
              opacity * color.alpha,
            );
        } else {
          if (which === "Fill")
            device.fillPath(
              object,
              attr(node, "Rule") === "Even-Odd",
              matrix,
              color.space,
              color.values,
              opacity * color.alpha,
            );
          else
            device.strokePath(
              object,
              stroke,
              matrix,
              color.space,
              color.values,
              opacity * color.alpha,
            );
        }
      }
    } finally {
      object.destroy();
      stroke.destroy();
    }
  }
  complexColor(device, node, matrix, opacity, style, bounds = this.bounds) {
    if (!hasBounds(bounds)) return;
    bounds = this.rasterBounds(bounds);
    const kind = name(node);
    if (kind === "Pattern") {
      (this.backend?.pattern || drawPattern)(
        this,
        device,
        node,
        matrix,
        opacity,
        style,
      );
      return;
    }
    drawGradient(
      device,
      node,
      matrix,
      opacity,
      (color) => this.color(color),
      bounds,
      this.forms,
    );
  }

  rasterBounds(bounds) {
    // A device hairline and antialiasing can cover the adjacent pixel even
    // when the geometric bounds are thinner than one pixel after zooming out.
    if (!this.backend || !this.forms.matrix) return bounds;
    const inverse = m.Matrix.invert(this.forms.matrix),
      dx = Math.abs(inverse[0]) + Math.abs(inverse[2]),
      dy = Math.abs(inverse[1]) + Math.abs(inverse[3]);
    return intersectBounds(this.bounds, [bounds[0]-dx,bounds[1]-dy,bounds[2]+dx,bounds[3]+dy]);
  }

  block(device, node, parent = IDENTITY, inherited = {}, inheritedAlpha = 1) {
    if (!node) return;
    if (++this.depth > 128) throw new Error("图元嵌套过深或存在循环引用。");
    try {
      const kind = name(node);
      if (
        ["Content", "PageBlock", "Layer", "Appearance", "CellContent"].includes(
          kind,
        )
      ) {
        const style = this.doc.drawing(node, inherited);
        for (const item of children(node))
          this.block(device, item, parent, style, inheritedAlpha);
        return;
      }
      if (
        ![
          "PathObject",
          "TextObject",
          "ImageObject",
          "CompositeObject",
        ].includes(kind)
      )
        return;
      if (!bool(node, "Visible", true)) return;
      // Text extraction must not decode/cache every decorative bitmap while
      // searching a long document. Composite objects still expose their text.
      if(this.backend?.text&&["ImageObject","PathObject"].includes(kind))return;
      const opacity = inheritedAlpha * alpha(node);
      // Transparent text may be the searchable OCR layer of an imported PDF.
      if (!opacity && kind !== "TextObject") return;
      const box = numbers(attr(node, "Boundary"), 4),
        local = multiply(parent, translate(box[0], box[1]));
      const matrix = multiply(
        local,
        numbers(attr(node, "CTM", "1 0 0 1 0 0"), 6),
      );
      const style = this.doc.drawing(node, inherited);
      this.clipBox(device, box, parent);
      let clips = 1;
      try {
        clips += this.explicitClips(device, node, local, style);
        if (kind === "TextObject" || kind === "PathObject")
          this.paint(device, node, matrix, style, opacity,
            () => intersectBounds(this.bounds, this.graphicBounds.node(node, parent, inherited)));
        else if (kind === "ImageObject") {
          const id=attr(node,"ResourceID"),maskId=attr(node,"ImageMask"),image=maskId?this.maskedImage(id,maskId):this.image(id);
          const mask=image.getMask();
          if(this.backend && mask) {
            device.clipImageMask(mask,matrix);
            try {device.fillImage(image,matrix,opacity);}
            finally {device.popClip();mask.destroy();}
          } else if(mask) {
            mask.destroy();
            // Keep the image's own alpha inside a Form. Otherwise MuPDF's PDF
            // device replaces the enclosing stroke/union clip soft mask with
            // the image mask, exposing its entire rectangular bounds.
            this.forms.paintImage(device,image,matrix,opacity);
          } else device.fillImage(image,matrix,opacity);
          const border = child(node, "Border");
          if (border && number(border, "LineWidth", 0.353) > 0) {
            const path = roundedRectangle(
                [0, 0, box[2], box[3]],
                number(border, "HorizonalCornerRadius", 0),
                number(border, "VerticalCornerRadius", 0),
              ),
              stroke = this.stroke({
                LineWidth: attr(border, "LineWidth", "0.353"),
                DashPattern: attr(border, "DashPattern"),
                DashOffset: attr(border, "DashOffset", "0"),
              }),
              color = this.color(child(border, "BorderColor"));
            try {
              if (color.complex) {
                if (!this.backend) {
                  pdfStrokeColor(this, device, path, stroke, local, color, opacity, style);
                } else {
                  device.clipStrokePath(path, stroke, local);
                  try {
                    this.complexColor(device, color.complex, local, opacity * color.alpha, style,
                      intersectBounds(this.bounds, this.graphicBounds.node(node, parent, inherited)));
                  } finally { device.popClip(); }
                }
              } else device.strokePath(
                path,
                stroke,
                local,
                color.space,
                color.values,
                opacity * color.alpha,
              );
            } finally {
              path.destroy();
              stroke.destroy();
            }
          }
        } else {
          const res = this.doc.resources.composites.get(
            attr(node, "ResourceID"),
          );
          if (!res) throw new Error("复合图元引用了不存在的资源。");
          this.clipBox(
            device,
            [0, 0, number(res.node, "Width", 0), number(res.node, "Height", 0)],
            matrix,
          );
          try {
            // CompositeObject is one graphic unit: apply its opacity to the
            // completed group, not repeatedly to overlapping child objects.
            if (opacity !== 1 && !this.backend) {
              drawCompositeGroup(this, device, res.node, matrix, style, opacity);
            } else {
              const groupBounds = opacity !== 1 && !this.backend?.text
                ? intersectBounds(this.bounds, this.graphicBounds.node(node, parent, inherited))
                : this.bounds;
              if (opacity !== 1 && !hasBounds(groupBounds)) return;
              if (opacity !== 1)
                device.beginGroup(this.rasterBounds(groupBounds), m.ColorSpace.DeviceRGB, true, false, "Normal", opacity);
              try {
                this.block(device, child(res.node, "Content"), matrix, style, 1);
              } finally {
                if (opacity !== 1) device.endGroup();
              }
            }
          } finally {
            device.popClip();
          }
        }
      } finally {
        while (clips--) device.popClip();
      }
    } finally {
      this.depth--;
    }
  }
  page(device, page, matrix = null, bounds = null) {
    const box = page.box, root = page.root;
    this.fonts.sync();
    this.bounds = bounds || [0, 0, box[2] * MM, box[3] * MM];
    matrix ||= multiply(scale(MM), translate(-box[0], -box[1]));
    this.pageMatrix = matrix;
    const display = page.applicationBox;
    if (!display[2] || !display[3]) return;
    this.clipBox(device, display, matrix);
    try {
      const refs = children(root, "Template");
      const zOrder = (ref) =>
        attr(
          ref,
          "ZOrder",
          this.doc.templates.get(attr(ref, "TemplateID"))?.zOrder ||
            "Background",
        );
      const template = (ref) => {
        const file = this.doc.templates.get(attr(ref, "TemplateID"))?.file;
        if (!file) throw new Error("页面引用了不存在的模板。");
        this.layers(device, this.doc.archive.xml(file), matrix);
      };
      // GB/T 33190-2016 figure 16: each template category is below the
      // corresponding page layers, including the Body template category.
      for (const type of ["Background", "Body", "Foreground"]) {
        for (const ref of refs.filter(n => zOrder(n) === type)) template(ref);
        this.layers(device, root, matrix, type);
      }
      const annotations = this.doc.annotations.get(page.id);
      if (annotations)
        for (const annot of children(annotations.root, "Annot")) {
          if (!bool(annot, "Visible", true)) continue;
          const appearance = child(annot, "Appearance");
          if (!appearance) continue;
          const boundary = appearance.hasAttribute("Boundary")
            ? numbers(attr(appearance, "Boundary"), 4) : null;
          // Appearance extends CT_PageBlock; its Boundary is optional. Without
          // it the child objects use page coordinates and have no extra clip.
          if (boundary) this.clipBox(device, boundary, matrix);
          try {
            this.block(
              device,
              appearance,
              boundary ? multiply(matrix, translate(boundary[0], boundary[1])) : matrix,
            );
          } finally {
            if (boundary) device.popClip();
          }
        }
      this.signatures(device, page, matrix);
    } finally {
      device.popClip();
    }
  }
  layers(device, root, matrix, type = null) {
    const layers = children(child(root, "Content"), "Layer").filter(n => !type || attr(n, "Type", "Body") === type),
      order = { Background: 0, Body: 1, Foreground: 2 };
    layers.sort(
      (a, b) =>
        (order[attr(a, "Type", "Body")] ?? 1) -
        (order[attr(b, "Type", "Body")] ?? 1),
    );
    for (const layer of layers) this.block(device, layer, matrix);
  }
  signatures(device, page, matrix) {
    const { file: indexFile, entries } = this.doc.signatureIndex;
    for (const signature of entries) {
      const file = resolve(indexFile, attr(signature, "BaseLoc")),
        root = this.doc.archive.xml(file),
        info = child(root, "SignedInfo");
      const stamps = children(info, "StampAnnot").filter(
        (n) => attr(n, "PageRef") === page.id,
      );
      if (!stamps.length) continue;
      const value = text(root, "SignedValue");
      if (!value) {
        this.doc.warnings.add("签章缺少 SignedValue，未绘制外观。");
        continue;
      }
      const bytes = this.doc.archive.read(resolve(file, value));
      const images = signatureImages(bytes);
      if (!images.length) {
        this.doc.warnings.add("签章外观无法解析；数字签名未验证。");
        continue;
      }
      for (const stamp of stamps) {
        const b = numbers(attr(stamp, "Boundary"), 4),
          image = images[0];
        this.clipBox(device, b, matrix);
        let extra = false;
        try {
          if (attr(stamp, "Clip")) {
            this.clipBox(
              device,
              numbers(attr(stamp, "Clip"), 4),
              multiply(matrix, translate(b[0], b[1])),
            );
            extra = true;
          }
          if (image[0] === 0x50 && image[1] === 0x4b) {
            const sub = new OfdDocument(image);
            if (text(sub.body, "Signatures"))
              throw new Error("不允许递归嵌套签章。");
            const renderer = new Renderer(sub, this.store, {}, this.backend),
              p = sub.pages[0];
            const tm = multiply(
              matrix,
              multiply(
                translate(b[0], b[1]),
                multiply(
                  scale(b[2] / p.box[2], b[3] / p.box[3]),
                  translate(-p.box[0], -p.box[1]),
                ),
              ),
            );
            renderer.forms = this.forms;
            try {
              renderer.page(device, p, tm, this.bounds);
              for (const warning of sub.warnings) this.doc.warnings.add(warning);
              for (const [font, mappings] of renderer.fonts.glyphMappings) {
                if (!this.fonts.glyphMappings.has(font))
                  this.fonts.glyphMappings.set(font, new Map());
                const target = this.fonts.glyphMappings.get(font);
                for (const [gid, unicode] of mappings) {
                  if (target.has(gid) && target.get(gid) !== unicode)
                    this.doc.warnings.add("正文与印章中同名字体的字形映射有歧义，导出 PDF 后的复制与搜索可能不准确。");
                  else target.set(gid, unicode);
                }
              }
            } finally {
              renderer.destroy();
            }
          } else {
            const img = new m.Image(image);
            try {
              device.fillImage(
                img,
                multiply(matrix, [b[2], 0, 0, b[3], b[0], b[1]]),
                1,
              );
            } finally {
              img.destroy();
            }
          }
        } finally {
          if (extra) device.popClip();
          device.popClip();
        }
      }
    }
  }
}

function signatureImages(bytes) {
  // Render only the SES-defined picture field, never arbitrary ASN.1 octets.
  let root;
  try {
    root = parseASN1(bytes);
  } catch {
    return [];
  }
  const parts = root.valueBlock.value?.[0]?.valueBlock?.value;
  if (![1, 4].includes(parts?.[0]?.valueBlock?.valueDec)) return [];
  const info = parts?.[1]?.valueBlock?.value?.[0]?.valueBlock?.value;
  const image = info?.[3]?.valueBlock?.value?.[1]?.valueBlock?.valueHexView;
  return image?.length ? [image] : [];
}

export function ofdToPdf(doc, store, choices = {}, progress = () => {}, {subsetFonts = true} = {}) {
  if(typeof subsetFonts !== "boolean")throw new Error("字体子集化参数无效。");
  const renderer = new Renderer(doc, store, choices),
    buffer = new m.Buffer(),
    writer = new m.DocumentWriter(buffer, "pdf", "compress");
  try {
    for (let i = 0; i < doc.pages.length; i++) {
      const page = doc.pages[i],
        device = writer.beginPage([0, 0, page.box[2] * MM, page.box[3] * MM]);
      try {
        renderer.page(device, page);
      } finally {
        writer.endPage();
        device.destroy();
        renderer.releaseImages();
      }
      progress(i + 1, doc.pages.length);
    }
    writer.close();
    const intermediate=buffer.asUint8Array().slice();
    // Finalization opens a second PDF document. Release the writer's document
    // and decoded image cache before that allocation, not after saving it.
    writer.destroy();buffer.destroy();m.emptyStore();
    return {
      bytes: finalizePdf(
        intermediate,
        renderer.fonts.glyphMappings,
        doc,
        renderer.forms,
        subsetFonts,
      ),
      pages: doc.pages.length,
      warnings: [...doc.warnings],
      fonts: renderer.fonts.usages.filter((f) => f.used),
    };
  } finally {
    writer.destroy();
    buffer.destroy();
    renderer.destroy();
  }
}

// MuPDF's PDF device derives ToUnicode from the font cmap, not Text.showGlyph's
// logical character. OFD CGTransform explicitly permits a different logical value.
function finalizePdf(bytes, mappings, doc, nativeForms, subsetFonts) {
  const pdf = m.Document.openDocument(bytes, "application/pdf"),
    seen = new Set();
  const hex = (s) =>
    Array.from({ length: s.length }, (_, i) =>
      s.charCodeAt(i).toString(16).padStart(4, "0"),
    ).join("");
  function visit(resources, depth = 0) {
    if (depth > 64) throw new Error("PDF 资源嵌套过深。");
    const fonts = resources.get("Font");
    try {
      fonts.forEach((font) => {
        try {
          const id = font.asIndirect();
          if (seen.has(id)) return;
          seen.add(id);
          const base = font.get("BaseFont");
          let mapping;
          try {
            // The PDF device preserves the supplied font name, including an
            // existing subset prefix. Removing it also merges distinct subsets.
            mapping = mappings.get(base.asName());
          } finally {
            base.destroy();
          }
          if (!mapping) return;
          const cmap = font.get("ToUnicode");
          try {
            let source = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /OFDUnicode def
/CMapType 2 def
1 begincodespacerange
<0000> <ffff>
endcodespacerange
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
            if (cmap.isStream()) {
              const old = cmap.readStream();
              try {
                source = old.asString();
              } finally {
                old.destroy();
              }
            }
            const entries = [...mapping].map(
              ([gid, value]) =>
                `<${gid.toString(16).padStart(4, "0")}> <${hex(value)}>`,
            );
            const blocks = [];
            for (let i = 0; i < entries.length; i += 100) {
              const batch = entries.slice(i, i + 100);
              blocks.push(
                `${batch.length} beginbfchar\n${batch.join("\n")}\nendbfchar\n`,
              );
            }
            const content = source.replace(
              "endcmap",
              blocks.join("") + "endcmap",
            );
            if (cmap.isStream()) cmap.writeStream(content);
            else {
              const added = pdf.addStream(content, {});
              try {
                font.put("ToUnicode", added);
              } finally {
                added.destroy();
              }
            }
          } finally {
            cmap.destroy();
          }
        } finally {
          font.destroy();
        }
      });
    } finally {
      fonts.destroy();
    }
    const forms = resources.get("XObject");
    try {
      forms.forEach((form, key) => {
        try {
          const replacement = nativeForms.replace(pdf, form);
          if (replacement) {
            try {
              forms.put(key, replacement);
              const nested = replacement.get("Resources");
              try {
                if (!nested.isNull()) visit(nested, depth + 1);
              } finally {
                nested.destroy();
              }
            } finally {
              replacement.destroy();
            }
            return;
          }
          const r = form.get("Resources");
          try {
            if (!r.isNull()) visit(r, depth + 1);
          } finally {
            r.destroy();
          }
        } finally {
          form.destroy();
        }
      });
    } finally {
      forms.destroy();
    }
    const patterns = resources.get("Pattern"),
      states = resources.get("ExtGState");
    try {
      patterns.forEach((pattern) => {
        const nested = pattern.get("Resources");
        try {
          if (!nested.isNull()) visit(nested, depth + 1);
        } finally {
          nested.destroy();
          pattern.destroy();
        }
      });
      states.forEach((state) => {
        const nested = state.get("SMask", "G", "Resources");
        try {
          if (!nested.isNull()) visit(nested, depth + 1);
        } finally {
          nested.destroy();
          state.destroy();
        }
      });
    } finally {
      patterns.destroy();
      states.destroy();
    }
  }
  try {
    for (const key of ["Title", "Author", "Subject", "Creator"]) {
      const value = doc.properties.docInfo[key];
      if (value) pdf.setMetaData(`info:${key}`, value);
    }
    if (doc.properties.keywords.length)
      pdf.setMetaData("info:Keywords", doc.properties.keywords.join(", "));
    const attachmentTargets = writePdfAttachments(pdf,doc);
    for (let i = 0; i < pdf.countPages(); i++) {
      const page = pdf.findPage(i),
        res = page.getInheritable("Resources");
      try {
        visit(res);
      } finally {
        res.destroy();
        page.destroy();
      }
    }
    nativeForms.assertInstalled();
    writePdfExtensions(pdf,doc);
    writePdfNavigation(pdf, doc.navigation, attachmentTargets);
    const interactions = readInteractions(doc);
    writePdfInteractions(pdf, interactions, attachmentTargets);
    writePrintableRemarks(pdf, interactions);
    // Subset the finished document, after all pages, native forms, remarks and
    // OFD logical-character mappings have been installed. MuPDF keeps PDF CIDs
    // and ToUnicode aligned while removing unused embedded glyph programs.
    if(subsetFonts)pdf.subsetFonts();
    // MuPDF 1.28's aggressive duplicate-object pass can leave newly added form
    // streams as bare dictionaries. Collect unreachable objects without merging.
    const output = pdf.saveToBuffer({ compress: true, garbage: 1 });
    try {
      return new Uint8Array(output.asUint8Array());
    } finally {
      output.destroy();
    }
  } finally {
    pdf.destroy();
  }
}
