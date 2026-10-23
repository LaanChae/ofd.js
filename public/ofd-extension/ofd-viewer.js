import {
  PageViewport,
  AnnotationStorage,
  DOMFilterFactory,
  PagesMapper,
  RenderingCancelledException,
  PermissionFlag,
  Util,
} from "../pdfjs/build/pdf.mjs";

// A document/page provider for the bundled PDF.js viewer. OFD pages are never
// passed to getDocument: the worker supplies pixels and logical text directly.
export class OfdViewerDocument {
  constructor(engine, metadata, original, filename, fingerprint) {
    this.isOFD = true;
    this.engine = engine;
    this.metadata = metadata;
    this.original = original;
    this.filename = filename;
    this.numPages = metadata.pages;
    this.fingerprints = [fingerprint, null];
    this.loadingParams = { disableAutoFetch: true, enableXfa: false };
    this.annotationStorage = new AnnotationStorage();
    this.filterFactory = new DOMFilterFactory({ docId: `ofd_${fingerprint}` });
    this.pagesMapper = new PagesMapper();
    this.pagesMapper.pagesNumber = this.numPages;
    this.pages = new Map();
    this.pageRequests = new Map();
    this.interactionRequests = new Map();
    this.interactions = { pages: [] };
    this.isPureXfa = false;
    this.loadingTask = { destroy: () => this.destroy() };
  }
  async getPage(number) {
    if (!Number.isInteger(number) || number < 1 || number > this.numPages)
      throw new Error("页码超出范围。");
    if (this.destroyed) throw Error("文档已关闭。");
    if (!this.pageRequests.has(number)) {
      const request = this.engine.call("pageInfo", { index: number - 1 }).then(info => {
        if (this.destroyed) throw Error("文档已关闭。");
        this.updateInfo(info);
        const page = new OfdViewerPage(this, number, info);
        this.pages.set(number, page);
        return page;
      });
      this.pageRequests.set(number, request);
    }
    return this.pageRequests.get(number);
  }
  updateInfo(info) {
    this.metadata.fonts = info.fonts;
    this.metadata.warnings = [...new Set([...(this.metadata.warnings || []), ...info.warnings])];
    this.onPageInfo?.(info);
  }
  async getMetadata() {
    return {
      info: {
        Title: this.metadata.properties?.docInfo?.Title || "",
        PDFFormatVersion: "OFD",
        Producer: "OFD 直接渲染",
        Creator: "",
        IsAcroFormPresent: false,
        IsXFAPresent: false,
      },
      metadata: null,
      contentDispositionFilename: this.filename,
      contentLength: this.original.length,
      hasStructTree: false,
    };
  }
  async getDownloadInfo() {
    return { length: this.original.length };
  }
  async getData() {
    return this.original;
  }
  async getPermissions() {
    return new Set([
      PermissionFlag.PRINT,
      PermissionFlag.PRINT_HIGH_QUALITY,
      PermissionFlag.COPY,
      PermissionFlag.COPY_FOR_ACCESSIBILITY,
    ]);
  }
  async getOptionalContentConfig() {
    return {
      hasInitialVisibility: true,
      getOrder: () => null,
      getGroups: () => null,
    };
  }
  async getPageLayout() {
    return this.metadata.navigation?.pageLayout || "OneColumn";
  }
  async getPageMode() {
    return this.metadata.navigation?.pageMode || "UseNone";
  }
  async getViewerPreferences() {
    const preferences = this.metadata.navigation?.viewerPreferences;
    return preferences ? new Map(Object.entries(preferences)) : null;
  }
  async getOpenAction() {
    return this.metadata.navigation?.openAction?.dest
      ? new Map([["dest", this.metadata.navigation.openAction.dest]]) : null;
  }
  async getOutline() {
    return this.metadata.navigation?.outlines?.length
      ? this.metadata.navigation.outlines : null;
  }
  async getAttachments() {
    const entries = await (this.attachmentsPromise ??=
      this.engine.call("attachments"));
    return entries ? new Map(Object.entries(entries)) : null;
  }
  async getAttachmentContent(id) {
    return this.engine.call("attachmentContent",{id});
  }
  async getPageLabels() {
    return null;
  }
  async getMarkInfo() {
    return null;
  }
  async getFieldObjects() {
    return null;
  }
  async hasJSActions() {
    return false;
  }
  async getJSActions() {
    return null;
  }
  async getDestination(name) {
    return this.engine.call("destination", { name });
  }
  async getPageInteractions(index) {
    if (this.destroyed) throw Error("文档已关闭。");
    if (!this.interactionRequests.has(index)) {
      const request = this.engine.call("pageInteractions", { index }).then(result => {
        if (this.destroyed) throw Error("文档已关闭。");
        this.interactions.pages[index] = result;
        return result;
      });
      this.interactionRequests.set(index, request);
    }
    return this.interactionRequests.get(index);
  }
  async getAnnotationsByType(types, pageIndexesToSkip) {
    const result = [];
    for (let index = 0; index < this.numPages; index++) {
      if (pageIndexesToSkip?.has(index)) continue;
      const page = await this.getPageInteractions(index);
      result.push(...page.annotations.filter(a => !types || types.has(a.annotationType)));
    }
    return result;
  }
  async preparePrint(viewer, progress = () => {}) {
    for (let index = 0; index < this.numPages; index++) {
      const page = await this.getPage(index + 1);
      if (this.destroyed || viewer.pdfDocument !== this) throw Error("文档已关闭。");
      const view = viewer.getPageView(index);
      if (!view.pdfPage) view.setPdfPage(page);
      progress(index + 1, this.numPages);
    }
  }
  cleanup() {
    for (const page of this.pages.values()) page.cleanup();
  }
  async destroy() {
    this.destroyed = true;
    this.cleanup();
    this.pages.clear();
    this.pageRequests.clear();
    this.interactionRequests.clear();
    this.filterFactory.destroy();
  }
}

class OfdViewerPage {
  constructor(doc, number, info) {
    this.doc = doc;
    this.pageNumber = number;
    this.index = number - 1;
    this.info = info;
    this.view = info.view;
    this.rotate = 0;
    this.userUnit = 1;
    this.ref = { num: number, gen: 0 };
    this.filterFactory = doc.filterFactory;
    this.isPureXfa = false;
    this.tasks = new Set();
  }
  getViewport({
    scale,
    rotation = this.rotate,
    offsetX = 0,
    offsetY = 0,
    dontFlip = false,
  }) {
    return new PageViewport({
      viewBox: this.view,
      userUnit: 1,
      scale,
      rotation,
      offsetX,
      offsetY,
      dontFlip,
    });
  }
  getTextLayerViewport(container, viewport) {
    // Layout selectable glyphs once in page coordinates. Scaling/rotation then
    // changes one container transform, not thousands of glyph layout boxes.
    if (!container.classList.contains("ofdTextLayer")) container.classList.add("ofdTextLayer");
    const matrix = Util.transform(viewport.transform, [1, 0, 0, -1, 0, this.view[3]]);
    container.style.transform = `matrix(${matrix.join(",")})`;
    return viewport.clone({ scale: 1, rotation: 0, offsetX: 0, offsetY: 0 });
  }
  render({ canvas, canvasContext, viewport, transform = null, intent = "display" }) {
    const controller = new AbortController();
    let cancelled = false,
      rejectTask;
    const ctx = canvasContext || canvas.getContext("2d"),
      target = canvas || ctx.canvas;
    const task = {
      separateAnnots: false,
      cancel: (extraDelay = 0) => {
        if (cancelled) return;
        cancelled = true;
        const error = new RenderingCancelledException(
          "OFD page rendering cancelled",
          extraDelay,
        );
        controller.abort(error);
        task.onError?.(error);
        rejectTask?.(error);
      },
    };
    task.promise = new Promise((resolve, reject) => {
      rejectTask = reject;
      queueMicrotask(() => {
        // PDF.js may cancel and zero the canvas before this microtask runs.
        // Never invoke its continuation hook against a destroyed page view.
        if (cancelled) return;
        const run = async () => {
          if (cancelled) return;
          try {
            // OFD uses a downward y-axis; PageViewport maps PDF's upward axis.
            let matrix = Util.transform(viewport.transform, [
              1,
              0,
              0,
              -1,
              0,
              this.view[3],
            ]);
            if (transform) matrix = Util.transform(transform, matrix);
            const result = await this.doc.engine.call("renderPage", {
              index: this.index,
              matrix,
              width: target.width,
              height: target.height,
              intent,
            }, { signal: controller.signal });
            if (cancelled) return;
            this.doc.updateInfo(result);
            // The worker transfers this buffer; ImageData can use it directly.
            ctx.putImageData(new ImageData(result.pixels, result.width, result.height), 0, 0);
            resolve();
          } catch (error) {
            if (!cancelled) {
              task.onError?.(error);
              reject(error);
            }
          }
        };
        try {
          if (task.onContinue) task.onContinue(run);
          else run();
        } catch (error) {
          task.onError?.(error);
          reject(error);
        }
      });
    });
    this.tasks.add(task);
    task.promise.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
    return task;
  }
  getTextContent() {
    return this.doc.engine.call("textContent", { index: this.index });
  }
  streamTextContent() {
    const page = this;
    return new ReadableStream({
      async start(controller) {
        try {
          controller.enqueue(await page.getTextContent());
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
  }
  async getAnnotations() {
    return (await this.doc.getPageInteractions(this.index)).annotations;
  }
  async getStructTree() {
    return null;
  }
  async getXfa() {
    return null;
  }
  cleanup() {
    for (const task of this.tasks) task.cancel();
  }
}

export async function openOfdViewer(app, engine, metadata, original, filename) {
  const digest = await crypto.subtle.digest("SHA-256", original),
    fingerprint = Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
  const doc = new OfdViewerDocument(
    engine,
    metadata,
    original,
    filename,
    `${fingerprint}-${metadata.selection?.documentIndex ?? 0}-${encodeURIComponent(metadata.selection?.versionId || "main")}`,
  );
  doc.onPageInfo = (info) =>
    app.eventBus.dispatch("ofdpageinfo", { source: doc, info });
  app.setTitleUsingUrl(filename, filename);
  app.pdfLoadingTask = doc.loadingTask;
  app.load(doc);
  await app.pdfViewer.firstPagePromise;
  app.eventBus.dispatch("ofdinteractions", { source: doc, metadata: { navigation: metadata.navigation, interactions: doc.interactions } });
  return doc;
}

// OFD appearances are already painted. Transparent PDF.js Stamp hit areas
// must not intercept native text selection (notably migrated highlights).
// Forward a click/hover to the existing popup, but leave dragging to textLayer.
export function mountOfdAnnotationSelection(app) {
  const viewer=app.pdfViewer.container;
  let hovered=null, down=null;
  function hit(event) {
    if(!app.pdfDocument?.isOFD || event.target.closest(".annotationLayer"))return null;
    const page=event.target.closest(".page");if(!page)return null;
    const nodes=page.querySelectorAll('.stampAnnotation.popupTriggerArea[data-annotation-id^="ofd-annot-"]');
    for(let i=nodes.length-1;i>=0;i--) {
      const node=nodes[i],r=node.getBoundingClientRect();
      if(event.clientX>=r.left&&event.clientX<=r.right&&event.clientY>=r.top&&event.clientY<=r.bottom)return node;
    }
    return null;
  }
  function hover(node) {
    if(node===hovered)return;
    hovered?.dispatchEvent(new PointerEvent("pointerleave"));hovered=node;
    hovered?.dispatchEvent(new PointerEvent("pointerenter"));
  }
  viewer.addEventListener("pointermove",event=>hover(event.buttons?null:hit(event)));
  viewer.addEventListener("pointerleave",()=>hover(null));
  viewer.addEventListener("pointerdown",event=>{
    down=event.button===0?{x:event.clientX,y:event.clientY,node:hit(event)}:null;
    hover(null);
  });
  viewer.addEventListener("pointercancel",()=>{down=null;});
  viewer.addEventListener("click",event=>{
    const start=down;down=null;
    if(start?.node && start.node===hit(event) && Math.hypot(event.clientX-start.x,event.clientY-start.y)<4 && getSelection()?.isCollapsed)
      start.node.click();
  });
}

// PDF.js requires all actual page sizes before creating its native print job.
// Loading them here keeps normal reading lazy without substituting page sizes.
export function mountOfdPrinting(app, report) {
  const print = window.print;
  let preparing;
  window.print = async function () {
    const owner = app.pdfDocument;
    if (!owner?.isOFD) return print.call(window);
    if (preparing === owner) return;
    preparing = owner;
    try {
      await owner.preparePrint(app.pdfViewer, (page, pages) => report(`正在准备打印 ${page} / ${pages} 页…`));
      if (app.pdfDocument !== owner) return;
      report("打印页面已准备完成。");
      print.call(window);
    } catch (error) {
      if (app.pdfDocument === owner) report(`打印准备失败：${error.message}`, true);
    } finally { if (preparing === owner) preparing = null; }
  };
}
