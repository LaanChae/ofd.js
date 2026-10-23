import * as m from "mupdf";
import {PdfPackageLimitError} from "./pdf-package-writer.js";
import {
  IDENTITY,
  MM,
  multiply,
  scale,
  transformPoint,
  translate,
} from "./geometry.js";
import { fmt, matrixText, esc } from "./ofd-write-utils.js";
import { actualTextMap } from "./pdf-actual-text.js";
import { rasterClip } from "./pdf-raster-paint.js";
import {AppearancePatches,PdfAppearanceError} from "./pdf-appearance.js";
import {overlappingTiles} from "./pdf-tiling.js";
import {imageMask} from "./pdf-image-mask.js";
import {glyphAppearance} from "./pdf-glyph-appearance.js";
import {gradientMask,tintGradientMask,combineGradientMask} from "./pdf-gradient-mask.js";

const unsupported = (what) => {
  throw new PdfAppearanceError(what);
};
function pathData(path) {
  const parts = [];
  path.walk({
    moveTo: (x, y) => parts.push(`M ${fmt(x)} ${fmt(y)}`),
    lineTo: (x, y) => parts.push(`L ${fmt(x)} ${fmt(y)}`),
    curveTo: (...points) => parts.push(`B ${points.map(fmt).join(" ")}`),
    closePath: () => parts.push("C"),
  });
  return parts.join(" ");
}
function strokeAttributes(stroke, factor = 1) {
  if (!stroke) return "";
  const cap = ["Butt", "Round", "Square"][stroke.getLineCap()];
  if (!cap) unsupported("三角形线帽");
  const join = ["Miter", "Round", "Bevel"][stroke.getLineJoin()];
  if (!join) unsupported("特殊斜接样式");
  const dash = stroke.getDashes();
  return `LineWidth="${fmt(stroke.getLineWidth() / factor)}" Cap="${cap}" Join="${join}" MiterLimit="${fmt(stroke.getMiterLimit())}"${dash?.length ? ` DashPattern="${dash.map((v) => fmt(v / factor)).join(" ")}" DashOffset="${fmt(stroke.getDashPhase() / factor)}"` : ""}`;
}
function xmlCharacter(unicode) {
  const char = String.fromCodePoint(unicode);
  return char === "\\" ? "\\005c" : esc(char);
}

export function pdfTextPage(page, pkg, fonts, bounds, w, h, pageNumber, {shading, images, runMatrix, appearanceSource, outlineAllText=false, logicalTextOnly=false, depth=0} = {}) {
  if(depth>16)throw new Error("PDF 底纹或复合图元嵌套过深。");
  const replacements = outlineAllText ? null : actualTextMap(page, bounds);
  const objects = [],
    clips = [],
    nativeClips = [],
    groups = [],
    colorCache = new Map(),
    imageCache = new Map();
  const retained = new Set();
  let pendingFill;
  let tile;
  let maskCapture;
  const masks=[];
  const patches=new AppearancePatches([0,0,w*MM,h*MM],depth);
  const boundary = `0 0 ${fmt(w)} ${fmt(h)}`;
  const matrix = (ctm) => multiply(scale(1 / MM), ctm);
  const clipXml = (image = false, outlineText = false, extra = []) => {
    if (!image && clips.some((clip) => clip.image))
      unsupported("作用于文字或路径的图片蒙版");
    const paths = clips.flatMap((clip,index)=>{
      if(clip.softMask)return clip.areas;
      const native=nativeClips[index];
      if(!outlineText || !native || !["clipText","clipStrokeText"].includes(native.method))return clip;
      const [text,...rest]=native.args,stroke=native.method==="clipStrokeText"?rest[0]:null,ctm=rest[stroke?1:0],parts=[];
      text.walk({showGlyph(font,trm,gid){if(gid<0)return;const path=fonts.glyphPath(fonts.get(font),gid);try{path.transform(trm);parts.push(`<ofd:Area>${pathXml(path,false,ctm,stroke,null,null,1,true)}</ofd:Area>`);}finally{path.destroy();}}});
      return parts.join('');
    }).filter((clip) => typeof clip === "string" && clip.length).concat(extra);
    return paths.length
      ? `<ofd:Clips>${paths.map((areas) => `<ofd:Clip>${areas}</ofd:Clip>`).join("")}</ofd:Clips>`
      : "";
  };
  const rgb = (space, values) => {
    const key = `${space.pointer}:${values.join(",")}`;
    if (colorCache.has(key)) return colorCache.get(key);
    if (space !== m.ColorSpace.DeviceRGB) retained.add(space);
    let result;
    if (space.getName() === "DeviceRGB")
      result = values.map((v) => Math.round(v * 255)).join(" ");
    else {
      const px = new m.Pixmap(m.ColorSpace.DeviceRGB, [0, 0, 1, 1], false),
        dev = new m.DrawDevice(IDENTITY, px),
        path = new m.Path();
      try {
        path.rect(0, 0, 1, 1);
        dev.fillPath(path, false, IDENTITY, space, values, 1);
        dev.close();
        result = [...px.getPixels()].join(" ");
      } finally {
        path.destroy();
        dev.destroy();
        px.destroy();
      }
    }
    colorCache.set(key, result);
    return result;
  };
  const pathXml = (
    path,
    evenOdd,
    ctm,
    stroke,
    space,
    color,
    alpha,
    clip = false,
  ) => {
    if((masks.length||clips.some(clip=>clip.image))&&!clip)return maskedPath(path,evenOdd,ctm,stroke,space,color,alpha);
    const tag = clip ? "Path" : "PathObject";
    return `<ofd:${tag}${clip ? "" : ` ID="${pkg.next()}"`} Boundary="${boundary}" CTM="${matrixText(matrix(ctm))}" Fill="${!stroke}" Stroke="${!!stroke}" Rule="${evenOdd ? "Even-Odd" : "NonZero"}" Alpha="${Math.round(alpha * 255)}" ${strokeAttributes(stroke)}>${clip ? "" : `${clipXml()}<ofd:${stroke ? "Stroke" : "Fill"}Color Value="${rgb(space, color)}"/>`}<ofd:AbbreviatedData>${pathData(path)}</ofd:AbbreviatedData></ofd:${tag}>`;
  };
  function maskedPath(path,evenOdd,ctm,stroke,space,color,alpha) {
    const extent=path.getBounds(stroke,ctm);
    if(extent[2]<=extent[0]||extent[3]<=extent[1])return "";
    const mask=masks.at(-1);
    if(masks.some(mask=>mask.transfer))throw new PdfAppearanceError('带传递函数的软蒙版');
    if(!mask||mask.generic||masks.length>1||clips.some(clip=>clip.image)) {
      let box=[...extent];
      for(const clip of nativeClips)if(clip?.bounds)box=[Math.max(box[0],clip.bounds[0]),Math.max(box[1],clip.bounds[1]),Math.min(box[2],clip.bounds[2]),Math.min(box[3],clip.bounds[3])];
      if(box[2]<=box[0]||box[3]<=box[1])return "";
      const tm=[box[2]-box[0],0,0,box[3]-box[1],box[0],box[1]],value=rgb(space,color),key=`flat:${value}`;
      if(!imageCache.has(key)){
        const px=new m.Pixmap(m.ColorSpace.DeviceRGB,[0,0,1,1],false);
        try{px.getPixels().set(value.split(' ').map(Number));imageCache.set(key,pkg.image(px.asPNG()));}finally{px.destroy();}
      }
      const maskID=pkg.image(imageMask(clips.filter(clip=>clip.image),tm,1,1,masks.map(mask=>mask.capture)));
      const area=`<ofd:Area>${pathXml(path,evenOdd,ctm,stroke,null,null,1,true)}</ofd:Area>`;
      pkg.note("通用蒙版已保存为 OFD ImageMask，颜色与矢量裁剪分别保留；蒙版按 300 DPI 或更高的原始采样密度保存。",pageNumber);
      return `<ofd:ImageObject ID="${pkg.next()}" ResourceID="${imageCache.get(key)}" ImageMask="${maskID}" Boundary="${boundary}" CTM="${matrixText(matrix(tm))}" Alpha="${Math.round(alpha*255)}">${clipXml(true,true,[area])}</ofd:ImageObject>`;
    }
    const tm=matrix(mask.ctm),box=m.Rect.transform([0,0,w*MM,h*MM],m.Matrix.invert(mask.ctm));
    const data=`M ${fmt(box[0])} ${fmt(box[1])} L ${fmt(box[2])} ${fmt(box[1])} L ${fmt(box[2])} ${fmt(box[3])} L ${fmt(box[0])} ${fmt(box[3])} C`;
    const area=`<ofd:Area>${pathXml(path,evenOdd,ctm,stroke,null,null,1,true)}</ofd:Area>`;
    return `<ofd:PathObject ID="${pkg.next()}" Boundary="${boundary}" CTM="${matrixText(tm)}" Fill="true" Stroke="false" Alpha="${Math.round(alpha*255)}">${clipXml(false,true,[area])}<ofd:FillColor>${tintGradientMask(mask,rgb(space,color))}</ofd:FillColor><ofd:AbbreviatedData>${data}</ofd:AbbreviatedData></ofd:PathObject>`;
  }
  function textXml(text, ctm, stroke, space, color, alpha, clip = false, previous = null) {
    if((masks.length||clips.some(clip=>clip.image))&&!clip&&alpha!==0) {
      // Preserve one logical text layer; paint only its glyph geometry through
      // native per-stop alpha. The mask geometry lives in page coordinates.
      const result=textXml(text,ctm,stroke,space,color,0,false,previous);
      text.walk({showGlyph(font,trm,gid){
        if(gid<0)return;
        const path=fonts.glyphPath(fonts.get(font),gid);
        try{path.transform(trm);result.push({xml:maskedPath(path,false,ctm,stroke,space,color,alpha)});}
        finally{path.destroy();}
      }});
      return result;
    }
    const result = [];
    let previousIndex = 0;
    let span;
    const finish = () => {
      if (!span?.glyphs.length) return;
      const { font, wmode } = span, entry = fonts.get(font);
      let run = [];
      for (const glyph of span.glyphs) {
        const logical = replacements && glyph.unicodes.length
          ? replacements.resolve(font, glyph, ctm) : glyph.unicodes;
        const transform = multiply(ctm, glyph.trm);
        const reason = entry.outlineReason || glyph.outlineReason ||
          (logical === null ? "无法逐字符对应的 ActualText 替代文本" : "") ||
          (Math.abs(transform[0] * transform[3] - transform[1] * transform[2]) < 1e-10
            ? "零字号或退化文字变换" : "");
        if (reason) fonts.noteOutline(entry, pageNumber, reason);
        let unicodes;
        try { unicodes = reason || outlineAllText ? null : fonts.resolveText(entry, glyph.gid, logical, pageNumber);
          if(unicodes)fonts.glyphIndex(entry,glyph.gid);
        } catch(error) {
          fonts.noteOutline(entry,pageNumber,error.message);
          unicodes=null;
        }
        if (run.length && glyph.trm.slice(0, 4).some((v, i) => Math.abs(v - run[0].trm[i]) > 1e-7)) {
          emit(run);
          run = [];
        }
        if (unicodes) run.push({ ...glyph, unicodes });
        else {
          emit(run);
          run = [];
          outline(glyph);
          previousIndex++;
        }
      }
      emit(run);
      function emit(glyphs) {
        if (!glyphs.length) return;
        const base = glyphs[0].trm;
        const transform = multiply(matrix(ctm), [
          base[0],
          base[1],
          -base[2],
          -base[3],
          base[4],
          base[5],
        ]);
        const determinant =
          transform[0] * transform[3] - transform[1] * transform[2];
        if (Math.abs(determinant) < 1e-12) {
          fonts.noteOutline(entry, pageNumber, "退化文字变换");
          glyphs.forEach(outline);
          previousIndex++;
          return;
        }
        const inverse = m.Matrix.invert([
          base[0],
          base[1],
          -base[2],
          -base[3],
          base[4],
          base[5],
        ]);
        const size = Math.hypot(base[0], base[1]);
        const outlineStroke = stroke &&
          (Math.abs(base[0] * base[2] + base[1] * base[3]) > 1e-5 ||
            Math.abs(size - Math.hypot(base[2], base[3])) > 1e-5);
        // A PDF stroke is applied after the text matrix. An OFD TextObject's
        // stroke would be sheared/scaled by that matrix. Paint a path in PDF
        // coordinates, retaining the logical text once in a transparent fill.
        if (outlineStroke && clip) {
          glyphs.forEach(outline);
          return;
        }
        let codePosition = 0;
        const transforms = [],
          codes = [];
        for (const glyph of glyphs) {
          const [x, y] = transformPoint(inverse, glyph.trm[4], glyph.trm[5]);
          const unicodes = glyph.unicodes;
          const content = unicodes.map(xmlCharacter).join("");
          const gid = fonts.useGlyph(entry, glyph.gid, unicodes);
          transforms.push(
            `<ofd:CGTransform CodePosition="${codePosition}" CodeCount="${unicodes.length}" GlyphCount="1"><ofd:Glyphs>${gid}</ofd:Glyphs></ofd:CGTransform>`,
          );
          codes.push(
            `<ofd:TextCode X="${fmt(x)}" Y="${fmt(y)}" DeltaX="0">${content}</ofd:TextCode>`,
          );
          codePosition += unicodes.length;
        }
        const tag = clip ? "Text" : "TextObject",
          attributes = `Boundary="${boundary}" CTM="${matrixText(transform)}" Font="${entry.id}" Size="1"${wmode ? ' ReadDirection="90"' : ""}`,
          body = transforms.join("") + codes.join(""),
          geometry = attributes + body,
          prior = previous?.[previousIndex++],
          merge = !!(stroke && prior?.geometry === geometry),
          fillColor = !clip && alpha===0 ? '<ofd:FillColor Value="0 0 0" Alpha="0"/>' : !clip && !stroke
            ? `<ofd:FillColor Value="${rgb(space, color)}" Alpha="${Math.round(alpha * 255)}"/>`
            : merge ? prior.fillColor : outlineStroke ? '<ofd:FillColor Value="0 0 0" Alpha="0"/>' : "",
          strokeColor = !clip && alpha!==0 && stroke && !outlineStroke
            ? `<ofd:StrokeColor Value="${rgb(space, color)}" Alpha="${Math.round(alpha * 255)}"/>` : "";
        result.push({
          geometry,
          fillColor,
          replaces: merge ? prior.index : undefined,
          xml: `<ofd:${tag}${clip ? "" : ` ID="${pkg.next()}"`} ${attributes} Fill="${!stroke || merge || !!outlineStroke || (!clip&&alpha===0)}" Stroke="${!!stroke && !outlineStroke && (clip||alpha!==0)}" ${strokeAttributes(outlineStroke ? null : stroke, size)}>${clip ? "" : clipXml(alpha===0) + strokeColor + fillColor}${body}</ofd:${tag}>`,
        });
        if (outlineStroke) glyphs.forEach(outline);
      }
      function outline(glyph) {
        if(logicalTextOnly)return;
        let path;
        try {
          try { path = fonts.glyphPath(entry, glyph.gid); }
          catch { path = fonts.nativeGlyphPath(entry,glyph.gid); }
          path.transform(glyph.trm);
          result.push({ xml: pathXml(path, false, ctm, stroke, space, color, alpha, clip) });
        } catch (error) {
          if(entry.outlineReason && !clip) {
            const content=glyphAppearance(entry.font,glyph,ctm,stroke,space,color,alpha,w,h,pkg);
            const id=pkg.composite(content,w,h);
            result.push({xml:`<ofd:CompositeObject ID="${pkg.next()}" ResourceID="${id}" Boundary="${boundary}">${clipXml()}</ofd:CompositeObject>`});
            pkg.note("复杂字形已展开为 OFD 原生复合对象、路径和图像蒙版；原有位图保持位图，该字形不再作为可检索文字。",pageNumber);
            return;
          }
          throw new Error(`字体“${entry.name}”的字形 ${glyph.gid} 无法局部转轮廓：${error.message}`);
        } finally { path?.destroy(); }
      }
    };
    text.walk({
      beginSpan(font, trm, wmode) {
        // MuPDF supplies each glyph's painted origin, including PDF W2/DW2
        // offsets. Retain those positions rather than applying vertical metrics again.
        span = { font, glyphs: [], wmode };
      },
      showGlyph(font, trm, gid, unicode) {
        if (gid < 0) {
          if (!span.glyphs.length || unicode < 0) unsupported("不完整的字符簇");
          span.glyphs.at(-1).unicodes.push(unicode);
        } else {
          const outlineReason = unicode < 0 ? "一个字符对应多个独立定位字形" : "";
          if (outlineReason) {
            // Continuation glyphs belong to the preceding logical cluster.
            // Outline the whole cluster rather than retaining only its first mark.
            for (let i = span.glyphs.length - 1; i >= 0; i--) {
              span.glyphs[i].outlineReason = outlineReason;
              if (span.glyphs[i].unicodes.length) break;
            }
          }
          span.glyphs.push({ trm, gid, unicodes: unicode < 0 ? [] : [unicode], outlineReason });
        }
      },
      endSpan: finish,
    });
    return result;
  }
  function paintImage(image, ctm, alpha, space, color) {
    if(masks.some(mask=>mask.transfer))throw new PdfAppearanceError('带传递函数的软蒙版');
    const original=!space&&images?.get(image),intrinsic=original?image.getMask():null;
    const imageMasks = clips.filter((clip) => clip.image);
    if(intrinsic)imageMasks.push({image:intrinsic,ctm});
    let maskID;
    try{maskID=imageMasks.length||masks.length?pkg.image(imageMask(imageMasks,ctm,image.getWidth(),image.getHeight(),masks.map(mask=>mask.capture))):null;}
    finally{intrinsic?.destroy();}
    const key = `${image.pointer}:${space?.pointer}:${color?.join(",")}`;
    if (!imageCache.has(key)) {
      retained.add(image);
      if (space) retained.add(space);
      const width = image.getWidth(),
        height = image.getHeight();
      if (width * height > 40e6) throw new Error("单张图片超过 4000 万像素。");
      if(original)imageCache.set(key,pkg.image(original));
      else {
      const px = new m.Pixmap(
          m.ColorSpace.DeviceRGB,
          [0, 0, width, height],
          true,
        ),
        dev = new m.DrawDevice(IDENTITY, px);
      try {
        px.clear();
        if (space)
          dev.fillImageMask(
            image,
            [width, 0, 0, height, 0, 0],
            space,
            color,
            1,
          );
        else dev.fillImage(image, [width, 0, 0, height, 0, 0], 1);
        dev.close();
        imageCache.set(key, pkg.image(px.asPNG()));
      } finally {
        dev.destroy();
        px.destroy();
      }
      }
    }
    objects.push(
      `<ofd:ImageObject ID="${pkg.next()}" ResourceID="${imageCache.get(key)}"${maskID?` ImageMask="${maskID}"`:""} Boundary="${boundary}" CTM="${matrixText(matrix(ctm))}" Alpha="${Math.round(alpha * 255)}">${clipXml(true)}</ofd:ImageObject>`,
    );
  }
  const callbacks = {
    fillPath: (path, evenOdd, ctm, space, color, alpha) =>
      objects.push(pathXml(path, evenOdd, ctm, null, space, color, alpha)),
    strokePath: (path, stroke, ctm, space, color, alpha) =>
      objects.push(pathXml(path, false, ctm, stroke, space, color, alpha)),
    clipPath: (path, evenOdd, ctm) =>
      clips.push({vector:true,start:objects.length,area:`<ofd:Area>${pathXml(path,evenOdd,ctm,null,null,null,1,true)}</ofd:Area>`}),
    clipStrokePath: (path, stroke, ctm) =>
      clips.push({vector:true,start:objects.length,area:`<ofd:Area>${pathXml(path,false,ctm,stroke,null,null,1,true)}</ofd:Area>`}),
    fillText: (text, ctm, space, color, alpha) => {
      pendingFill = textXml(text, ctm, null, space, color, alpha);
      for (const part of pendingFill) {
        part.index = objects.length;
        objects.push(part.xml);
      }
    },
    strokeText: (text, stroke, ctm, space, color, alpha) => {
      // PDF rendering modes 2/6 paint the same text twice. Emit one OFD
      // TextObject with two paints, so selecting it does not duplicate text.
      for (const part of textXml(text, ctm, stroke, space, color, alpha, false, pendingFill)) {
        if (part.replaces !== undefined) objects[part.replaces] = part.xml;
        else objects.push(part.xml);
      }
      pendingFill = null;
    },
    clipText: (text, ctm) =>
      clips.push(
        textXml(text, ctm, null, null, null, 1, true)
          .map((item) => `<ofd:Area>${item.xml}</ofd:Area>`)
          .join(""),
      ),
    clipStrokeText: (text, stroke, ctm) =>
      clips.push(
        textXml(text, ctm, stroke, null, null, 1, true)
          .map((item) => `<ofd:Area>${item.xml}</ofd:Area>`)
          .join(""),
      ),
    ignoreText: (text, ctm) =>
      objects.push(
        ...textXml(text, ctm, null, m.ColorSpace.DeviceRGB, [0, 0, 0], 0).map(part => part.xml),
      ),
    popClip: () => {
      if (!clips.length) throw new Error("PDF 裁剪栈不完整。");
      if(masks.at(-1)?.clipDepth===clips.length)masks.pop();
      const clip=clips.pop();
      if(clip.vector){
        // One native clip around a composite, rather than duplicating a complex
        // path on every paint. This also keeps large CAD/illustration pages small.
        const content=objects.splice(clip.start).join('');
        if(content){const id=pkg.composite(content,w,h);objects.push(`<ofd:CompositeObject ID="${pkg.next()}" ResourceID="${id}" Boundary="${boundary}"><ofd:Clips><ofd:Clip>${clip.area}</ofd:Clip></ofd:Clips></ofd:CompositeObject>`);}
      }
      nativeClips.pop();
    },
    fillImage: (image, ctm, alpha) => paintImage(image, ctm, alpha),
    fillImageMask: (image, ctm, space, color, alpha) =>
      paintImage(image, ctm, alpha, space, color),
    clipImageMask: (image, ctm) => {
      retained.add(image);
      clips.push({ image, ctm });
    },
    beginMask: (box,luminosity,space,color) => {
      retained.add(space);maskCapture={operations:[],space,box,luminosity,color,nesting:0};
    },
    endMask: () => {
      const capture=maskCapture;maskCapture=null;
      let mask;
      try {
        if(masks.length||!capture.luminosity||capture.color.some(v=>v!==0))throw new PdfAppearanceError('嵌套、Alpha 或有背景色的软蒙版');
        mask=gradientMask(capture.operations,shading,capture.space);
      }catch(error){
        if(error instanceof PdfPackageLimitError)throw error;
        mask={generic:true,reason:error.message,area:[]};
      }
      if(shading?.maskTransfer)mask={generic:true,transfer:true,reason:'带传递函数的软蒙版',area:[]};
      const areas=mask.area.map(([method,args])=>{
        const stroke=method==='clipStrokePath';
        return `<ofd:Area>${pathXml(args[0],stroke?false:args[1],args[2],stroke?args[1]:null,null,null,1,true)}</ofd:Area>`;
      });
      const boxPath=new m.Path();
      try {
        const [x0,y0,x1,y1]=capture.box;boxPath.rect(x0,y0,x1,y1);
        areas.unshift(`<ofd:Area>${pathXml(boxPath,false,IDENTITY,null,null,null,1,true)}</ofd:Area>`);
      }finally{boxPath.destroy();}
      clips.push({softMask:mask,areas});nativeClips.push({bounds:capture.box,mask:capture});
      masks.push({...mask,capture,clipDepth:clips.length});
    },
    beginGroup: (box, space, isolated, knockout, blend, alpha) => {
      if (knockout || blend !== "Normal")
        patches.add(box,`PDF ${knockout?"knockout 挖空":blend} 混合组`);
      groups.push({ alpha, start: objects.length });
    },
    endGroup() {
      const group = groups.pop();
      if (!group) throw new Error("PDF 图形组栈不完整。");
      if(group.alpha !== 1) {
        const content=objects.splice(group.start).join('');
        if(content){const id=pkg.composite(content,w,h);objects.push(`<ofd:CompositeObject ID="${pkg.next()}" ResourceID="${id}" Boundary="${boundary}" Alpha="${Math.round(group.alpha*255)}"/>`);}
      }
    },
    beginLayer() {},
    endLayer() {},
    fillShade: (shade, ctm, alpha) => {
      if (alpha === 0) return;
      if (clips.some(clip=>clip.image)) {
        throw new PdfAppearanceError("带图片蒙版的渐变");
      }
      if (!shading) throw new Error("PDF 原生渐变资源未初始化。");
      const plan=shading.plan(shade),extra=[];
      if(plan.clip){
        const path=new m.Path();path.rect(...plan.clip.box);
        try{extra.push(`<ofd:Area>${pathXml(path,false,multiply(ctm,plan.clip.matrix),null,null,null,1,true)}</ofd:Area>`);}finally{path.destroy();}
      }
      ctm=multiply(ctm,plan.matrix);
      const box=m.Rect.transform([0,0,w*MM,h*MM],m.Matrix.invert(ctm));
      if(plan.bbox){box[0]=Math.max(box[0],plan.bbox[0]);box[1]=Math.max(box[1],plan.bbox[1]);box[2]=Math.min(box[2],plan.bbox[2]);box[3]=Math.min(box[3],plan.bbox[3]);}
      if(box[2]<=box[0]||box[3]<=box[1])return;
      const data=`M ${fmt(box[0])} ${fmt(box[1])} L ${fmt(box[2])} ${fmt(box[1])} L ${fmt(box[2])} ${fmt(box[3])} L ${fmt(box[0])} ${fmt(box[3])} C`;
      const paint=color=>objects.push(`<ofd:PathObject ID="${pkg.next()}" Boundary="${boundary}" CTM="${matrixText(matrix(ctm))}" Fill="true" Stroke="false" Alpha="${Math.round(alpha*255)}">${clipXml(false,true,extra)}<ofd:FillColor>${color}</ofd:FillColor><ofd:AbbreviatedData>${data}</ofd:AbbreviatedData></ofd:PathObject>`);
      if(plan.background) {
        const color=plan.color(plan.background).replace('<ofd:Color ','<ofd:FillColor ');
        objects.push(`<ofd:PathObject ID="${pkg.next()}" Boundary="${boundary}" CTM="${matrixText(matrix(ctm))}" Fill="true" Stroke="false" Alpha="${Math.round(alpha*255)}">${clipXml(false,true,extra)}${color}<ofd:AbbreviatedData>${data}</ofd:AbbreviatedData></ofd:PathObject>`);
      }
      if(masks.some(mask=>mask.generic))throw new PdfAppearanceError(masks.find(mask=>mask.generic).reason);
      paint(masks.length?combineGradientMask(plan,ctm,masks.at(-1)):plan.xml);
      if(plan.approximate)pkg.note("PDF 曲面网格、颜色函数或特殊色彩空间已近似转换为 OFD 原生矢量渐变；专色印刷语义不保留。",pageNumber);
    },
    beginTile: (area,view,xstep,ystep,ctm) => {
      if(!(Math.abs(xstep)>0 && Math.abs(ystep)>0))throw new Error("PDF 平铺步长无效。");
      const list=new m.DisplayList(m.Rect.transform(view,ctm));
      tile={area,view,xstep,ystep,ctm,list,device:new m.DisplayListDevice(list),level:1};
      return 0;
    },
    endTile: () => {
      const saved=tile;tile=null;saved.device.close();saved.device.destroy();
      const {area,view,xstep,ystep,ctm,list}=saved;
      try{
        const cw=(view[2]-view[0])/MM,ch=(view[3]-view[1])/MM;
        const content=pdfTextPage(list,pkg,fonts,view,cw,ch,pageNumber,{shading,images,outlineAllText,depth:depth+1,runMatrix:multiply(translate(-view[0],-view[1]),m.Matrix.invert(ctm))});
        const tm=multiply(scale(1/MM),multiply(ctm,multiply(translate(view[0],view[1]),scale(MM))));
        const corners=[[area[0],area[1]],[area[2],area[1]],[area[2],area[3]],[area[0],area[3]]].map(p=>transformPoint(matrix(ctm),...p));
        const path=corners.map((p,i)=>`${i?'L':'M'} ${p.map(fmt).join(' ')}`).join(' ')+' C';
        if(Math.abs(xstep)<view[2]-view[0]-1e-7 || Math.abs(ystep)<view[3]-view[1]-1e-7){
          const area=`<ofd:Area><ofd:Path Boundary="${boundary}" Fill="true" Stroke="false"><ofd:AbbreviatedData>${path}</ofd:AbbreviatedData></ofd:Path></ofd:Area>`;
          objects.push(overlappingTiles(pkg,content,cw,ch,saved,boundary,clipXml(false,true,[area])));
        }else objects.push(`<ofd:PathObject ID="${pkg.next()}" Boundary="${boundary}" Fill="true" Stroke="false">${clipXml()}<ofd:FillColor><ofd:Pattern Width="${fmt(cw)}" Height="${fmt(ch)}" XStep="${fmt(Math.abs(xstep)/MM)}" YStep="${fmt(Math.abs(ystep)/MM)}" CTM="${matrixText(tm)}" RelativeTo="Object"><ofd:CellContent>${content}</ofd:CellContent></ofd:Pattern></ofd:FillColor><ofd:AbbreviatedData>${path}</ofd:AbbreviatedData></ofd:PathObject>`);
      }catch(error){
        if(error instanceof PdfPackageLimitError)throw error;
        patches.add(m.Rect.transform(area,ctm),error.message);
      }finally{list.destroy();}
    },
  };
  // Device callbacks own retained native handles. Release them immediately,
  // except cache keys whose native pointers must stay alive for this page.
  const device = new m.Device(
    Object.fromEntries(
      Object.entries(callbacks).map(([name, callback]) => [
        name,
        (...args) => {
          try {
            if(logicalTextOnly) {
              if(!['fillText','strokeText','ignoreText'].includes(name)) {
                if(['fillPath','strokePath','fillImage','fillImageMask','fillShade'].includes(name))pendingFill=null;
                return;
              }
              if(name!=='strokeText')pendingFill=null;
              const stroked=name==='strokeText';
              try {
                const parts=textXml(args[0],args[stroked?2:1],stroked?args[1]:null,
                  m.ColorSpace.DeviceRGB,[0,0,0],0,false,pendingFill);
                for(const part of parts) {
                  if(part.replaces!==undefined)objects[part.replaces]=part.xml;
                  else {part.index=objects.length;objects.push(part.xml);}
                }
                pendingFill=name==='fillText'?parts:null;
              } catch(error) {
                if(error instanceof PdfPackageLimitError)throw error;
                pkg.note(`部分文字无法可靠保留，已仅保留其页面外观：${error.message}`,pageNumber);
                pendingFill=null;
              }
              return;
            }
            if(maskCapture){
              if(name==='beginMask')maskCapture.nesting++;
              if(name==='endMask'&&maskCapture.nesting--===0)return callbacks.endMask();
              maskCapture.operations.push([name,args]);for(const arg of args)if(arg?.destroy)retained.add(arg);
              return 0;
            }
            if(tile) {
              if(name === "beginTile")tile.level++;
              if(name === "endTile" && --tile.level === 0)return callbacks.endTile();
              return tile.device[name](...args);
            }
            if (name !== "strokeText") pendingFill = null;
            if (["clipPath", "clipStrokePath", "clipText", "clipStrokeText", "clipImageMask"].includes(name)) {
              nativeClips.push(rasterClip(name, args));
              for (const arg of args) if (arg?.destroy) retained.add(arg);
            }
            const start=objects.length;
            try{return callback(...args);}
            catch(error){
              if(error instanceof PdfPackageLimitError)throw error;
              const painting=['fillPath','strokePath','fillText','strokeText','fillImage','fillImageMask','fillShade'].includes(name);
              if(!painting)throw error;
              objects.length=start;
              let box;
              if(name==='fillImage'||name==='fillImageMask')box=m.Rect.transform([0,0,1,1],args[1]);
              else if(name==='fillShade')box=m.Rect.transform(args[0].getBounds(),args[1]);
              else {const stroked=name.startsWith('stroke');box=args[0].getBounds(stroked?args[1]:null,args[name==='fillPath'||stroked?2:1]);}
              for(const clip of nativeClips)if(clip?.bounds)box=[Math.max(box[0],clip.bounds[0]),Math.max(box[1],clip.bounds[1]),Math.min(box[2],clip.bounds[2]),Math.min(box[3],clip.bounds[3])];
              patches.add(box,error.message);
              if(name==='fillText'||name==='strokeText'){
                try {
                  const stroked=name==='strokeText',parts=textXml(args[0],args[stroked?2:1],stroked?args[1]:null,args[stroked?3:2],args[stroked?4:3],0,false,pendingFill);
                  for(const part of parts){if(part.replaces!==undefined)objects[part.replaces]=part.xml;else objects.push(part.xml);}
                } catch(textError) {
                  if(textError instanceof PdfPackageLimitError)throw textError;
                  pkg.note(`部分文字已保留外观，但不能选择、搜索或复制：${textError.message}`,pageNumber);
                }
                pendingFill=null;
              }
            }
          } finally {
            for (const arg of args)
              if (arg?.destroy && !retained.has(arg)) arg.destroy();
          }
        },
      ]),
    ),
  );
  try {
    page.run(device, runMatrix || translate(-bounds[0], -bounds[1]));
    replacements?.finish();
    if (clips.length) throw new Error("PDF 裁剪栈未闭合。");
    for(const patch of patches.render(appearanceSource || page,runMatrix||translate(-bounds[0],-bounds[1]))){
      const resource=pkg.image(patch.bytes);
      objects.push(`<ofd:ImageObject ID="${pkg.next()}" ResourceID="${resource}" Boundary="${boundary}" CTM="${matrixText(matrix(patch.matrix))}"/>`);
      pkg.noteRasterization(`局部外观合成（${patch.reasons.join('、')}，包含真实背景及后续遮挡）`,pageNumber,patch.dpi);
    }
    return objects.join("");
  } finally {
    if(tile){tile.device.destroy();tile.list.destroy();}
    try {device.close();}
    finally {device.destroy();for (const value of retained) value.destroy();}
  }
}
