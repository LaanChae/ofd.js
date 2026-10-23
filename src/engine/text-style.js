import * as m from "mupdf";
import { IDENTITY, rectangle, multiply, translate } from "./geometry.js";

function retainGlyphs(renderer,object) {
  const glyphs=[];
  object.walk({showGlyph(font,trm,gid){if(gid>=0)glyphs.push({font,trm,gid});else font.destroy();}});
  renderer.styledFonts.push(...glyphs.map(g=>g.font));
  return glyphs;
}

// Text inside a union mask needs its own font/text state even without Weight.
// Keep it vector data, and exclude its decorative glyphs from text extraction.
export function pdfClipText(renderer,device,object,matrix,stroke,fill) {
  const box=object.getBounds(fill?null:stroke,IDENTITY),[x0,y0,x1,y1]=box,w=x1-x0,h=y1-y0;
  if(w<=0||h<=0)return;
  const glyphs=retainGlyphs(renderer,object),state=fill?'0 Tr':
    `${stroke.getLineWidth()} w ${stroke.getLineCap()} J ${stroke.getLineJoin()} j ${stroke.getMiterLimit()} M [${(stroke.getDashes()||[]).join(' ')}] ${stroke.getDashPhase()} d 1 Tr`;
  renderer.forms.paint(device,{matrix,box,makeForm(pdf){
    const owned=[],keep=o=>(owned.push(o),o),fonts={},commands=[`/Span << /ActualText () >> BDC q 1 g 1 G ${state} BT`];
    try {
      for(const [i,{font,trm,gid}] of glyphs.entries()) {
        fonts[`F${i}`]=keep(pdf.addFont(font));
        commands.push(`/F${i} 1 Tf ${trm.join(' ')} Tm <${gid.toString(16).padStart(4,'0')}> Tj`);
      }
      commands.push('ET Q EMC');
      return pdf.addStream(commands.join('\n'),{Type:'XObject',Subtype:'Form',BBox:box,
        Matrix:[1/w,0,0,-1/h,-x0/w,y1/h],Resources:{Font:fonts}});
    }finally{owned.reverse().forEach(o=>o.destroy());}
  }},false,1);
}

// Paint the styled silhouette; the caller decides whether it represents
// searchable text or a geometric clip. Each thin-weight mask is isolated so
// black erosion never subtracts another Area from an enclosing union mask.
export function paintWeightedText(renderer,device,object,matrix,color,opacity,style,visibleBounds=()=>renderer.bounds) {
  const stroke=renderer.stroke({LineWidth:Math.abs(object.weightDelta)*2,Join:"Round"});
  try {
    const bounds=object.getBounds(stroke,matrix);
    if(!renderer.backend) {
      pdfWeightedText(renderer,device,object,matrix,color,opacity,style,stroke);
      return;
    }
    device.beginMask(bounds,true,m.ColorSpace.DeviceGray,[0]);
    device.fillText(object,matrix,m.ColorSpace.DeviceGray,[1],1);
    device.strokeText(object,stroke,matrix,m.ColorSpace.DeviceGray,[object.weightDelta>0?1:0],1);
    device.endMask();
    try {
      if(color.complex)renderer.complexColor(device,color.complex,matrix,opacity*color.alpha,style,visibleBounds());
      else {
        const fill=rectangle([bounds[0],bounds[1],bounds[2]-bounds[0],bounds[3]-bounds[1]]);
        try{device.fillPath(fill,false,IDENTITY,color.space,color.values,opacity*color.alpha);}finally{fill.destroy();}
      }
    }finally{device.popClip();}
  }finally{stroke.destroy();}
}

// Emit a self-contained vector soft mask: MuPDF's PDF device carries text/CTM
// state across beginMask, omitting necessary Tf and cm in the mask's new stream.
// Direct drawing uses the ordinary device mask; PDF gets explicit resources.
export function pdfWeightedText(renderer,device,object,matrix,color,opacity,style,stroke) {
  const box=object.getBounds(stroke,IDENTITY),[x0,y0,x1,y1]=box,w=x1-x0,h=y1-y0;
  if(w<=0||h<=0)return;
  const glyphs=retainGlyphs(renderer,object);
  // Retain handles through delayed form installation and release on renderer teardown.
  const buffer=new m.Buffer(),writer=new m.DocumentWriter(buffer,"pdf","compress");
  const bounds=renderer.bounds,pageMatrix=renderer.pageMatrix;let paint,bytes;
  try {
    renderer.bounds=[0,0,w,h];renderer.pageMatrix=multiply(translate(-x0,-y0),multiply(m.Matrix.invert(matrix),pageMatrix));
    paint=writer.beginPage([0,0,w,h]);
    if(color.complex)renderer.complexColor(paint,color.complex,translate(-x0,-y0),opacity*color.alpha,style);
    else {
      const path=rectangle([0,0,w,h]);try{paint.fillPath(path,false,IDENTITY,color.space,color.values,opacity*color.alpha);}finally{path.destroy();}
    }
    writer.endPage();writer.close();bytes=buffer.asUint8Array().slice();
  } finally {renderer.bounds=bounds;renderer.pageMatrix=pageMatrix;paint?.destroy();writer.destroy();buffer.destroy();}
  renderer.forms.paint(device,{matrix,box,makeForm(pdf){
    const owned=[],keep=o=>(owned.push(o),o),source=m.Document.openDocument(bytes,"application/pdf"),graft=pdf.newGraftMap();
    try {
      const fonts={},commands=[`/Span << /ActualText () >> BDC q 1 g ${object.weightDelta>0?1:0} G ${Math.abs(object.weightDelta)*2} w 0 J 1 j 2 Tr BT`];
      for(let i=0;i<glyphs.length;i++) {
        const {font,trm,gid}=glyphs[i],key=`F${i}`;
        fonts[key]=keep(pdf.addFont(font));
        commands.push(`/${key} 1 Tf ${trm.join(" ")} Tm <${gid.toString(16).padStart(4,"0")}> Tj`);
      }
      commands.push("ET Q EMC");
      const mask=keep(pdf.addStream(commands.join("\n"),{Type:"XObject",Subtype:"Form",BBox:box,Group:{S:"Transparency",CS:"DeviceGray",I:true},Resources:{Font:fonts}}));
      const page=keep(source.findPage(0)),resources=keep(graft.graftObject(keep(page.getInheritable("Resources")))),contents=keep(page.get("Contents")),data=keep(contents.readStream());
      const paintForm=keep(pdf.addStream(data.asUint8Array().slice(),{Type:"XObject",Subtype:"Form",BBox:[0,0,w,h],Resources:resources}));
      return pdf.addStream(`q /A gs 1 0 0 -1 ${x0} ${y1} cm /Paint Do Q`,{Type:"XObject",Subtype:"Form",BBox:box,Matrix:[1/w,0,0,-1/h,-x0/w,y1/h],Resources:{XObject:{Paint:paintForm},ExtGState:{A:{SMask:{S:"Luminosity",G:mask,BC:[0]}}}}});
    } finally {owned.reverse().forEach(o=>o.destroy());graft.destroy();source.destroy();}
  }},false,1);
}
