import * as m from "mupdf";
import { IDENTITY, rectangle } from "./geometry.js";

// The standard defines printing of Remark but no typography for its popup.
// A shared, wrapped note appearance makes direct printing and PDF printing agree.
export function printableRemark(annotation,pageBox) {
  const font=new m.Font("zh-Hans"),width=Math.min(180,pageBox[2]-12),height=pageBox[3]-12;
  let size=9,lines;
  try {
    for(;;) {
      lines=[[]];let advance=0;
      for(const char of annotation.contentsObj.str) {
        if(char==="\r")continue;
        const gid=font.encodeCharacter(char.codePointAt(0)),step=font.advanceGlyph(gid)*size;
        if(char==="\n"||advance+step>width-12) {lines.push([]);advance=0;if(char==="\n")continue;}
        lines.at(-1).push({char,gid,advance});advance+=step;
      }
      if(lines.length*size*1.3+12<=height)break;
      if(size<=4)throw Error("注释备注过长，无法完整排入打印页面。");
      size--;
    }
    const noteHeight=lines.length*size*1.3+12,
      x=Math.min(Math.max(6,annotation.rect[0]),pageBox[2]-width-6),
      y=Math.min(Math.max(6,pageBox[3]-annotation.rect[3]),pageBox[3]-noteHeight-6),
      bounds=[x,y,x+width,y+noteHeight],list=new m.DisplayList(bounds),device=new m.DisplayListDevice(list),text=new m.Text(),path=rectangle([x,y,width,noteHeight]);
    try {
      device.fillPath(path,false,IDENTITY,m.ColorSpace.DeviceRGB,[1,1,.88],1);
      lines.forEach((line,i)=>line.forEach(({char,gid,advance})=>text.showGlyph(font,[size,0,0,-size,x+6+advance,y+6+size+i*size*1.3],gid,char.codePointAt(0))));
      device.fillText(text,IDENTITY,m.ColorSpace.DeviceRGB,[0,0,0],1);device.close();
      return {list,bounds};
    }catch(error){list.destroy();throw error;}
    finally{device.destroy();text.destroy();path.destroy();}
  }finally{font.destroy();}
}
export function drawPrintableRemarks(device,page,pageBox) {
  for(const annotation of page.annotations.filter(a=>a.ofdId&&a.print&&a.contentsObj.str)) {
    const {list}=printableRemark(annotation,pageBox);
    try {list.run(device,IDENTITY);}finally{list.destroy();}
  }
}
export function writePrintableRemarks(pdf,model) {
  model.pages.forEach((entry,index)=>{
    const page=pdf.loadPage(index),pageBox=page.getBounds();
    try {
      for(const a of entry.annotations.filter(a=>a.ofdId&&a.print&&a.contentsObj.str)) {
        const {list,bounds}=printableRemark(a,pageBox),annotation=page.createAnnotation("FreeText");
        try {
          annotation.setRect(bounds);annotation.setContents(a.contentsObj.str);annotation.setAuthor(a.titleObj.str);
          annotation.setFlags(4|32|(a.noZoom?8:0)|(a.noRotate?16:0)|(a.readOnly?64:0));
          annotation.setAppearanceFromDisplayList("N",null,IDENTITY,list);
        }finally{annotation.destroy();list.destroy();}
      }
    }finally{page.destroy();}
  });
}
