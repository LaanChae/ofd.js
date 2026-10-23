import {NS} from "./archive.js";
import {xml, PdfPackageLimitError} from "./pdf-package-writer.js";
import {esc, fmt} from "./ofd-write-utils.js";
import {MM, transformPoint} from "./geometry.js";
import {pdfDateTimeToOfd} from "./document-dates.js";
import {pdfAttachmentTarget} from "./pdf-attachment-target.js";

// PDF objects never outlive their document. Each traversal owns its handles;
// only strings, page geometry and attachment IDs survive between pages.
function scope(fn) {
  const owned = [], keep = o => (owned.push(o), o);
  const get = (o, ...keys) => o.isNull() ? o : keep(o.get(...keys));
  try { return fn(get, keep); }
  finally { owned.reverse().forEach(o => o.destroy()); }
}
function date(value) {
  return value instanceof Date && Number.isFinite(value.getTime()) && value.getTime() > 0
    ? value.toISOString() : "";
}
function rect(points, matrix) {
  const [x0,y0,x1,y1] = points;
  const corners = [[x0,y0],[x0,y1],[x1,y0],[x1,y1]].map(([x,y]) => transformPoint(matrix,x,y));
  return [Math.min(...corners.map(p=>p[0])), Math.min(...corners.map(p=>p[1])),
    Math.max(...corners.map(p=>p[0])), Math.max(...corners.map(p=>p[1]))];
}

export class PdfStructure {
  constructor(pdf, pkg, count) {
    this.pdf=pdf; this.pkg=pkg; this.pageIndices=new Map(); this.geometry=new Map();
    this.attachments=[]; this.fileSpecs=new Map(); this.attachmentNames=new Map();
    this.annotationPages=[]; this.pageOpenActions=new Map(); this.nodes=0;
    this.namedDests=new Map();this.owned=[];
    for(let i=0;i<count;i++) {
      const ref=pdf.findPage(i);
      try { this.pageIndices.set(ref.asIndirect(),i); } finally { ref.destroy(); }
      pkg.pageIds.push(pkg.next());
    }
    try {this.read("文档附加结构",()=>scope((get,keep)=>{
      const root=get(keep(pdf.getTrailer()),"Root");
      const entries=this.read('附件名称树',()=>this.nameTree(get(root,"Names","EmbeddedFiles"),get),new Map());
      for(const [name,ref] of entries) this.read(`附件 ${name}`,()=>this.attachment(ref,name));
      // Retain destination values for all pages and outline nodes, not a new
      // traversal for every link. Null/cyclic name trees are bounded here.
      this.namedDests=this.read("命名目标",()=>this.nameTree(get(root,"Names","Dests"),(o,...keys)=>{const ref=o.isNull()?o:o.get(...keys);this.owned.push(ref);return ref;}),new Map());
      const legacy=get(root,"Dests");
      if(legacy.isDictionary())legacy.forEach((ref,name)=>{this.owned.push(ref);if(!this.namedDests.has(name))this.namedDests.set(name,ref);});
      this.read("关联附件",()=>this.associated(get(root,"AF"),get));
    }));}catch(error){this.destroy();throw error;}
    // FileAttachment/AF may be the only owner of an embedded file. Register
    // these before resolving actions on earlier pages that open that file.
    try {for(let i=0;i<count;i++)this.read(`第 ${i+1} 页附件`,()=>scope((get,keep)=>{
      const page=keep(pdf.findPage(i));this.associated(get(page,"AF"),get);
      const annots=get(page,"Annots");
      for(let j=0;j<annots.length;j++) {this.limit();const fs=get(annots,j,"FS"),flags=get(annots,j,"F").asNumber();if(!fs.isNull())this.read(`第 ${i+1} 页注释附件`,()=>this.attachment(fs,"",!(flags&2)));}
    }));}catch(error){this.destroy();throw error;}
  }
  read(label,fn,fallback="") {
    try{return fn();}
    catch(error){
      if(error instanceof PdfPackageLimitError)throw error;
      this.warn(`PDF ${label} 无法完整迁移，页面外观仍保留：${error.message}`);
      return fallback;
    }
  }
  destroy() { this.owned.reverse().forEach(o=>o.destroy());this.owned=[]; }
  nameTree(root,get) {
    const result=new Map(),seen=new Set();
    const walk=(node,depth=0)=>{
      if(node.isNull())return;this.limit();
      if(depth>64){this.warn("PDF 名称树嵌套超过 64 层，未迁移过深分支。");return;}
      const id=node.asIndirect();if(id&&seen.has(id)){this.warn("PDF 名称树包含循环，已停止重复节点。");return;}if(id)seen.add(id);
      const names=get(node,"Names"),kids=get(node,"Kids");
      for(let i=0;i+1<names.length;i+=2){this.limit();result.set(get(names,i).asString(),get(names,i+1));}
      for(let i=0;i<kids.length;i++)walk(get(kids,i),depth+1);
    };walk(root);return result;
  }
  limit() { if(++this.nodes>100000) throw Error("PDF 文档结构超过 100000 个节点。"); }
  warn(message) { this.pkg.documentWarnings.add(message); }
  pageGeometry(index) {
    if(!this.geometry.has(index)) {
      const page=this.pdf.loadPage(index);
      try { this.geometry.set(index,{matrix:page.getTransform(),bounds:page.getBounds()}); }
      finally { page.destroy(); }
    }
    return this.geometry.get(index);
  }
  associated(array,get) {
    if(array.isArray()) for(let i=0;i<array.length;i++) this.read("关联附件",()=>this.attachment(get(array,i)));
  }
  attachment(ref, treeName="", visible=true) {
    if(ref.isNull()) return null;
    this.limit();
    const key=ref.asIndirect() || ref.toString();
    if(this.fileSpecs.has(key)) {
      const id=this.fileSpecs.get(key);
      if(treeName)this.attachmentNames.set(treeName,id);
      return id;
    }
    if(!this.pdf.isEmbeddedFile(ref)) {
      this.warn("外部文件引用未打包：仅迁移 PDF 内嵌附件，不读取本机或网络文件。");
      return null;
    }
    return scope((get)=>{
      const buffer=this.pdf.getEmbeddedFileContents(ref);
      if(!buffer) { this.warn("PDF 附件缺少可读取的数据流。"); return null; }
      let bytes;
      try { bytes=buffer.asUint8Array().slice(); } finally { buffer.destroy(); }
      const sourceName=get(ref,"UF").asString() || get(ref,"F").asString() || treeName || "附件";
      const name=sourceName;
      const id=this.pkg.next(), file=this.pkg.binary(bytes,"bin");
      const stream=get(ref,"EF","UF").isNull()?get(ref,"EF","F"):get(ref,"EF","UF");
      const created=pdfDateTimeToOfd(get(stream,"Params","CreationDate").asString()),
        modified=pdfDateTimeToOfd(get(stream,"Params","ModDate").asString());
      const usage=get(ref,"AFRelationship").asName();
      const format=sourceName.match(/\.([a-zA-Z0-9]{1,16})$/)?.[1] || "";
      this.attachments.push({id,name,xml:`<ofd:Attachment ID="${id}" Name="${esc(name)}"${visible?'':' Visible="false"'}${format?` Format="${format}"`:""}${created?` CreationDate="${created}"`:""}${modified?` ModDate="${modified}"`:""} Size="${fmt(bytes.length/1024)}"${usage?` Usage="${esc(usage)}"`:""}><ofd:FileLoc>Res/${file}</ofd:FileLoc></ofd:Attachment>`});
      this.fileSpecs.set(key,id);
      if(treeName)this.attachmentNames.set(treeName,id);
      if(!this.attachmentNames.has(sourceName))this.attachmentNames.set(sourceName,id);
      return id;
    });
  }
  destination(value,get,keep,depth=0) {
    if(depth>32) { this.warn("PDF 命名目标循环或嵌套过深，未迁移该跳转。"); return ""; }
    if(value.isString()||value.isName()) {
      const name=value.isString()?value.asString():value.asName();
      const target=this.namedDests.get(name);
      if(!target){this.warn(`PDF 命名目标 ${name} 不存在。`);return "";}
      return this.destination(target,get,keep,depth+1);
    }
    if(value.isDictionary()) return this.destination(get(value,"D"),get,keep,depth+1);
    if(!value.isArray()) { if(!value.isNull())this.warn("PDF 跳转目标无效，未迁移该跳转。"); return ""; }
    const first=get(value,0), index=first.isIndirect()?this.pageIndices.get(first.asIndirect()):first.isNumber()?first.asNumber():undefined;
    if(!Number.isInteger(index)||!this.pkg.pageIds[index]) { this.warn("PDF 跳转引用不存在的页面。"); return ""; }
    let type=get(value,1).asName();
    if(["FitB","FitBH","FitBV"].includes(type)) {
      this.warn("PDF 按内容边界适配的跳转已转换为 OFD 按页面适配。"); type=type.replace("B","");
    }
    const {matrix,bounds}=this.pageGeometry(index);
    const number=(i,fallback=0)=>{const v=get(value,i);return v.isNumber()?v.asNumber():fallback;};
    const point=(x,y)=>{const p=transformPoint(matrix,x,y);return [(p[0]-bounds[0])/MM,(p[1]-bounds[1])/MM];};
    let attrs="";
    if(type==="XYZ") {
      const missing=get(value,2).isNull()||get(value,3).isNull();
      const [x,y]=point(number(2),number(3));
      attrs=` Left="${fmt(get(value,2).isNull()?0:x)}" Top="${fmt(get(value,3).isNull()?0:y)}" Zoom="${fmt(number(4))}"`;
      if(missing)this.warn("PDF 保持当前坐标的空值目标已转换为固定页面坐标。");
    } else if(type==="FitH"||type==="FitV") {
      const [x,y]=point(type==="FitV"?number(2):0,type==="FitH"?number(2):0);
      const rotated=Math.abs(matrix[0])<1e-8;
      if(rotated)type=type==="FitH"?"FitV":"FitH";
      attrs=type==="FitH"?` Top="${fmt(y)}"`:` Left="${fmt(x)}"`;
    } else if(type==="FitR") {
      const box=rect([number(2),number(3),number(4),number(5)],matrix);
      attrs=` Left="${fmt((box[0]-bounds[0])/MM)}" Top="${fmt((box[1]-bounds[1])/MM)}" Right="${fmt((box[2]-bounds[0])/MM)}" Bottom="${fmt((box[3]-bounds[1])/MM)}"`;
    } else if(type!=="Fit") {this.warn(`PDF 跳转类型 ${type} 尚未迁移。`);return "";}
    return `<ofd:Dest Type="${type}" PageID="${this.pkg.pageIds[index]}"${attrs}/>`;
  }
  actions(node,get,keep,event="CLICK",depth=0,seen=new Set()) {
    if(node.isNull())return "";
    this.limit();
    if(depth>32) {this.warn("PDF 动作链嵌套过深。");return "";}
    if(node.isArray())return Array.from({length:node.length},(_,i)=>this.actions(get(node,i),get,keep,event,depth+1,seen)).join("");
    const id=node.asIndirect();if(id&&seen.has(id)){this.warn("PDF 动作链包含循环。");return "";}if(id)seen.add(id);
    const type=get(node,"S").asName();let target="";
    if(type==="GoTo") {const dest=this.destination(get(node,"D"),get,keep);if(dest)target=`<ofd:Goto>${dest}</ofd:Goto>`;}
    else if(type==="URI") {
      const base=get(get(keep(this.pdf.getTrailer()),"Root"),"URI","Base").asString();
      try {const uri=new URL(get(node,"URI").asString(),base||undefined);if(["https:","http:","mailto:"].includes(uri.protocol))target=`<ofd:URI URI="${esc(uri.href)}"/>`;}catch{}
      if(!target)this.warn("PDF 链接地址无效或协议不受支持，未迁移该动作。");
    } else if(type==="GoToE") {
      const child=get(node,"T"), name=get(child,"N").asString();
      const found=pdfAttachmentTarget(this.pdf,child,keep),
        id=get(child,"R").asName()==="C"?(found?this.attachment(found.file,"",!(get(found.annotation,"F").asNumber()&2)):this.attachmentNames.get(name)):null;
      if(id) {target=`<ofd:GotoA AttachID="${id}" NewWindow="${get(node,"NewWindow").isNull()||get(node,"NewWindow").asBoolean()}"/>`;this.warn("PDF 附件内部定位已转换为打开附件。");}
      else this.warn("PDF 附件跳转未找到对应的内嵌附件。");
    } else if(type) this.warn(`PDF ${type} 动作尚无对应迁移，已保留外观但不执行该动作。`);
    return (target?`<ofd:Action Event="${event}">${target}</ofd:Action>`:"")+this.actions(get(node,"Next"),get,keep,event,depth+1,seen);
  }
  target(node,get,keep,event="CLICK") {
    const dest=this.destination(get(node,"Dest"),get,keep);
    return dest?`<ofd:Action Event="${event}"><ofd:Goto>${dest}</ofd:Goto></ofd:Action>`:this.actions(get(node,"A"),get,keep,event);
  }
  actionObject(actions,w,h) {
    return actions?`<ofd:PathObject ID="${this.pkg.next()}" Boundary="0 0 ${fmt(w)} ${fmt(h)}" Fill="false" Stroke="false"><ofd:Actions>${actions}</ofd:Actions><ofd:AbbreviatedData>M 0 0 L ${fmt(w)} 0 L ${fmt(w)} ${fmt(h)} L 0 ${fmt(h)} C</ofd:AbbreviatedData></ofd:PathObject>`:"";
  }
  page(page,index,convert,baseList) {
    const pageBounds=page.getBounds(), entries=[], annotations=page.getAnnotations();
    try {
      scope((get,keep)=>{
        const raw=keep(this.pdf.findPage(index));
        this.associated(get(raw,"AF"),get);
        const open=this.actions(get(raw,"AA","O"),get,keep,"PO");
        this.pageOpenActions.set(index,open);
        const links=get(raw,"Annots");
        for(let i=0;i<links.length;i++) {
          const link=get(links,i);if(get(link,"Subtype").asName()!=="Link")continue;
          const source=get(link,"Rect");if(source.length!==4)continue;
          const box=rect(Array.from({length:4},(_,j)=>get(source,j).asNumber()),page.getTransform());
          const flags=get(link,"F").asNumber();
          entries.push(this.annotXml("Link",box,pageBounds,"",this.target(link,get,keep),{flags,creator:"",modified:"",contents:""}));
        }
      });
      const previous=[];
      for(const annot of annotations) {
        this.limit();
        const type=annot.getType();if(type==="Popup"||type==="Link")continue;
        const flags=annot.getFlags(), visible=!(flags&(1|2|32)), bounds=annot.getBounds();
        if(!bounds.every(Number.isFinite)||bounds[2]<=bounds[0]||bounds[3]<=bounds[1]) {
          this.warn(`第 ${index+1} 页 ${type} 注释没有有效边界，未迁移。`);continue;
        }
        previous.push(annot);
        let objects="";
        if(visible) {
          const list=annot.toDisplayList();
          // The prefix includes the true backdrop, but not later annotations.
          const appearanceSource={run(device,matrix){baseList.run(device,matrix);for(const item of previous)item.run(device,matrix);}};
          try {objects=convert(list,bounds,appearanceSource);} finally {list.destroy();}
        }
        const actions=scope((get,keep)=>{
          const object=keep(annot.getObject()), fs=get(object,"FS"), id=fs.isNull()?null:this.attachment(fs);
          return this.target(object,get,keep)+(id?`<ofd:Action Event="CLICK"><ofd:GotoA AttachID="${id}" NewWindow="true"/></ofd:Action>`:"");
        });
        const ofdType=["Highlight","Underline","Squiggly","StrikeOut"].includes(type)?"Highlight":type==="Stamp"?"Stamp":type==="Watermark"?"Watermark":"Path";
        entries.push(this.annotXml(ofdType,bounds,pageBounds,objects,actions,{flags,creator:annot.hasAuthor()?annot.getAuthor():"",modified:date(annot.getModificationDate()),contents:annot.getContents(),subtype:type}));
        if(flags&32 || !(flags&4))this.warn("PDF 注释的显示/打印外观标志与 OFD Print（备注打印）不等价，已按屏幕可见外观迁移。");
      }
      if(entries.length) {
        const file=`Pages/${index}/Annotation.xml`;
        this.pkg.add(`Doc_0/${file}`,xml(`<ofd:PageAnnot xmlns:ofd="${NS}">${entries.join("")}</ofd:PageAnnot>`));
        this.annotationPages.push(`<ofd:Page PageID="${this.pkg.pageIds[index]}"><ofd:FileLoc>${file}</ofd:FileLoc></ofd:Page>`);
      }
    } finally {annotations.forEach(a=>a.destroy());}
  }
  annotXml(type,box,pageBounds,objects,actions,info) {
    const [x,y,r,b]=box, w=(r-x)/MM, h=(b-y)/MM;
    if(!(w>0&&h>0))return "";
    const boundary=[(x-pageBounds[0])/MM,(y-pageBounds[1])/MM,w,h].map(fmt).join(" ");
    const modified=(info.modified||new Date().toISOString()).slice(0,10);
    return `<ofd:Annot ID="${this.pkg.next()}" Type="${type}"${info.subtype?` Subtype="PDF:${esc(info.subtype)}"`:""} Creator="${esc(info.creator)}" LastModDate="${modified}" Visible="${!(info.flags&(1|2|32))}" Print="false" ReadOnly="${!!(info.flags&(64|128|512))}" NoZoom="${!!(info.flags&8)}" NoRotate="${!!(info.flags&16)}">${info.contents?`<ofd:Remark>${esc(info.contents)}</ofd:Remark>`:""}<ofd:Appearance Boundary="${boundary}">${objects}${this.actionObject(actions,w,h)}</ofd:Appearance></ofd:Annot>`;
  }
  finish() {
    this.read("文档导航结构",()=>scope((get,keep)=>{
      const root=get(keep(this.pdf.getTrailer()),"Root");
      const seen=new Set();
      const outlines=(first,depth=0)=>{
        if(depth>64){this.warn("PDF 大纲嵌套超过 64 层，未迁移过深分支。");return "";}
        const result=[];
        for(let node=first;!node.isNull();node=get(node,"Next")) {
          this.limit();const id=node.asIndirect();if(id&&seen.has(id)){this.warn("PDF 大纲包含循环，已停止重复节点。");break;}if(id)seen.add(id);
          const actions=this.read("大纲跳转",()=>this.target(node,get,keep)), children=this.read("大纲分支",()=>outlines(get(node,"First"),depth+1));
          result.push(`<ofd:OutlineElem Title="${esc(get(node,"Title").asString())}" Expanded="${get(node,"Count").asNumber()>=0}">${actions?`<ofd:Actions>${actions}</ofd:Actions>`:""}${children}</ofd:OutlineElem>`);
        }
        return result.join("");
      };
      const outline=this.read("大纲",()=>outlines(get(root,"Outlines","First")));
      const bookmarks=[];
      for(const [name,ref] of this.namedDests) {
        const dest=this.read(`书签 ${name}`,()=>{this.limit();return this.destination(ref,get,keep);});
        if(dest)bookmarks.push(`<ofd:Bookmark Name="${esc(name)}">${dest}</ofd:Bookmark>`);
      }
      const open=get(root,"OpenAction");
      const dest=this.read("打开目标",()=>open.isArray()||open.isString()||open.isName()?this.destination(open,get,keep):"");
      const actions=dest?`<ofd:Action Event="DO"><ofd:Goto>${dest}</ofd:Goto></ofd:Action>`:this.read("打开动作",()=>this.actions(open,get,keep,"DO"));
      const mode={UseNone:"None",UseOutlines:"UseOutlines",UseThumbs:"UseThumbs",FullScreen:"FullScreen",UseAttachments:"UseAttatchs"}[get(root,"PageMode").asName()];
      const layout={SinglePage:"OnePage",OneColumn:"OneColumn",TwoColumnLeft:"TwoColumnL",TwoColumnRight:"TwoColumnR",TwoPageLeft:"TwoPageL",TwoPageRight:"TwoPageR"}[get(root,"PageLayout").asName()];
      const preferences=get(root,"ViewerPreferences"),view=[];
      if(mode)view.push(`<ofd:PageMode>${mode}</ofd:PageMode>`);
      if(layout)view.push(`<ofd:PageLayout>${layout}</ofd:PageLayout>`);
      const title=get(preferences,"DisplayDocTitle");
      if(title.isBoolean())view.push(`<ofd:TabDisplay>${title.asBoolean()?"DocTitle":"FileName"}</ofd:TabDisplay>`);
      for(const key of ["HideToolbar","HideMenubar","HideWindowUI"]) {
        const value=get(preferences,key);
        if(value.isBoolean())view.push(`<ofd:${key}>${value.asBoolean()}</ofd:${key}>`);
      }
      this.pkg.documentExtras=(outline?`<ofd:Outlines>${outline}</ofd:Outlines>`:"")+(actions?`<ofd:Actions>${actions}</ofd:Actions>`:"")+
        (view.length?`<ofd:VPreferences>${view.join("")}</ofd:VPreferences>`:"")+
        (bookmarks.length?`<ofd:Bookmarks>${bookmarks.join("")}</ofd:Bookmarks>`:"");
    }));
    if(this.annotationPages.length) {
      this.pkg.add("Doc_0/Annotations.xml",xml(`<ofd:Annotations xmlns:ofd="${NS}">${this.annotationPages.join("")}</ofd:Annotations>`));
      this.pkg.documentExtras+="<ofd:Annotations>Annotations.xml</ofd:Annotations>";
    }
    if(this.attachments.length) {
      this.pkg.add("Doc_0/Attachments.xml",xml(`<ofd:Attachments xmlns:ofd="${NS}">${this.attachments.map(a=>a.xml).join("")}</ofd:Attachments>`));
      this.pkg.documentExtras+="<ofd:Attachments>Attachments.xml</ofd:Attachments>";
    }
    for(const [pdfKey,ofdKey] of [["Title","Title"],["Author","Author"],["Subject","Subject"]]) {
      const value=this.read(`属性 ${pdfKey}`,()=>this.pdf.getMetaData(`info:${pdfKey}`));if(value)this.pkg.docInfo+=`<ofd:${ofdKey}>${esc(value)}</ofd:${ofdKey}>`;
    }
  }
}
