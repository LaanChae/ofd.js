import * as m from 'mupdf';

// Reuse compressed JPEG bytes only when their standalone interpretation is
// equivalent to the PDF image. PDF Decode, ICC, CMYK inversion and DCT options
// can change that interpretation; compare rendered samples for those cases.
export class PdfNativeImages {
  constructor(doc){
    this.doc=doc;this.entries=new Map();this.handles=[];
    try{
      for(let i=1;i<doc.countObjects();i++){
        const ref=doc.newIndirect(i),subtype=ref.get('Subtype');
        try{
          if(subtype.asName()!=='Image')continue;
          const filter=ref.get('Filter');
          try{
            if(filter.asName()!=='DCTDecode')continue;
            const image=doc.loadImage(ref);this.handles.push(image);this.entries.set(image.pointer,{index:i});
          }finally{filter.destroy();}
        }finally{subtype.destroy();ref.destroy();}
      }
    }catch(error){this.destroy();throw error;}
  }
  get(image){
    const entry=this.entries.get(image.pointer);if(!entry)return null;
    if('bytes' in entry)return entry.bytes;
    entry.bytes=null;
    if(image.getWidth()*image.getHeight()>40e6)return null;
    const ref=this.doc.newIndirect(entry.index);let buffer;
    try{
      buffer=ref.readRawStream();const bytes=buffer.asUint8Array().slice();
      if(bytes[0]!==255||bytes[1]!==216)return null;
      if(sameImage(image,bytes))entry.bytes=bytes;
      return entry.bytes;
    }finally{buffer?.destroy();ref.destroy();}
  }
  destroy(){for(const image of this.handles)image.destroy();this.handles=[];this.entries.clear();}
}
function sameImage(source,bytes){
  const intrinsic=source.getMask();if(intrinsic){intrinsic.destroy();return false;}
  const other=new m.Image(bytes),width=source.getWidth(),height=source.getHeight();
  let original,pixels;
  const render=image=>{
    const px=new m.Pixmap(m.ColorSpace.DeviceRGB,[0,0,width,height],false),device=new m.DrawDevice(m.Matrix.identity,px);
    try{px.clear(255);device.fillImage(image,[width,0,0,height,0,0],1);device.close();return px;}
    catch(error){px.destroy();throw error;}finally{device.destroy();}
  };
  try{
    if(other.getWidth()!==width||other.getHeight()!==height)return false;
    original=render(source);pixels=render(other);
    const a=original.getPixels(),b=pixels.getPixels();
    for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;
    return true;
  }finally{original?.destroy();pixels?.destroy();other.destroy();}
}
