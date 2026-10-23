import { zipSync } from "fflate";
import { attr, children, name, resolve, text } from "./archive.js";

// §17 is an opaque extension mechanism, not an executable plugin format.
// Inspect the selected document's registration file without opening pages or
// decompressing external payloads. Keep repeated properties and choice order.
export function readExtensions(doc) {
  const location = text(doc.root,"Extensions");
  if (!location) return {file:null,entries:[],error:null};
  let file;
  try {
    file = resolve(doc.docFile,location);
    const root = doc.archive.xml(file);
    if (name(root) !== "Extensions") throw Error("扩展信息入口的根节点不是 Extensions。");
    const entries = children(root,"Extension").map((node,index) => {
      const entry = {index,appName:attr(node,"AppName"),company:attr(node,"Company"),
        appVersion:attr(node,"AppVersion"),date:attr(node,"Date"),refId:attr(node,"RefId"),values:[]};
      for (const value of children(node)) {
        const kind = name(value);
        if (kind === "Property") entry.values.push({kind:"property",name:attr(value,"Name"),
          type:attr(value,"Type"),value:value.textContent || ""});
        else if (kind === "Data") entry.values.push({kind:"data",xml:value.toString()});
        else if (kind === "ExtendData") {
          const item = {kind:"file",location:text(value),path:null,error:null};
          try {
            if (!item.location) throw Error("扩展数据文件位置为空。");
            item.path = resolve(file,item.location);
            if (!doc.archive.has(item.path)) throw Error(`找不到扩展数据文件：${item.path}`);
          } catch(error) {item.error=error.message;doc.warnings.add(`扩展信息：${error.message}`);}
          entry.values.push(item);
        }
      }
      return entry;
    });
    return {file,entries,error:null};
  } catch(error) {
    doc.warnings.add(`扩展信息：${error.message}`);
    return {file:file || null,entries:[],error:error.message};
  }
}

export function extensionFile(doc, entryIndex, valueIndex) {
  const model = readExtensions(doc), entry = model.entries[entryIndex], value = entry?.values[valueIndex];
  if (!Number.isInteger(entryIndex) || !Number.isInteger(valueIndex) || value?.kind !== "file")
    throw Error("请选择扩展信息中注册的数据文件。");
  if (value.error) throw Error(value.error);
  return {bytes:doc.archive.read(value.path),filename:value.path.split("/").at(-1)};
}

export function extensionBundle(doc) {
  const model = readExtensions(doc);
  if (model.error) throw Error(model.error);
  if (!model.file) return null;
  const files = Object.create(null);
  files[model.file] = doc.archive.read(model.file);
  for (const entry of model.entries) for (const value of entry.values) if (value.kind === "file") {
    if (value.error) throw Error(value.error);
    files[value.path] = doc.archive.read(value.path);
  }
  // Preserve original package paths, XML bytes, namespaces and binary data.
  // This is a supplemental ZIP, not a fabricated OFD document or a replacement
  // for the application needed to interpret vendor-specific extensions.
  return {bytes:zipSync(files,{level:6,mtime:new Date(1980,0,1)}),filename:"OFD-Extensions.zip"};
}

export function writePdfExtensions(pdf,doc) {
  const bundle = extensionBundle(doc);
  if (!bundle) return;
  const existing = pdf.getEmbeddedFiles();
  let filename=bundle.filename,serial=2;
  try {while(Object.hasOwn(existing,filename))filename=`OFD-Extensions (${serial++}).zip`;}
  finally {Object.values(existing).forEach(ref=>ref.destroy());}
  const now=new Date(),ref=pdf.addEmbeddedFile(filename,"application/zip",bundle.bytes,now,now),
    trailer=pdf.getTrailer(),catalog=trailer.get("Root"),description=pdf.newString("OFD 第 17 章扩展信息：原始注册 XML 与外部数据，保留包内路径。");
  try {
    ref.put("Desc",description);ref.put("AFRelationship","Supplement");
    pdf.insertEmbeddedFile(filename,ref);
    const associated=catalog.get("AF");
    try {if(associated.isArray())associated.push(ref);else catalog.put("AF",[ref]);}
    finally {associated.destroy();}
  } finally {description.destroy();catalog.destroy();trailer.destroy();ref.destroy();}
}
