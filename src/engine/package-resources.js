import { Archive, attr, child, children, name, resolve, text } from './archive.js';
import { OfdDocument } from './document.js';
import { readAttachments } from './attachments.js';

// Only package references defined by OFD are followed. URLs and opaque
// application payloads are never interpreted as executable or remote content.
export function packageReferences(archive, file) {
  const root=archive.xml(file), tag=name(root), refs=[];
  const add=(value,xml=false,base=file)=>{if(value)refs.push({path:resolve(base,value),xml});};
  const elements=(node,visit)=>{for(const n of children(node)){visit(n);elements(n,visit);}};
  if(tag==='OFD')for(const body of children(root,'DocBody')) {
    add(text(body,'DocRoot'),true);add(text(body,'Signatures'),true);
    add(text(child(body,'DocInfo'),'Cover'));
    for(const v of children(child(body,'Versions'),'Version'))add(attr(v,'BaseLoc'),true);
  }
  else if(tag==='Document') {
    for(const key of ['Annotations','Attachments','CustomTags','Extensions'])add(text(root,key),true);
    const common=child(root,'CommonData');
    for(const key of ['PublicRes','DocumentRes'])for(const r of children(common,key))add(text(r),true);
    for(const r of children(common,'TemplatePage'))add(attr(r,'BaseLoc'),true);
    for(const r of children(child(root,'Pages'),'Page'))add(attr(r,'BaseLoc'),true);
  } else if(tag==='Res') {
    const base=resolve(file,attr(root,'BaseLoc','.'))+'/';
    elements(root,n=>{
      if(['FontFile','MediaFile'].includes(name(n)))add(text(n),false,base);
      if(name(n)==='ColorSpace')add(attr(n,'Profile'),false,base);
    });
  } else if(tag==='Page'||tag==='PageAnnot') {
    elements(root,n=>{if(name(n)==='PageRes')add(text(n),true);});
  } else if(tag==='Annotations') {
    for(const p of children(root,'Page'))add(text(p,'FileLoc'),true);
  } else if(tag==='Attachments') {
    for(const a of children(root,'Attachment'))add(text(a,'FileLoc'));
  } else if(tag==='CustomTags') {
    for(const c of children(root,'CustomTag')){add(text(c,'FileLoc'));add(attr(c,'SchemaLoc'));add(text(c,'SchemaLoc'));}
  } else if(tag==='Extensions') {
    for(const e of children(root,'Extension'))for(const d of children(e,'ExtendData'))add(text(d));
  } else if(tag==='Signatures') {
    for(const s of children(root,'Signature'))add(attr(s,'BaseLoc'),true);
  } else if(tag==='Signature') {
    add(text(root,'SignedValue'));const info=child(root,'SignedInfo');
    add(text(child(info,'Seal'),'BaseLoc'));
    for(const r of children(child(info,'References'),'Reference'))add(attr(r,'FileRef'));
  } else if(tag==='DocVersion') {
    add(text(root,'DocRoot'),true);
    for(const f of children(child(root,'FileList'),'File'))add(text(f));
  }
  return refs;
}

export function inspectPackageReferences(bytes) {
  const archive=bytes instanceof Archive?bytes:new Archive(bytes);
  // Encrypted maps cannot be traversed without their keys. Do not claim a
  // reachability verdict for ciphertext by treating every .dat as legitimate.
  if(archive.has('Encryptions.xml'))return {status:'unavailable',unreferenced:[],missing:[],reason:'加密包的映射表可能为密文，引用关系需解密后检查。'};
  const reachable=new Set(),parsed=new Set(),pending=[{path:'OFD.xml',xml:true}],missing=new Set();
  for(let i=0;i<pending.length;i++) {
    const {path,xml}=pending[i];reachable.add(path);
    if(!archive.has(path)){missing.add(path);continue;}
    if(!xml||parsed.has(path))continue;
    parsed.add(path);pending.push(...packageReferences(archive,path));
    if(pending.length>100000)throw Error('包内引用数量超过限制。');
  }
  // The protection manifest and its signature form a separate standard entry.
  if(archive.has('OFDEntries.xml')) {
    reachable.add('OFDEntries.xml');const loc=text(archive.xml('OFDEntries.xml'),'SignedValueLoc');
    if(loc)reachable.add(resolve('OFDEntries.xml',loc));
  }
  return {status:'checked',missing:[...missing],unreferenced:[...archive.paths()].filter(p=>!reachable.has(p)).sort()};
}

export function pageEncryptionPlan(bytes,{pageIndices,selection={}}={}) {
  if(!Array.isArray(pageIndices)||!pageIndices.length)throw Error('请至少选择一页。');
  const doc=new OfdDocument(bytes,selection),archive=doc.archive,selected=new Set(pageIndices);
  for(const i of selected)if(!Number.isInteger(i)||i<0||i>=doc.pages.length)throw Error('加密页码超出范围。');
  const files=new Map(),seen=new Set(),templateStack=new Set();
  const add=(path,reason,xml=false)=>{
    if(!archive.has(path))throw Error(`页面依赖缺少包内文件：${path}`);
    if(!files.has(path))files.set(path,new Set());files.get(path).add(reason);
    if(!xml||seen.has(path))return;
    seen.add(path);
    for(const ref of packageReferences(archive,path))add(ref.path,`引用自 ${path}`,ref.xml);
    const actions=node=>{for(const n of children(node)) {
      if(name(n)==='GotoA') {
        const id=attr(n,'AttachID'),attachment=readAttachments(doc).find(a=>a.id===id);
        if(!attachment)throw Error(`页面动作引用了不存在的附件 ${id}。`);
        if(attachment.path)add(attachment.path,`附件动作，引用自 ${path}`);
      }
      actions(n);
    }};
    actions(archive.xml(path));
  };
  const visitPage=(file,reason)=>{
    if(templateStack.has(file))throw Error('页面模板存在循环引用。');
    templateStack.add(file);add(file,reason,true);
    for(const t of children(archive.xml(file),'Template')) {
      const template=doc.templates.get(attr(t,'TemplateID'));
      if(!template)throw Error(`缺少模板 ${attr(t,'TemplateID')}。`);
      visitPage(template.file,`模板，引用自 ${file}`);
    }
    templateStack.delete(file);
  };
  // Resource XML is the encryption unit. Encrypting its whole definition means
  // including all of its font/media/profile payloads, not leaving referenced
  // resources readable because only a subset of IDs was used on this page.
  for(const file of doc.resourceFiles)add(file,'共享资源定义',true);
  for(const i of selected) {
    const page=doc.pages[i];visitPage(page.file,`第 ${i+1} 页`);
    const annotation=doc.annotations.get(page.id);
    if(annotation)add(annotation.file,`第 ${i+1} 页注释`,true);
  }
  // Visible seals are stored in the signature value, not page resource lists.
  const sealPages=new Set();
  for(const entry of doc.signatureIndex.entries) {
    const file=resolve(doc.signatureIndex.file,attr(entry,'BaseLoc')),root=archive.xml(file),info=child(root,'SignedInfo');
    if(children(info,'StampAnnot').some(a=>[...selected].some(i=>doc.pages[i].id===attr(a,'PageRef')))) {
      for(const stamp of children(info,'StampAnnot'))sealPages.add(attr(stamp,'PageRef'));
      add(file,'所选页面的签章描述');
      const value=text(root,'SignedValue'),seal=text(child(info,'Seal'),'BaseLoc');
      if(value)add(resolve(file,value),'所选页面的签章值');
      if(seal)add(resolve(file,seal),'所选页面的电子印章');
    }
  }
  // Page-only resources and seal values can also be shared without any common
  // resource XML. Follow unselected pages' dependency paths to report that impact.
  const impacts=new Map();
  const affected=(file,stack=new Set())=>{
    if(files.has(file))return true;
    if(impacts.has(file))return impacts.get(file);
    if(stack.has(file))throw Error('页面依赖存在循环引用。');
    stack.add(file);
    const refs=packageReferences(archive,file),root=archive.xml(file);
    for(const t of children(root,'Template')) {
      const template=doc.templates.get(attr(t,'TemplateID'));
      if(!template)throw Error(`缺少模板 ${attr(t,'TemplateID')}。`);
      refs.push({path:template.file,xml:true});
    }
    const result=refs.some(r=>files.has(r.path)||(r.xml&&affected(r.path,stack)));
    stack.delete(file);impacts.set(file,result);return result;
  };
  const shared=doc.pages.flatMap((p,i)=>!selected.has(i)&&(
    doc.resourceFiles.size||sealPages.has(p.id)||affected(p.file)||
    (doc.annotations.has(p.id)&&affected(doc.annotations.get(p.id).file))
  )?[i+1]:[]);
  return {paths:[...files.keys()].map(p=>'/'+p),files:[...files].map(([path,reasons])=>({path,reasons:[...reasons]})),
    pages:[...selected].sort((a,b)=>a-b).map(i=>i+1),sharedPages:shared,
    note:shared.length?'所选页面与其他页面共享资源文件；解密前，这些页面也可能无法完整显示。':''};
}
