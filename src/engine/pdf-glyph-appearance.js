import * as m from 'mupdf';
import {vectorPage} from './pdf-svg-page.js';
import {MM} from './geometry.js';

// Expand a Type 3 glyph's original drawing program into standard OFD paths,
// images and ImageMask resources. Original image samples remain image samples.
export function glyphAppearance(font, glyph, ctm, stroke, space, color, alpha, w, h, pkg) {
 const buffer=new m.Buffer(),writer=new m.DocumentWriter(buffer,'svg','text=path'),text=new m.Text();let device;
 try{
  device=writer.beginPage([0,0,w*MM,h*MM]);text.showGlyph(font,glyph.trm,glyph.gid,0xfffd);
  if(stroke)device.strokeText(text,stroke,ctm,space,color,alpha);
  else device.fillText(text,ctm,space,color,alpha);
  writer.endPage();writer.close();return vectorPage(buffer.asString(),pkg,w,h);
 }finally{device?.destroy();text.destroy();writer.destroy();buffer.destroy();}
}
