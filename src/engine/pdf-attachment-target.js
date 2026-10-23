// Resolve the standard GoToE child target in an attachment annotation (table
// 202). Handles are owned by the caller, and file streams remain compressed.
export function pdfAttachmentTarget(pdf,target,keep) {
  const get=(node,...keys)=>keep(node.get(...keys));
  if(get(target,"R").asName()!=="C"||!get(target,"T").isNull())return null;
  const p=get(target,"P"),a=get(target,"A");
  if(!p.isNumber()||!Number.isInteger(p.asNumber())||p.asNumber()<0||p.asNumber()>=pdf.countPages())return null;
  const pageIndex=p.asNumber(),page=keep(pdf.findPage(pageIndex)),annots=get(page,"Annots");
  let annotation;
  if(a.isNumber()&&Number.isInteger(a.asNumber())&&a.asNumber()>=0&&a.asNumber()<annots.length)
    annotation=get(annots,a.asNumber());
  else if(a.isString()) {
    for(let i=0;i<Math.min(annots.length,100000);i++) {
      const candidate=get(annots,i);
      if(get(candidate,"NM").asString()===a.asString()){annotation=candidate;break;}
    }
  }
  if(!annotation||get(annotation,"Subtype").asName()!=="FileAttachment")return null;
  const file=get(annotation,"FS");if(!pdf.isEmbeddedFile(file))return null;
  return {file,page:pageIndex,annotation};
}
