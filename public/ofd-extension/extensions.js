import { nativeDialog, line } from "./dialogs.js";

export async function mountExtensions(app,download,report) {
  const dialog=document.createElement("dialog");dialog.id="ofdExtensionsDialog";
  dialog.setAttribute("aria-label","扩展信息");
  line(dialog,"扩展信息","h2");
  const label=line(dialog,"扩展应用","label"),select=document.createElement("select");
  select.id="ofdExtensionsSelect";label.htmlFor=select.id;dialog.append(select);
  const fields=line(dialog,"","div","ofdFields"),values=line(dialog,"","div"),
    feedback=line(dialog,"","p","ofdMuted"),buttons=line(dialog,"","div","buttonRow"),
    bundle=line(buttons,"下载扩展数据包","button"),close=line(buttons,"关闭","button");
  bundle.id="ofdExtensionsDownload";
  document.body.append(dialog);nativeDialog(dialog);await app.overlayManager.register(dialog);
  let owner=null,model=null,serial=0;
  const row=(label,value)=>{
    const row=line(fields,"","div","row");line(row,`${label}：`,"span");line(row,value||"—","p");
  };
  const transfer=async(method,args)=>{
    const doc=owner;if(!doc||doc!==app.pdfDocument)return;
    try {
      const result=await doc.engine.call(method,args);
      if(doc!==owner||doc!==app.pdfDocument||!result)return;
      download(result.bytes,result.filename,method==="extensionBundle"?"application/zip":"application/octet-stream");
    } catch(error) {if(doc===owner){feedback.textContent=error.message;report(`扩展信息：${error.message}`,true);}}
  };
  function paint() {
    fields.replaceChildren();values.replaceChildren();
    const entry=model?.entries[Number(select.value)];
    if(!entry)return;
    row("应用名称",entry.appName);row("厂商",entry.company);row("应用版本",entry.appVersion);
    row("创建时间",entry.date);row("关联项目 ID",entry.refId);row("注册文件",model.file);
    for(const [index,value] of entry.values.entries()) {
      const section=document.createElement("details");section.open=value.kind!=="data";
      line(section,value.kind==="property"?`${value.name||"未命名属性"}${value.type?`（${value.type}）`:""}`:value.kind==="data"?"内联 XML 数据":"外部扩展数据","summary");
      if(value.kind==="file") {
        line(section,value.location,"p");
        if(value.error)line(section,value.error,"p","ofdError");
        const button=line(section,"下载数据文件","button");button.className="secondaryButton";button.disabled=!!value.error;
        button.onclick=()=>transfer("extensionFile",{entryIndex:entry.index,valueIndex:index});
      } else {
        const content=line(section,value.kind==="data"?value.xml:value.value,"pre");
        content.tabIndex=0;
      }
      values.append(section);
    }
  }
  select.onchange=paint;close.onclick=()=>app.overlayManager.close(dialog);
  bundle.onclick=()=>transfer("extensionBundle");
  document.getElementById("ofdExtensions").onclick=async()=>{
    const doc=app.pdfDocument,request=++serial;if(!doc?.isOFD)return;
    try {
      const data=await doc.engine.call("extensions");
      if(request!==serial||app.pdfDocument!==doc)return;
      owner=doc;model=data;select.replaceChildren();fields.replaceChildren();values.replaceChildren();
      for(const entry of model.entries) {
        const option=document.createElement("option");option.value=entry.index;
        option.textContent=`${entry.index+1}. ${entry.appName||"未命名应用"} · ID ${entry.refId||"—"}`;select.append(option);
      }
      select.disabled=!model.entries.length;bundle.disabled=!model.file||!!model.error;
      feedback.textContent=model.error || (model.entries.length?"扩展数据的含义由对应应用定义。下载的数据包保留注册 XML 和外部数据的原始内容。":"当前文档没有扩展信息条目。");
      paint();await app.overlayManager.open(dialog);
    } catch(error) {if(request===serial)report(`扩展信息：${error.message}`,true);}
  };
  app.eventBus.on("pagesdestroy",()=>{++serial;owner=null;model=null;app.overlayManager.closeIfActive(dialog);});
}
