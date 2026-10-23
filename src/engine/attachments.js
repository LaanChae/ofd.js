import {attr, bool, children, resolve, text} from "./archive.js";
import {ofdDateTimeToPdf} from "./document-dates.js";

// Attachment identity is its ID, never its display name or shared FileLoc.
// Listing metadata must not decompress the (potentially large) payloads.
const indexes = new WeakMap();
export function readAttachments(doc) {
  if (indexes.has(doc)) return indexes.get(doc);
  const location = text(doc.root, "Attachments"), entries = [];
  if (location) {
    const file = resolve(doc.docFile, location);
    for (const node of children(doc.archive.xml(file), "Attachment")) {
      const id = attr(node,"ID"), filename = attr(node,"Name",id), loc = text(node,"FileLoc");
      const item = {id, filename, format:attr(node,"Format"), creationDate:attr(node,"CreationDate"),
        modificationDate:attr(node,"ModDate"), size:attr(node,"Size"), visible:bool(node,"Visible",true),
        usage:attr(node,"Usage","none"), path:loc ? resolve(file,loc) : null};
      item.description = [
        `ID：${id}`, item.format && `格式：${item.format}`,
        item.creationDate && `创建时间：${item.creationDate}`,
        item.modificationDate && `修改时间：${item.modificationDate}`,
        item.size && `声明大小：${item.size} KB`, `用途：${item.usage}`,
        !item.visible && "Visible=false", !item.path && "未指定附件内容（FileLoc）",
      ].filter(Boolean).join("\n");
      entries.push(item);
    }
  }
  // Keep unambiguous names untouched. Allocate duplicate name-tree keys without
  // changing /UF, colliding with another real name, or overwriting any entry.
  const reserved = new Set(entries.map(a=>a.filename)), used = new Set();
  for (const item of entries) {
    let key = item.filename, serial = 2;
    if (used.has(key) || key === "__proto__") {
      key = `${item.filename} [${item.id}]`;
      while (used.has(key) || reserved.has(key)) key = `${item.filename} [${item.id}] (${serial++})`;
    }
    used.add(key); item.pdfKey = key;
  }
  indexes.set(doc, entries);
  return entries;
}

export function attachmentContent(doc,id) {
  const item = readAttachments(doc).find(item=>item.id===id);
  return item?.path ? doc.archive.read(item.path) : null;
}

export function writePdfAttachments(pdf,doc) {
  const targets = new Map(), streams = new Map();
  for (const item of readAttachments(doc)) {
    // FileLoc is optional in table 73. Do not fabricate empty file contents.
    if (!item.path) continue;
    const bytes=attachmentContent(doc,item.id), owned=[], keep=o=>(owned.push(o),o);
    try {
      const ref=keep(pdf.addEmbeddedFile(item.filename,"application/octet-stream",bytes,new Date(0),new Date(0))),
        stream=keep(ref.get("EF","F")), params=keep(stream.get("Params"));
      for (const [key,value] of [["CreationDate",item.creationDate],["ModDate",item.modificationDate]]) {
        const date=ofdDateTimeToPdf(value);
        if(date) params.put(key,keep(pdf.newString(date)));
        else {
          params.delete(key);
          if(value) doc.warnings.add(`附件 ${item.filename} 的 ${key} 无法表示为 PDF 日期，原始值保留在说明中。`);
        }
      }
      ref.put("Desc",keep(pdf.newString(item.description)));
      const streamKey=JSON.stringify([item.path,item.creationDate,item.modificationDate]);
      if(streams.has(streamKey)) {
        const ef=keep(ref.get("EF")), shared=keep(pdf.newIndirect(streams.get(streamKey)));
        ef.put("F",shared);ef.put("UF",shared);
      } else streams.set(streamKey,stream.asIndirect());
      // Arbitrary OFD Usage strings are not necessarily PDF AFRelationship names.
      if (["Source","Data","Alternative","Supplement","Unspecified"].includes(item.usage))
        ref.put("AFRelationship",item.usage);
      if(item.visible) {
        pdf.insertEmbeddedFile(item.pdfKey,ref);
        targets.set(item.id,{name:item.pdfKey});
      } else {
        // ISO 32000-1 table 202 allows GoToE to target a FileAttachment
        // annotation by page and NM, without listing it in EmbeddedFiles.
        const page=keep(pdf.findPage(0)),annots=keep(page.get("Annots")),
          name=`OFD-attachment-${item.id}`,
          annotation=keep(pdf.addObject({Type:"Annot",Subtype:"FileAttachment",Rect:[0,0,0,0],
            P:page,F:2|32,FS:ref,NM:keep(pdf.newString(name))}));
        if(annots.isArray())annots.push(annotation);else page.put("Annots",[annotation]);
        targets.set(item.id,{page:0,annotation:name});
      }
    } finally {owned.reverse().forEach(o=>o.destroy());}
  }
  return targets;
}
