import * as m from "mupdf";
import {pdfAttachmentTarget} from "./pdf-attachment-target.js";

// Read actual PDF action dictionaries, not application-specific metadata. This
// supplies Next and page-open actions that PDF.js's link API does not expose.
export function readPdfInteractions(bytes, password = "") {
  const pdf=m.Document.openDocument(bytes,"application/pdf"), owned=[],keep=o=>(owned.push(o),o);
  try {
    if(pdf.needsPassword()&&!pdf.authenticatePassword(password))throw Error("PDF 密码无效。");
    const attachments=pdf.getEmbeddedFiles();Object.values(attachments).forEach(keep);
    const pageIndices=new Map(Array.from({length:pdf.countPages()},(_,i)=>[keep(pdf.findPage(i)).asIndirect(),i]));
    const value=(o,k)=>keep(o.get(k));
    function destination(array) {
      if(!array.isArray())return null;
      const first=value(array,0), page=first.isIndirect()?pageIndices.get(first.asIndirect()):first.asNumber();
      if(page===undefined)return null;
      return [page,{name:value(array,1).asName()},...Array.from({length:Math.max(0,array.length-2)},(_,i)=>{const v=value(array,i+2);return v.isNull()?null:v.asNumber();})];
    }
    function actions(node,seen=new Set(),depth=0) {
      if(node.isNull()||depth>32)return [];
      if(node.isArray())return Array.from({length:node.length},(_,i)=>actions(value(node,i),seen,depth+1)).flat();
      const id=node.asIndirect();if(id&&seen.has(id))return [];if(id)seen.add(id);
      const type=value(node,"S").asName(), list=[];
      if(type==="GoTo") {const dest=destination(value(node,"D"));if(dest)list.push({dest});}
      if(type==="URI") {
        try {const url=new URL(value(node,"URI").asString());if(["http:","https:","mailto:"].includes(url.protocol))list.push({url:url.href});}catch{}
      }
      if(type==="GoToE") {
        const target=value(node,"T"), id=value(target,"N").asString();
        if(value(target,"R").asName()==="C"&&Object.hasOwn(attachments,id)) {
          const filename=value(attachments[id],"UF").asString() || value(attachments[id],"F").asString();
          list.push({attachment:{id,filename,newWindow:value(node,"NewWindow").asBoolean()}});
        } else {
          const found=pdfAttachmentTarget(pdf,target,keep);
          if(found)list.push({attachment:{filename:value(found.file,"UF").asString()||value(found.file,"F").asString(),
            annotation:{page:found.page,id:`${found.annotation.asIndirect()}R`},newWindow:value(node,"NewWindow").asBoolean()}});
        }
      }
      return [...list,...actions(value(node,"Next"),seen,depth+1)];
    }
    const catalog=keep(keep(pdf.getTrailer()).get("Root")),open=value(catalog,"OpenAction");
    const navigation={openAction:open.isArray()?{actions:[{dest:destination(open)}].filter(a=>a.dest)}:{actions:actions(open)},outlines:[]};
    function outlines(first,depth=0) {
      if(depth>32)return [];
      const result=[], seen=new Set();let entry=first;
      while(!entry.isNull()) {
        const id=entry.asIndirect();if(id&&seen.has(id))break;if(id)seen.add(id);
        result.push({actions:actions(value(entry,"A")),items:outlines(value(entry,"First"),depth+1)});
        entry=value(entry,"Next");
      }
      return result;
    }
    navigation.outlines=outlines(keep(catalog.get("Outlines","First")));
    const pages=Array.from({length:pdf.countPages()},(_,i)=>{
      const page=keep(pdf.findPage(i)),annots=value(page,"Annots"),annotations=[];
      for(let n=0;n<annots.length;n++) {
        const ref=value(annots,n),chain=actions(value(ref,"A"));
        if(chain.length)annotations.push({id:`${ref.asIndirect()}R`,actions:chain});
      }
      return {annotations,openAction:actions(keep(page.get("AA","O")))};
    });
    return {navigation,interactions:{pages}};
  }finally {owned.reverse().forEach(o=>o.destroy());pdf.destroy();}
}
