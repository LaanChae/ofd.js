// Apply document preferences to the existing PDF.js controls for both formats.
// Browser chrome is owned by the host; only reader UI can be hidden here.
export function mountViewPreferences(app, report) {
  const root=document.documentElement, classes=["documentHideToolbar","documentHideMenubar","documentHideWindowUI"];
  let dismissed=null;
  const restore=(notify=true)=>{
    root.classList.remove(...classes);
    if(notify)app.eventBus.dispatch("resize",{source:app});
  };
  async function apply(titleOnly=false) {
    const owner=app.pdfDocument;
    if(!owner)return;
    try {
      const preferences=await owner.getViewerPreferences();
      if(app.pdfDocument!==owner||!preferences)return;
      if(titleOnly && preferences.has("DisplayDocTitle")) {
        const metadata=await owner.getMetadata();
        if(app.pdfDocument!==owner)return;
        const filename=metadata.contentDispositionFilename || app._docFilename;
        app.setTitle(preferences.get("DisplayDocTitle") && metadata.info.Title || filename);
      }
      if(!titleOnly && dismissed!==owner) {
        classes.forEach((name,i)=>root.classList.toggle(name,preferences.get(["HideToolbar","HideMenubar","HideWindowUI"][i])===true));
        if(preferences.get("HideToolbar")||preferences.get("HideMenubar"))app.secondaryToolbar.close();
        if(preferences.get("HideWindowUI"))app.viewsManager.close();
        app.eventBus.dispatch("resize",{source:app});
      }
    } catch(error) {if(app.pdfDocument===owner)report(`视图首选项：${error.message}`,true);}
  }
  app.eventBus.on("documentinit",()=>void apply());
  app.eventBus.on("metadataloaded",()=>void apply(true));
  // pagesdestroy fires before PDF.js cancels old renders. Resizing here would
  // start a new paint against canvases that are about to be destroyed.
  app.eventBus.on("pagesdestroy",()=>{dismissed=null;restore(false);});
  // Escape returns to ordinary reader controls; changing documents resets this
  // override. Do not consume Escape from dialogs or presentation mode.
  document.addEventListener("keydown",event=>{
    if(event.key!=="Escape"||event.defaultPrevented||document.querySelector("dialog[open]")||app.pdfViewer.isInPresentationMode)return;
    if(classes.some(name=>root.classList.contains(name))) {
      dismissed=app.pdfDocument;restore();
    }
  });
}
