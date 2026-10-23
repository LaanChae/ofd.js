import * as m from 'mupdf';
import {multiply,IDENTITY} from './geometry.js';

// ImageMask shares the ImageObject's unit rectangle in OFD. Transform only the
// mask samples into that rectangle; retain the source image as a separate resource.
export function imageMask(clips,ctm,width,height,captures=[]){
  width=Math.max(width,Math.ceil(Math.hypot(ctm[0],ctm[1])*300/72));
  height=Math.max(height,Math.ceil(Math.hypot(ctm[2],ctm[3])*300/72));
  for(const clip of clips){
    const t=multiply(m.Matrix.invert(clip.ctm),ctm),w=clip.image.getWidth(),h=clip.image.getHeight();
    width=Math.max(width,Math.ceil(Math.hypot(t[0]*w,t[1]*h)-1e-4));
    height=Math.max(height,Math.ceil(Math.hypot(t[2]*w,t[3]*h)-1e-4));
  }
  if(width*height>40e6||width>16384||height>16384)throw new Error('图像蒙版尺寸超过安全上限。');
  const px=new m.Pixmap(m.ColorSpace.DeviceGray,[0,0,width,height],false),path=new m.Path();
  const base=multiply([width,0,0,height,0,0],m.Matrix.invert(ctm));
  const dev=new m.DrawDevice(base,px);
  try{
    px.clear(0);
    for(const capture of captures){
      dev.beginMask(capture.box,capture.luminosity,capture.space,capture.color);
      for(const [method,args] of capture.operations)dev[method](...args);
      dev.endMask();
    }
    for(const clip of clips)dev.clipImageMask(clip.image,clip.ctm);
    path.rect(0,0,1,1);dev.fillPath(path,false,ctm,m.ColorSpace.DeviceGray,[1],1);
    for(let i=0;i<clips.length+captures.length;i++)dev.popClip();dev.close();return px.asPNG();
  }finally{path.destroy();dev.destroy();px.destroy();}
}
