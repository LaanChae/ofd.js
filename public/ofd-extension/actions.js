import { nativeDialog, line } from "./dialogs.js";

export async function mountActions(app, report, openAttachment) {
  let active=null, lastPage=0;
  const dialog=document.createElement("dialog");dialog.id="ofdActionDialog";
  line(dialog,"文档动作","h2");const description=line(dialog,"");
  const row=document.createElement("div");row.className="buttonRow";
  const cancel=document.createElement("button"),accept=document.createElement("button");
  cancel.textContent="取消";accept.textContent="继续";accept.id="ofdActionAccept";
  row.append(cancel,accept);dialog.append(row);document.body.append(dialog);nativeDialog(dialog,[accept.id]);await app.overlayManager.register(dialog);
  let pending=null;
  cancel.onclick=()=>{pending=null;app.overlayManager.close(dialog);};
  accept.onclick=()=>{const p=pending;pending=null;app.overlayManager.close(dialog);if(p)run(p,true);};
  async function run(actions,gesture=false) {
    const owner=active;if(!owner||owner.running||!actions?.length)return;
    owner.running=true;
    try {
      for(let i=0;i<actions.length;i++) {
        if(active!==owner||app.pdfDocument!==owner.document)return;
        const action=actions[i];
        if(!gesture&&!action.dest) {
          description.textContent=action.url?`此文档请求打开：${action.url}`:`此文档请求打开附件：${action.attachment.filename}`;
          pending=actions.slice(i);await app.overlayManager.open(dialog);return;
        }
        if(action.dest)await app.pdfLinkService.goToDestination(action.dest);
        else if(action.url) {
          const link=document.createElement("a");app.pdfLinkService.addLinkAttributes(link,action.url,true);link.click();
        } else if(action.attachment) {
          const {filename,annotation}=action.attachment;
          let id=action.attachment.id;
          if(annotation) {
            const page=await owner.document.getPage(annotation.page+1),
              annotations=await page.getAnnotations({intent:"any"});
            id=annotations.find(item=>item.id===annotation.id)?.fileId;
            if(!id)throw Error("找不到动作引用的附件注释。");
          }
          const content=await owner.document.getAttachmentContent(id);
          if(active!==owner||app.pdfDocument!==owner.document)return;
          if(!content)throw Error("附件未指定可读取的内容。");
          if (!action.attachment.newWindow && /\.(pdf|ofd)$/i.test(filename))
            await openAttachment(new File([content],filename));
          else app.downloadManager.openOrDownloadData(content,filename);
        }
      }
    } catch(error) {if(active===owner&&app.pdfDocument===owner.document)report(`文档动作：${error.message}`,true);}
    finally {owner.running=false;if(active===owner)lastPage=app.page;}
  }
  // Capture before PDF.js's single-action handler to avoid executing the first
  // link twice. Native link markup, focus, accessibility and theme are retained.
  document.addEventListener("click",event=>{
    if(!active||app.pdfDocument!==active.document)return;
    const outline=event.target.closest("#outlinesView .treeItem > a");
    if(outline) {
      const walk=items=>items.flatMap(item=>[item,...walk(item.items||[])]),
        index=[...document.querySelectorAll("#outlinesView .treeItem > a")].indexOf(outline),
        item=walk(active.navigation.outlines||[])[index];
      if(!item?.actions?.length)return;
      event.preventDefault();event.stopImmediatePropagation();run(item.actions,true);return;
    }
    const anchor=event.target.closest("a[data-element-id]");
    if(!anchor)return;
    const annotation=active.interactions.pages.flatMap(p=>p?.annotations || []).find(a=>a.id===anchor.dataset.elementId);
    if(!annotation?.actions?.length)return;
    event.preventDefault();event.stopImmediatePropagation();run(annotation.actions,true);
  },true);
  async function pageOpened(pageNumber) {
    const owner = active;
    if (!owner || app.pdfDocument !== owner.document) return;
    try {
      const page = owner.document.isOFD
        ? await owner.document.getPageInteractions(pageNumber - 1)
        : owner.interactions.pages[pageNumber - 1];
      if (active === owner && app.pdfDocument === owner.document && app.page === pageNumber)
        await run(page?.openAction);
    } catch (error) {
      if (active === owner && app.pdfDocument === owner.document) report(`页面动作：${error.message}`, true);
    }
  }
  app.eventBus.on("pagechanging",({pageNumber})=>{
    if(!active||active.running||app.pdfDocument!==active.document||pageNumber===lastPage)return;
    lastPage=pageNumber;void pageOpened(pageNumber);
  });
  async function setDocument(document,model) {
    if(app.pdfDocument!==document)return;
    pending=null;if(dialog.open)await app.overlayManager.close(dialog);
    if(app.pdfDocument!==document)return;
    active={document,...model,running:false};lastPage=app.page;
    await run(model.navigation?.openAction?.actions);
    if(active?.document===document)await pageOpened(app.page);
  }
  app.eventBus.on("ofdinteractions",({source,metadata})=>setDocument(source,metadata));
  app.eventBus.on("pagesdestroy",()=>{active=null;pending=null;app.overlayManager.closeIfActive(dialog);});
  return {setDocument};
}
