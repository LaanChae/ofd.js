import { nativeDialog, line } from "./dialogs.js";

export async function mountAnnotations(app,getCurrent,save) {
  const dialog=document.createElement("dialog");dialog.id="ofdAnnotationsDialog";dialog.setAttribute("aria-label","OFD 注释备注");
  line(dialog,"OFD 注释备注","h2");
  const label=line(dialog,"选择注释","label"),list=document.createElement("select");list.id="ofdAnnotationList";label.htmlFor=list.id;dialog.append(list);
  const info=line(dialog,"","p","ofdMuted"), textLabel=line(dialog,"备注","label"),input=document.createElement("textarea");
  input.id="ofdAnnotationRemark";input.className="toolbarField";input.rows=6;input.maxLength=10000;textLabel.htmlFor=input.id;dialog.append(input);
  const message=line(dialog,"","p","ofdMuted");message.setAttribute("role","status");
  const row=document.createElement("div");row.className="buttonRow";
  const close=document.createElement("button"),apply=document.createElement("button");close.textContent="关闭";apply.textContent="保存备注";apply.id="ofdAnnotationSave";
  row.append(close,apply);dialog.append(row);document.body.append(dialog);nativeDialog(dialog,[apply.id]);await app.overlayManager.register(dialog);
  let annotations=[];
  const type = a => ({Link:"链接",Path:"路径",Highlight:"高亮",Stamp:"印章",Watermark:"水印"}[a.ofdType] || a.ofdType);
  function update() {
    const a=annotations[Number(list.value)];
    input.value=a?.contentsObj.str||"";input.disabled=!a;input.readOnly=!!(a?.readOnly||a?.editBlocked);apply.disabled=!a||input.readOnly;
    info.textContent=a?`第 ${a.pageIndex+1} 页 · ${type(a)} · ${a.titleObj.str} · ${a.readOnly?"只读":"可编辑"} · ${a.print?"打印备注":"不打印备注"}`:"当前文档没有可见注释。";
    message.textContent=a?.editBlocked||"修改备注不会改变注释的静态外观；签名保护的注释不可更改。";
  }
  list.onchange=update;close.onclick=()=>app.overlayManager.close(dialog);
  apply.onclick=async()=>{
    const a=annotations[Number(list.value)];if(!a)return;
    apply.disabled=true;
    try {await save({pageIndex:a.pageIndex,id:a.ofdId,value:input.value});await app.overlayManager.close(dialog);}
    catch(error){message.textContent=error.message;apply.disabled=false;}
  };
  document.getElementById("ofdAnnotations").onclick=async()=>{
    const current=getCurrent();if(current?.type!=="ofd")return;
    const owner = app.pdfDocument;
    try { annotations=(await owner.getAnnotationsByType(new Set([13]))).filter(a=>a.ofdId); }
    catch(error) { if (app.pdfDocument !== owner) return; message.textContent=error.message; await app.overlayManager.open(dialog); return; }
    if (app.pdfDocument !== owner) return;
    list.replaceChildren(...annotations.map((a,i)=>{const option=document.createElement("option");option.value=i;option.textContent=`第 ${a.pageIndex+1} 页 · ${type(a)} ${a.ofdId}`;return option;}));
    update();await app.overlayManager.open(dialog);
  };
}
