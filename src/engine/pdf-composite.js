import * as m from 'mupdf';
import {child,number} from './archive.js';
import {IDENTITY} from './geometry.js';

// The PDF writing device does not apply beginGroup's alpha reliably. Serialize
// the native OFD composite as an isolated vector Form and apply alpha to its Do.
export function drawCompositeGroup(renderer,device,node,matrix,style,opacity) {
 const width=number(node,'Width',0),height=number(node,'Height',0),buffer=new m.Buffer(),writer=new m.DocumentWriter(buffer,'pdf','compress');
 const oldBounds=renderer.bounds,oldPage=renderer.pageMatrix,clipToPage=renderer.forms.clipToPage;let cell,bytes;
 try{
  renderer.bounds=[0,0,width,height];renderer.pageMatrix=IDENTITY;renderer.forms.clipToPage=false;
  cell=writer.beginPage(renderer.bounds);renderer.block(cell,child(node,'Content'),IDENTITY,style,1);writer.endPage();writer.close();bytes=buffer.asUint8Array().slice();
 }finally{renderer.bounds=oldBounds;renderer.pageMatrix=oldPage;renderer.forms.clipToPage=clipToPage;cell?.destroy();writer.destroy();buffer.destroy();}
 renderer.forms.paint(device,{matrix,box:[0,0,width,height],makeForm(pdf){
  const source=m.Document.openDocument(bytes,'application/pdf'),page=source.findPage(0),resources=page.getInheritable('Resources'),contents=page.get('Contents'),map=pdf.newGraftMap(),content=new m.Buffer(`1 0 0 -1 0 ${height} cm\n`);
  let copied,group;
  try{
   copied=map.graftObject(resources);const read=ref=>{const data=ref.readStream();try{content.writeBuffer(data);content.write('\n');}finally{data.destroy();}};
   if(contents.isArray())contents.forEach(ref=>{try{read(ref);}finally{ref.destroy();}});else read(contents);
   group=pdf.addStream(content,{Type:'XObject',Subtype:'Form',BBox:[0,0,width,height],Resources:copied,Group:{S:'Transparency',I:true,K:false,CS:'DeviceRGB'}});
   return pdf.addStream(`q ${1/width} 0 0 ${-1/height} 0 1 cm /A gs /G Do Q`,{Type:'XObject',Subtype:'Form',BBox:[0,0,1,1],Resources:{XObject:{G:group},ExtGState:{A:{ca:opacity,CA:opacity}}}});
  }finally{group?.destroy();copied?.destroy();content.destroy();map.destroy();contents.destroy();resources.destroy();page.destroy();source.destroy();}
 }},false,1);
}
