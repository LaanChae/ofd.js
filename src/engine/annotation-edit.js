import { XMLSerializer } from "@xmldom/xmldom";
import { zipSync, strToU8 } from "fflate";
import { attr, bool, child, children, resolve, text, xmlParse, NS } from "./archive.js";

export function protectedFiles(doc) {
  const files=new Set();
  for(const body of children(doc.archive.xml("OFD.xml"),"DocBody")) {
    const loc=text(body,"Signatures");if(!loc)continue;
    const index=resolve("OFD.xml",loc);
    for(const entry of children(doc.archive.xml(index),"Signature")) {
      const path=resolve(index,attr(entry,"BaseLoc"));
      const refs=child(child(doc.archive.xml(path),"SignedInfo"),"References");
      if(!refs)throw Error("已有签名缺少引用列表，不能判断注释是否受保护。");
      for(const ref of children(refs,"Reference"))files.add(resolve(path,attr(ref,"FileRef")));
    }
  }
  return files;
}
export function sharedVersionFile(doc, path) {
  return doc.documents.some(document => document.versions.some(version =>
    version.files?.includes(path) && (document.index !== doc.selection.documentIndex || version.id !== doc.selection.versionId)));
}
export function editRemark(doc,pageIndex,id,value) {
  if(typeof value!=="string"||value.length>10000)throw Error("备注最多 10000 个字符。");
  const page=doc.pages[pageIndex], source=page&&doc.annotations.get(page.id);
  if(!source)throw Error("没有找到该页面的注释。");
  if(sharedVersionFile(doc,source.file))throw Error("该注释文件被其他版本共用，不能原地修改历史内容。");
  if(protectedFiles(doc).has(source.file))throw Error("该注释文件受数字签名保护，不能修改备注。");
  const root=xmlParse(doc.archive.read(source.file)), matches=children(root,"Annot").filter(n=>attr(n,"ID")===id);
  if(matches.length!==1)throw Error("注释 ID 不存在或重复。");
  const node=matches[0];if(bool(node,"ReadOnly",true))throw Error("该注释的备注为只读。");
  let remark=child(node,"Remark");
  if(!remark) {
    remark=node.ownerDocument.createElementNS(node.namespaceURI||NS,node.prefix?`${node.prefix}:Remark`:"Remark");
    node.insertBefore(remark,child(node,"Parameters")||child(node,"Appearance")||null);
  }
  remark.textContent=value;node.setAttribute("LastModDate",new Date().toISOString().slice(0,10));
  const files=Object.fromEntries(doc.archive.materialize());files[source.file]=strToU8(new XMLSerializer().serializeToString(root));
  return zipSync(files);
}
