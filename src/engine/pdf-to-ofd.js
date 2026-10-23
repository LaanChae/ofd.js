import * as m from "mupdf";
import {convertPdfPage} from "./pdf-page-conversion.js";
import { PdfFontExporter } from "./pdf-font-export.js";
import {PdfNativeImages} from "./pdf-native-images.js";
import { PdfNativeShading } from "./pdf-native-shading.js";
import {PackageWriter, PdfPackageLimitError} from "./pdf-package-writer.js";
import {PdfStructure} from "./pdf-structure.js";
import {MM} from "./geometry.js";


export function pdfToOfd(
  bytes,
  { mode = "text", dpi = 200, password = "", subsetFonts = false } = {},
  progress = () => {},
) {
  if (
    !["text", "vector", "image"].includes(mode) ||
    ![150, 200, 300].includes(dpi) ||
    typeof subsetFonts !== "boolean"
  )
    throw new Error("转换参数无效。");
  let doc;
  try {
    doc=m.Document.openDocument(bytes,"application/pdf");
    if(!doc.asPDF())throw new Error("文件内容不是 PDF");
  } catch(error) {
    doc?.destroy();
    throw new Error(`无法读取 PDF：${error.message}。请确认文件下载完整，损坏的文件需要先修复。`);
  }
  const pkg = new PackageWriter(),
    fonts = mode !== "image" ? new PdfFontExporter(pkg, subsetFonts) : null;
  let shading,images,structure;
  try {
    if (doc.needsPassword() && !doc.authenticatePassword(password))
      throw new Error("PDF 需要正确的打开密码；请先在阅读器中解锁后再转换。");
    const count = doc.countPages();
    if (count < 1) throw new Error("PDF 中没有可转换的页面。");
    structure = new PdfStructure(doc,pkg,count);
    if(mode !== "image") {
      try {shading = new PdfNativeShading(doc,pkg);}
      catch(error) {pkg.documentWarnings.add(`渐变资源索引无法建立，受影响的渐变将保留为局部外观图像：${error.message}`);}
      try {images=new PdfNativeImages(doc);}
      catch(error) {pkg.documentWarnings.add(`原始 JPEG 复用不可用，图像将按实际解码外观保存：${error.message}`);}
    }
    for (let i = 0; i < count; i++) {
      let page;
      try {
        page=doc.loadPage(i);
        const bounds = page.getBounds(),
          w = (bounds[2] - bounds[0]) / MM,
          h = (bounds[3] - bounds[1]) / MM;
        if (!bounds.every(Number.isFinite) || w <= 0 || h <= 0 || w > 5000 || h > 5000)
          throw new Error("PDF 页面尺寸超过限制。");
        const list = new m.DisplayList(bounds), device = new m.DisplayListDevice(list);
        try {
          page.runPageContents(device, m.Matrix.identity);
          page.runPageWidgets(device, m.Matrix.identity);
          device.close();
        } catch(error) { list.destroy(); throw error; }
        finally {device.destroy();}
        const convert = (source, box, appearanceSource) => convertPdfPage(source,pkg,fonts,box,i+1,
          {mode,dpi,shading,images,appearanceSource});
        try {
          const checkpoint=pkg.checkpoint();
          let objects=convert(list,bounds);
          try {structure.page(page,i,convert,list);}
          catch(error) {
            if(error instanceof PdfPackageLimitError)throw error;
            pkg.rollback(checkpoint);
            // If annotation metadata is broken, render the complete visible
            // page instead. Do not silently drop stamps or other annotations.
            const full=new m.DisplayList(bounds),draw=new m.DisplayListDevice(full);
            try {
              list.run(draw,m.Matrix.identity);page.runPageAnnots(draw,m.Matrix.identity);draw.close();
              objects=convert(full,bounds);
            } finally {draw.destroy();full.destroy();}
            pkg.note(`注释无法独立迁移，已合并到页面外观；注释备注或交互可能缺失：${error.message}`,i+1);
          }
          pkg.page(w,h,objects,structure.pageOpenActions?.get(i));
        } finally {list.destroy();}
        progress(i + 1, count);
      } catch (error) {
        throw new Error(`第 ${i + 1} 页：${error.message}`);
      } finally {
        page?.destroy();
      }
    }
    fonts?.finish();
    structure.finish();
    return { bytes: pkg.finish(), pages: count, warnings: [...(fonts?.warnings() || []), ...pkg.warnings()] };
  } finally {
    structure?.destroy();
    shading?.destroy();
    images?.destroy();
    fonts?.destroy();
    doc.destroy();
  }
}
