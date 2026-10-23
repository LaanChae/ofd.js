import { readOfficial, editOfficial, pageOfficialObjects } from "./official-document.js";
import { readMetadata, editMetadata } from "./metadata-edit.js";
import { readExtensions, extensionFile, extensionBundle } from "./extensions.js";
import { findKeywordMatches } from "../../public/shared/stamp-keywords.js";
import { editRemark } from "./annotation-edit.js";
import { readPdfInteractions } from "./pdf-interactions.js";
import { OfdDocument } from "./document.js";
import { Archive } from './archive.js';
import { FontStore, DocumentFonts, matchLocalFonts } from "./fonts.js";
import { ofdToPdf } from "./render.js";
import { DirectDocument } from "./direct-document.js";
import { pdfToOfd } from "./pdf-to-ofd.js";
import { loadBundledFonts } from "./bundled-fonts.js";

const store = new FontStore();
let document,
  choices = {},
  preview;
let localFonts = [], requestedFonts = new Set(), fontSerial = 0;
const fontRequests = new Map();
const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));
async function prepareFonts() {
  const revision = store.revision;
  await loadBundledFonts(document, store, choices, document.referencedFonts);
  const probe = new DocumentFonts(document, store, choices);
  const indexes = matchLocalFonts(probe.usages.filter(f => document.referencedFonts.has(f.id)), localFonts)
    .filter(index => !requestedFonts.has(index));
  probe.destroy();
  if (indexes.length) {
    indexes.forEach(index => requestedFonts.add(index));
    const request = ++fontSerial;
    const response = new Promise(resolve => fontRequests.set(request, resolve));
    self.postMessage({ fontRequest: request, indexes });
    for (const item of await response) {
      try {
        if (item.error) throw Error(item.error);
        store.import(item.bytes);
      } catch (error) { document.warnings.add(`本机字体：${error.message}`); }
    }
  }
  if (store.revision !== revision) {
    preview?.destroy();
    preview = new DirectDocument(document, store, choices);
  }
  preview.renderer.fonts.sync();
}
async function prepareAllPages() {
  for (let index = 0; index < document.pages.length; index++) {
    document.page(index);
    // Yield between pages so closing/replacing a worker remains responsive.
    await yieldTask();
  }
  await prepareFonts();
}
let queue = Promise.resolve();
const pendingRenders = new Map();
self.onmessage = ({ data }) => {
  if (data.cancelRender) {
    pendingRenders.get(data.cancelRender)?.abort();
    return;
  }
  if (data.fontResponse) {
    fontRequests.get(data.fontResponse)?.(data.fonts);
    fontRequests.delete(data.fontResponse);
    return;
  }
  const controller = data.method === "renderPage" ? new AbortController() : null;
  if (controller) pendingRenders.set(data.id, controller);
  queue = queue.then(async () => {
    try {
      // Process cancellation messages before starting another expensive draw.
      if (controller) await yieldTask();
      if (!controller?.signal.aborted) await handle(data, controller?.signal);
    } finally { pendingRenders.delete(data.id); }
  });
};
async function handle({ id, method, args }, signal) {
  try {
    const progress = (page, pages) =>
      self.postMessage({ id, progress: { page, pages } });
    let result;
    switch (method) {
      case "open": {
        const archive=new Archive(new Uint8Array(args.bytes));
        if(archive.has('Encryptions.xml')) {result={encrypted:true};break;}
        document = new OfdDocument(archive, args.selection);
        document.readOnly=!!args.readOnly;
        choices = {};
        localFonts = args.localFonts || [];
        requestedFonts = new Set();
        preview?.destroy();
        preview = new DirectDocument(document, store, choices);
        result = preview.metadata();
        break;
      }
      case "selectDocument": {
        if(document.readOnly)throw Error('公开内容只读视图不能切换包内文档，请重新打开原加密文件。');
        const nextDocument = new OfdDocument(document.archive, args.selection);
        const next = new DirectDocument(nextDocument, store);
        result = next.metadata();
        preview.destroy();
        preview = next;
        document = nextDocument;
        choices = {};
        break;
      }
      case "editOfficial":
      case "editMetadata":
      case "editRemark": {
        if(document.readOnly)throw Error('公开内容只读视图不能修改，请先解锁完整文档。');
        const bytes = method === "editOfficial" ? editOfficial(document, args) : method === "editMetadata" ? editMetadata(document,args) : editRemark(document, args.pageIndex, args.id, args.value);
        const nextDocument = new OfdDocument(bytes, document.selection);
        const nextPreview = new DirectDocument(nextDocument, store, choices);
        const metadata = nextPreview.metadata();
        preview.destroy(); preview = nextPreview; document = nextDocument;
        result = { ...metadata, bytes };
        break;
      }
      case "official":
        result = readOfficial(document);
        break;
      case "metadata":
        result = readMetadata(document);
        break;
      case "extensions":
        result = readExtensions(document);
        break;
      case "extensionFile":
        result = extensionFile(document,args.entryIndex,args.valueIndex);
        break;
      case "extensionBundle":
        result = extensionBundle(document);
        break;
      case "officialObjects": {
        document.page(args.index); await prepareFonts();
        const objects = pageOfficialObjects(document,args.index), content = preview.textContent(args.index,true);
        const found = new Map();
        for(const item of content.items) {
          const object = objects.get(item.sourceId);
          if(!object || object.duplicate || !item.sourceRect) continue;
          if(!found.has(item.sourceId)) found.set(item.sourceId,{pageId:document.pages[args.index].id,objectId:item.sourceId,text:object.text,rects:[]});
          found.get(item.sourceId).rects.push(item.sourceRect);
        }
        result = [...found.values()];
        break;
      }
      case "setLocalFonts":
        localFonts = args.fonts;
        requestedFonts.clear();
        result = null;
        break;
      case "pageInfo":
        document.page(args.index);
        await prepareFonts();
        result = preview.pageInfo(args.index);
        break;
      case "pageInteractions":
        result = preview.pageInteractions(args.index);
        break;
      case "destination":
        result = preview.destination(args.name);
        break;
      case "pageAreas":
        await prepareAllPages();
        result = document.pages.map((p, index) => preview.pageInfo(index));
        break;
      case "matchLocalFonts":
        result = matchLocalFonts(preview.metadata().fonts, args.fonts);
        break;
      case "fonts":
        await prepareAllPages();
        result = {
          fonts: preview.metadata().fonts,
          warnings: preview.metadata().warnings,
          options: store.options(),
        };
        break;
      case "importFont":
        store.import(new Uint8Array(args.bytes));
        result = {
          fonts: preview.metadata().fonts,
          warnings: preview.metadata().warnings,
          options: store.options(),
        };
        break;
      case "setFonts": {
        await loadBundledFonts(document, store, args.choices, document.referencedFonts);
        const nextPreview = new DirectDocument(document, store, args.choices);
        const next = nextPreview.metadata();
        preview.destroy();
        preview = nextPreview;
        choices = args.choices;
        result = next;
        break;
      }
      case "renderPage":
        document.page(args.index);
        await prepareFonts();
        if (signal.aborted) return;
        result = await preview.renderAsync(
          args.index,
          args.matrix,
          args.width,
          args.height,
          args.intent,
          signal,
        );
        break;
      case "keywordMatches": {
        document.page(args.index);
        await prepareFonts();
        result = findKeywordMatches(preview.textContent(args.index),
          preview.pageInfo(args.index).physicalBox, args.query, args.ignoreWhitespace);
        break;
      }
      case "textContent":
        document.page(args.index);
        await prepareFonts();
        result = preview.textContent(args.index);
        break;
      case "attachments":
        result = preview.attachments();
        break;
      case "attachmentContent":
        result = preview.attachmentContent(args.id);
        break;
      case "exportPdf":
        await prepareAllPages();
        result = ofdToPdf(document, store, choices, progress, args.options);
        break;
      case "pdfInteractions":
        result = readPdfInteractions(new Uint8Array(args.bytes), args.password);
        break;
      case "pdfToOfd":
        result = pdfToOfd(new Uint8Array(args.bytes), args.options, progress);
        break;
      default:
        throw new Error("未知引擎请求。");
    }
    // Transfer page pixels; document resources and text caches remain in the worker.
    self.postMessage(
      { id, result },
      result?.pixels ? [result.pixels.buffer] : [],
    );
  } catch (error) {
    self.postMessage({ id, error: error.message || String(error) });
  }
}

// WASM initializes asynchronously; the client queues requests until this handshake.
self.postMessage({ ready: true });
