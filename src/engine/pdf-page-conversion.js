import * as m from 'mupdf';
import {strToU8} from 'fflate';
import {PdfActualTextError} from './pdf-actual-text.js';
import {pdfTextPage} from './pdf-text-page.js';
import {rasterizePaint} from './pdf-raster-paint.js';
import {PdfPackageLimitError} from './pdf-package-writer.js';
import {MM, translate} from './geometry.js';
import {fmt, matrixText} from './ofd-write-utils.js';

// Conversion is native first. Recovery is scoped to this page/annotation, so a
// damaged mapping or unsupported graphics state never changes other pages.
export function convertPdfPage(source, pkg, fonts, box, pageNumber, options) {
  const {mode, dpi, appearanceSource, shading, images}=options;
  const width=(box[2]-box[0])/MM, height=(box[3]-box[1])/MM;
  const native=extra=>pdfTextPage(source,pkg,fonts,box,width,height,pageNumber,
    {shading,images,appearanceSource,outlineAllText:mode==='vector',...extra});
  const checked=objects=>{
    // Leave room for the page/annotation XML envelope before committing it.
    if(strToU8(objects).length>14*1048576)throw Error('单页对象超过 XML 大小限制。');
    return objects;
  };
  let cause;
  if(mode!=='image') {
    const checkpoint=pkg.checkpoint();
    try {return checked(native());}
    catch(error) {
      if(error instanceof PdfPackageLimitError)throw error;
      pkg.rollback(checkpoint);cause=error;
    }
    // Ambiguous ActualText still has reliable glyph geometry. Try paths before
    // sampling the page; never manufacture a logical character mapping.
    if(cause instanceof PdfActualTextError) {
      const checkpoint=pkg.checkpoint();
      try {
        const objects=checked(native({outlineAllText:true}));
        pkg.note(`ActualText 无法可靠定位，本页文字已转为轮廓；本页不能选择、搜索或复制文字：${cause.message}`,pageNumber);
        return objects;
      } catch(error) {
        if(error instanceof PdfPackageLimitError)throw error;
        pkg.rollback(checkpoint);cause=error;
      }
    }
  }
  let image;
  try {
    const bounds=[0,0,width*MM,height*MM];
    image=rasterizePaint(bounds,[],bounds,device=>{
      const background=new m.Path();background.rect(...bounds);
      try{device.fillPath(background,false,m.Matrix.identity,m.ColorSpace.DeviceRGB,[1,1,1],1);}
      finally{background.destroy();}
      (appearanceSource||source).run(device,translate(-box[0],-box[1]));
    }, mode==='image'?dpi:300);
  } catch(error) {
    throw new Error(`原生转换${cause?`（${cause.message}）`:''}及页面外观绘制均无法完成：${error.message}。请确认源 PDF 能正常显示，或修复源文件后重试。`);
  }
  const id=pkg.image(image.bytes), matrix=image.matrix.map(n=>n/MM);
  let text='';
  if(mode==='text') {
    const checkpoint=pkg.checkpoint();
    try {text=checked(native({logicalTextOnly:true}));}
    catch(error) {
      if(error instanceof PdfPackageLimitError)throw error;
      pkg.rollback(checkpoint);
      pkg.note(`本页文字映射无法可靠保留，只保留页面外观，不能选择、搜索或复制：${error.message}`,pageNumber);
    }
  }
  if(cause)pkg.note(`原生转换遇到无法局部处理的内容，已保留为整页图像（${Math.floor(image.dpi)} DPI），放大清晰度受限${mode==='text'?'；可可靠解析的文字另行保留':''}。原因：${cause.message}`,pageNumber);
  else if(image.dpi<dpi-0.01)pkg.note(`页面图像为控制内存占用，已从 ${dpi} DPI 调整为 ${Math.floor(image.dpi)} DPI。`,pageNumber);
  return `<ofd:ImageObject ID="${pkg.next()}" ResourceID="${id}" Boundary="0 0 ${fmt(width)} ${fmt(height)}" CTM="${matrixText(matrix)}"/>${text}`;
}
