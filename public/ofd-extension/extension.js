let actionUI;
/* Extension of the official PDF.js viewer; documents never leave this browser. */
const $ = (id) => document.getElementById(id);
let app,
  current = null,
  pdfPassword = "",
  generation = 0,
  opening = false,
  converting = false,
  engine = null,
  fontData,
  localFontCatalog = null,
  nativeDialog,
  certificateIdentity,
  certificateLabel,
  security,
  encryptionUI,
  integrityUI,
  openOfdViewer;
class Engine {
  constructor(url = "/engine/worker.js") {
    this.worker = new Worker(url, { type: "module" });
    this.pending = new Map();
    this.serial = 0;
    this.ready = false;
    this.queue = [];
    this.worker.onmessage = async ({ data }) => {
      if (data.fontRequest) {
        const fonts = await Promise.all(data.indexes.map(async index => {
          try {
            const blob = await this.localFonts[index].blob();
            return { bytes: new Uint8Array(await blob.arrayBuffer()) };
          } catch (error) { return { error: error.message }; }
        }));
        if (!this.closed) this.worker.postMessage({ fontResponse: data.fontRequest, fonts },
          fonts.filter(f => f.bytes).map(f => f.bytes.buffer));
        return;
      }
      if (data.ready) {
        this.ready = true;
        for (const message of this.queue) this.worker.postMessage(message);
        this.queue = [];
        return;
      }
      const pending = this.pending.get(data.id);
      if (!pending) return;
      if (data.progress) {
        status(`正在处理第 ${data.progress.page} / ${data.progress.pages} 页…`);
        return;
      }
      this.pending.delete(data.id);
      pending.cleanup();
      if (data.error) pending.reject(new Error(data.error));
      else pending.resolve(data.result);
    };
    this.worker.onerror = (event) => {
      this.failed = new Error(event.message || "文档引擎加载失败。");
      for (const p of this.pending.values()) { p.cleanup(); p.reject(this.failed); }
      this.pending.clear();
    };
  }
  call(method, args = {}, { signal } = {}) {
    if (this.failed) return Promise.reject(this.failed);
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      const abort = () => {
        this.pending.delete(id);
        this.queue = this.queue.filter(message => message.id !== id);
        if (this.ready) this.worker.postMessage({ cancelRender: id });
        reject(signal.reason);
      };
      const cleanup = () => signal?.removeEventListener("abort", abort);
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      const message = { id, method, args };
      if (this.ready) this.worker.postMessage(message);
      else this.queue.push(message);
    });
  }
  close() {
    this.closed = true;
    this.worker.terminate();
    for (const p of this.pending.values()) { p.cleanup(); p.reject(new Error("操作已取消。")); }
    this.pending.clear();
  }
}
function initializeOptions() {
  const options = window.PDFViewerApplicationOptions;
  options.set("defaultUrl", "");
  options.set("enableScripting", false);
  options.set("localeProperties", { lang: "zh-CN" });
}
document.addEventListener("webviewerloaded", initializeOptions, { once: true });
function status(message, error = false) {
  $("ofdStatus").textContent = message;
  $("ofdStatus").classList.toggle("error", error);
}
function controls() {
  $("ofdConvert").disabled = !current || opening || converting;
  $("ofdOriginal").disabled = !current || opening;
  if ($("ofdOriginalLabel")) $("ofdOriginalLabel").textContent = current?.modified ? (current.decrypted ? "下载未加密 OFD" : "下载当前 OFD") : "下载原文件";
  $("ofdClose").disabled = !current && !opening;
  $("ofdConvertLabel").textContent = converting
    ? "正在转换…"
    : current?.type === "ofd"
      ? "转换为 PDF"
      : "转换为 OFD";
  if ($("ofdSign")) {
    $("ofdSign").hidden = current?.type !== "ofd";
    $("ofdSign").disabled = opening || converting || !!current?.partial;
  }
  if ($("ofdCertificates")) $("ofdCertificates").disabled = false;
  if ($("ofdSeals")) $("ofdSeals").disabled = false;
  if ($("ofdVerifySignatures")) {
    $("ofdVerifySignatures").hidden = current?.type !== "ofd";
    $("ofdVerifySignatures").disabled = opening || converting || !!current?.partial;
  }
  for (const id of ["ofdEncrypt", "ofdIntegrity", "ofdPackage", "ofdAnnotations", "ofdMetadata", "ofdExtensions", "ofdOfficial", "ofdOfficialMetadata", "ofdOfficialStructure", "ofdOfficialMark"]) if ($(id)) {
    $(id).hidden = current?.type !== "ofd";
    $(id).disabled = opening || converting || !!current?.partial;
  }
  if ($("officialViewMenu")) $("officialViewMenu").hidden = current?.type !== "ofd";
  if ($("ofdFontSettings")) {
    $("ofdFontSettings").hidden = current?.type !== "ofd";
    $("ofdFontSettings").disabled = opening || converting;
  }
}
function fontNotice() {
  const count = new Set(
    (current?.fonts || []).filter((f) => f.missing).map((f) => f.name),
  ).size;
  $("ofdNotice").textContent = [
    count ? `${count} 种字体已替换` : "OFD 直接预览",
    current?.warnings?.length ? `${current.warnings.length} 项格式提示` : "",
    current?.signatureSummary || "未验证数字签名",
  ]
    .filter(Boolean)
    .join(" · ");
  $("ofdNotice").title = "点击“字体与格式”查看详情或更换字体。";
  return count;
}
async function openFile(file) {
  if (!file) return;
  if (
    !/\.(ofd|pdf)$/i.test(file.name) ||
    !file.size ||
    file.size > 100 * 1024 * 1024
  )
    return status("请选择有效的 OFD / PDF 文件，最大 100 MB。", true);
  // Start enumeration while the file-picker/drop gesture is still active.
  // Waiting for OFD loading first can outlive Chromium's transient activation.
  const catalog = /\.ofd$/i.test(file.name)
    ? authorizedLocalFonts().catch((error) => ({
        fonts: [],
        warning: `本机字体自动匹配未完成：${error.message}。请点击“字体与格式 → 读取本机字体”。`,
      }))
    : Promise.resolve({ fonts: [] });
  const token = ++generation;
  encryptionUI?.cancel();
  integrityUI?.cancel();
  pdfPassword = "";
  $("ofdFontDialog")?.close();
  $("ofdSignatureDialog")?.close();
  security?.closeDocumentDialogs();
  engine?.close();
  engine = new Engine();
  const worker = engine;
  current = null;
  opening = true;
  converting = false;
  controls();
  $("ofdWelcome").hidden = true;
  $("ofdNotice").hidden = true;
  status(`正在打开 ${file.name}…`);
  try {
    await app.close();
    let original = new Uint8Array(await file.arrayBuffer());
    let sourceOriginal=null,decrypted=false,partial=false;
    if (token !== generation) return;
    const type = /\.ofd$/i.test(file.name) ? "ofd" : "pdf";
    const local = await catalog;
    if (token !== generation) return;
    worker.localFonts = local.fonts;
    let result = type === "ofd"
      ? await worker.call("open", { bytes: original, localFonts: fontDescriptions(local.fonts) })
      : { bytes: original, fonts: [], warnings: [] };
    if(result.encrypted) {
      const unlocked=await encryptionUI.open(original,()=>token===generation);
      if(token!==generation)return;
      decrypted=true;partial=!!unlocked.partial;sourceOriginal=original;original=unlocked.bytes;
      result=await worker.call('open',{bytes:original,localFonts:fontDescriptions(local.fonts),readOnly:partial});
      if(partial)result.warnings.push('只读公开／已解密内容，仍有加密内容未解锁。当前视图不能编辑或验签；导出及打印仅包含可见内容。重新打开原文件可继续解密。');
    }
    if (local.warning) result.warnings.push(local.warning);
    if (token !== generation) return;
    if (type === "ofd")
      await openOfdViewer(app, worker, result, sourceOriginal||original, file.name);
    else {
      await app.open({ data: original.slice(), originalUrl: file.name });
      await app.pdfViewer.firstPagePromise;
      let interactions;
      try {
        interactions = await worker.call("pdfInteractions", { bytes: original, password: pdfPassword });
      } catch (error) {
        // PDF.js may hold a password entered in its own dialog. Failure of the
        // supplemental action inspection must not close an already readable PDF.
        result.warnings.push(`高级 PDF 动作未读取：${error.message}`);
        interactions = { navigation: {}, interactions: { pages: [] } };
      }
      if (token !== generation) return;
      await actionUI.setDocument(app.pdfDocument, interactions);
    }
    if (token !== generation) return;
    current = {
      ...result,
      type,
      name: file.name,
      original,
      sourceOriginal,
      decrypted,
      partial,
      pages: app.pdfDocument.numPages,
    };
    $("ofdNotice").hidden = type !== "ofd";
    const count = fontNotice();
    status(
      `${current.pages} 页 · ${(file.size / 1048576).toFixed(2)} MB · ${partial?'只读公开／已解密内容，原文件仍保留全部密文 · ':decrypted?'已解密，下载原文件仍保留加密 · ':''}${count ? "缺失字体已替换，可在“字体与格式”中调整" : "文件仅在浏览器内处理"}`,
    );
  } catch (error) {
    if (token !== generation) return;
    encryptionUI?.cancel();
    integrityUI?.cancel();
    current = null;
    pdfPassword = "";
    $("ofdWelcome").hidden = false;
    status(error.message || "打开失败。", true);
  } finally {
    if (token === generation) {
      opening = false;
      controls();
    }
  }
}
async function closeFile() {
  ++generation;
  encryptionUI?.cancel();
  integrityUI?.cancel();
  pdfPassword = "";
  engine?.close();
  engine = null;
  $("ofdFontDialog")?.close();
  $("ofdSignatureDialog")?.close();
  security?.closeDocumentDialogs();
  current = null;
  opening = false;
  converting = false;
  await app.close();
  $("ofdWelcome").hidden = false;
  $("ofdNotice").hidden = true;
  document.title = "OFD / PDF 阅读器";
  status("选择或拖入 OFD / PDF 文件，最大 100 MB。");
  controls();
}
function download(bytes, name, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type })),
    link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function convert() {
  if (!current || converting) return;
  $("ofdConversionNote").textContent =
    current.type === "ofd"
      ? `导出当前预览，包含已应用的字体选择。数字签名的有效性不会迁移。${current.decrypted?'导出的 PDF 不加密。':''}${current.partial?'仅导出公开／已解密内容，未解锁的内容不会包含在 PDF 中。':''}`
      : "保留文字模式支持搜索与复制；无法可靠保留的字形会单独转成图形，扫描图片不进行 OCR。渐变优先保留为矢量，复杂混合与蒙版可能局部转成图像，转换后会提示。未嵌入字体的 PDF 可能使用替代字体。三种模式均迁移书签、内嵌附件、支持的链接及注释外观和备注；不支持的动作会提示。文字转轮廓和页面图像不保留文字搜索，交互表单和原数字签名的有效性不会迁移。";
  $("ofdExportOptions").hidden = current.type !== "pdf";
  $("ofdPdfExportOptions").hidden = current.type !== "ofd";
  $("ofdConversionDialog").showModal();
}
async function confirmConversion() {
  $("ofdConversionDialog").close();
  if (!current || converting) return;
  const token = generation,
    doc = current;
  converting = true;
  controls();
  status("正在转换…");
  try {
    const result =
      doc.type === "ofd"
        ? await engine.call("exportPdf", {options:{subsetFonts:$("ofdPdfSubsetFonts").checked}})
        : await engine.call("pdfToOfd", {
            bytes: doc.original,
            options: {
              mode: $("ofdExportMode").value,
              subsetFonts:
                $("ofdExportMode").value === "text" &&
                $("ofdSubsetFonts").checked,
              dpi: Number($("ofdExportDpi").value),
              password: pdfPassword,
            },
          });
    if (token !== generation) return;
    const ext = doc.type === "ofd" ? "pdf" : "ofd";
    download(
      result.bytes,
      doc.name.replace(/\.(ofd|pdf)$/i, "." + ext),
      ext === "pdf" ? "application/pdf" : "application/ofd",
    );
    status(`转换完成 · ${result.pages} 页 · 已开始下载${result.warnings?.length ? `。${result.warnings.join("；")}` : ""}`);
    if (result.warnings?.length) {
      $("ofdConversionWarnings").replaceChildren(...result.warnings.map(warning => {
        const item = document.createElement("p");
        item.textContent = warning;
        return item;
      }));
      $("ofdConversionResultDialog").showModal();
    }
  } catch (error) {
    if (token === generation) status(error.message, true);
  } finally {
    if (token === generation) {
      converting = false;
      controls();
    }
  }
}
function closeFileMenu() {
  app.secondaryToolbar.close();
  $("secondaryToolbarToggleButton").focus();
}
async function mountFileMenu() {
  const {mountSubmenu}=await import('./submenu.js');
  const items = document.createDocumentFragment();
  for (const [id, label] of [
    ["ofdOriginal", "下载原文件"],
    ["ofdConvert", "转换为 OFD"],
    ["ofdFontSettings", "字体与格式"],
    ["ofdPackage", "包内文档与版本"],
    ["ofdAnnotations", "OFD 注释备注"],
    ["ofdMetadata", "编辑文档元数据"],
    ["ofdExtensions", "扩展信息"],
    ["ofdEncrypt", "文档加密"],
    ["ofdIntegrity", "防夹带完整性保护"],
    ["ofdOfficial", "公文"],
    ["ofdVerifySignatures", "签名验证"],
    ["ofdSign", "数字签名与电子印章"],
    ["ofdCertificates", "证书管理"],
    ["ofdSeals", "电子印章管理"],
    ["ofdClose", "关闭文件"],
  ]) {
    const button = document.createElement("button");
    button.id = id;
    button.type = "button";
    button.className = "toolbarButton labeled ofdMenuItem";
    button.disabled = true;
    const text = document.createElement("span");
    text.id = `${id}Label`;
    text.textContent = label;
    button.append(text);
    items.append(button);
  }
  $("secondaryOpenFile").after(items);
  const officialItems=[['ofdOfficialMetadata','公文元数据与校验'],['ofdOfficialStructure','公文结构'],['ofdOfficialMark','将所选文字标为公文要素']].map(([id,label])=>{
    const button=document.createElement('button');button.id=id;button.type='button';button.className='ofdMenuItem';
    const span=document.createElement('span');span.textContent=label;button.append(span);return button;
  });
  mountSubmenu(app,$('ofdOfficial'),officialItems);
  $("secondaryToolbarButtonContainer").addEventListener(
    "click",
    (event) => {
      if (event.target.closest('.ofdMenuItem:not(:disabled):not([aria-haspopup])')) closeFileMenu();
    },
    true,
  );
}
async function mount() {
  app = window.PDFViewerApplication;
  await app.initializedPromise;
  // PDF.js loadingParams deliberately omits passwords. Retain the value from
  // its native prompt only for this document's conversion/inspection session.
  const setPasswordCallback = app.passwordPrompt.setUpdateCallback.bind(app.passwordPrompt);
  app.passwordPrompt.setUpdateCallback = (callback, reason) => {
    const token = generation;
    return setPasswordCallback(value => {
      if (token === generation && typeof value === "string") pdfPassword = value;
      callback(value);
    }, reason);
  };
  ({ nativeDialog } = await import("./dialogs.js"));
  const { mountPackageDialog } = await import("./package-dialog.js");
  ({ certificateIdentity, certificateLabel } = await import("./certificate-view.js"));
  const viewerModule = await import("./ofd-viewer.js");
  ({ openOfdViewer } = viewerModule);
  viewerModule.mountOfdPrinting(app, status);
  viewerModule.mountOfdAnnotationSelection(app);
  (await import("./zoom.js")).mountOfdZoom(app);
  (await import("./view-preferences.js")).mountViewPreferences(app, status);
  await (await import("./properties.js")).mountProperties(app);
  app.eventBus.on("ofdpageinfo", ({ source, info }) => {
    if (source !== app.pdfDocument || current?.type !== "ofd") return;
    current.fonts = info.fonts;
    current.warnings = [...new Set([...current.warnings, ...info.warnings])];
    fontNotice();
  });
  await mountFileMenu();
  actionUI = await (await import("./actions.js")).mountActions(app, status, openFile);
  await mountPackageDialog(app, () => current, switchDocument);
  await (await import("./annotations.js")).mountAnnotations(app, () => current, applyRemark);
  await (await import("./official.js")).mountOfficial(app, applyOfficial, status);
  await (await import("./metadata.js")).mountMetadata(app, patch=>applyDocumentEdit('editMetadata',patch), status);
  await (await import("./extensions.js")).mountExtensions(app, download, status);
  security = (await import("./security.js")).mountSecurity({
    Engine,
    getCurrent: () => current,
    download,
    onChange() {
      if (!current?.signatureSummary) return;
      current.signatureSummary = "证书或材料已改变，请重新验签";
      fontNotice();
      const output = $("ofdSignatureResults");
      if (output)
        output.textContent =
          "证书或验证材料已改变，上次结果已失效。请关闭此窗口后重新运行签名验证。";
    },
  });
  encryptionUI=(await import('./encryption.js')).mountEncryption({security,getCurrent:()=>current,download,status,setBusy(value){converting=value;controls();}});
  integrityUI=(await import('./integrity.js')).mountIntegrity({security,getCurrent:()=>current,download,status});
  nativeDialog($("ofdConversionDialog"), ["ofdConfirm"]);
  const conversionResult = document.createElement("dialog");
  conversionResult.id = "ofdConversionResultDialog";
  conversionResult.setAttribute("aria-labelledby", "ofdConversionResultTitle");
  conversionResult.innerHTML = '<h2 id="ofdConversionResultTitle">转换完成 · 格式提示</h2><p>文件已开始下载。</p><div id="ofdConversionWarnings"></div><div class="actions"><button id="ofdConversionResultClose" type="button">关闭</button></div>';
  document.body.append(conversionResult);
  nativeDialog(conversionResult);
  $("ofdConversionResultClose").addEventListener("click", () => conversionResult.close());
  $("ofdWelcomeOpen").classList.add("primaryButton");
  mountFontSettings();
  mountSignatureSettings();
  const options = document.createElement("div");
  options.id = "ofdExportOptions";
  options.innerHTML =
    '<label>转换方式 <select id="ofdExportMode" class="toolbarField"><option value="text">保留文字（可搜索、复制）</option><option value="vector">矢量（文字转轮廓）</option><option value="image">页面图像</option></select></label> <label>图像分辨率 <select id="ofdExportDpi" class="toolbarField" disabled><option>150</option><option selected>200</option><option>300</option></select> DPI</label><label class="ofdCheck"><input type="checkbox" id="ofdSubsetFonts">字体子集化（仅嵌入使用到的字形）</label>';
  $("ofdConversionNote").after(options);
  const pdfOptions = document.createElement("div");
  pdfOptions.id = "ofdPdfExportOptions";
  pdfOptions.hidden = true;
  pdfOptions.innerHTML = '<label class="ofdCheck"><input type="checkbox" id="ofdPdfSubsetFonts" checked>字体子集化（仅嵌入使用到的字形）</label>';
  options.after(pdfOptions);
  $("ofdExportMode").addEventListener("change", () => {
    $("ofdExportDpi").disabled = $("ofdExportMode").value !== "image";
    $("ofdSubsetFonts").disabled = $("ofdExportMode").value !== "text";
  });
  $("ofdInput").accept = ".ofd,.pdf,application/pdf,application/ofd";
  const choose = () => {
    $("ofdInput").value = "";
    $("ofdInput").click();
  };
  $("ofdWelcomeOpen").addEventListener("click", choose);
  $("ofdInput").addEventListener("change", (e) => openFile(e.target.files[0]));
  $("ofdClose").addEventListener("click", closeFile);
  $("ofdOriginal").addEventListener(
    "click",
    () =>
      current &&
      download(
        current.sourceOriginal || current.original,
        current.name,
        current.type === "pdf" ? "application/pdf" : "application/ofd",
      ),
  );
  $("ofdConvert").addEventListener("click", convert);
  $("ofdConfirm").addEventListener("click", confirmConversion);
  $("ofdCancel").addEventListener("click", () =>
    $("ofdConversionDialog").close(),
  );
  document.addEventListener(
    "click",
    (e) => {
      if (e.target.closest("#openFile, #secondaryOpenFile")) {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeFileMenu();
        choose();
      }
    },
    true,
  );
  document.addEventListener(
    "change",
    (e) => {
      if (e.target.id === "fileInput") {
        e.stopImmediatePropagation();
        openFile(e.target.files[0]);
      }
    },
    true,
  );
  window.addEventListener(
    "dragover",
    (e) => {
      if (e.dataTransfer.types.includes("Files")) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );
  window.addEventListener(
    "drop",
    (e) => {
      if (e.dataTransfer.files.length) {
        e.preventDefault();
        e.stopImmediatePropagation();
        openFile(e.dataTransfer.files[0]);
      }
    },
    true,
  );
  window.addEventListener(
    "keydown",
    (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        e.stopImmediatePropagation();
        choose();
      }
    },
    true,
  );
  window.addEventListener("pagehide", () => engine?.close());
  status("选择或拖入 OFD / PDF 文件，最大 100 MB。");
  controls();
}
window.addEventListener(
  "DOMContentLoaded",
  () => mount().catch((e) => status(`阅读器初始化失败：${e.message}`, true)),
  { once: true },
);

function mountFontSettings() {
  const button = $("ofdFontSettings");
  const dialog = document.createElement("dialog");
  dialog.id = "ofdFontDialog";
  dialog.setAttribute("aria-labelledby", "ofdFontTitle");
  // Static application markup; document/font names are always assigned using textContent.
  dialog.innerHTML = `
    <h2 id="ofdFontTitle">字体与格式</h2>
    <ul id="ofdFormatWarnings"></ul>
    <p>优先使用内嵌字体，也可选择可用的项目字体、导入字体或读取本机字体。替换应用于当前文档的预览与 PDF 导出。</p>
    <div class="font-import"><button id="ofdImportFont" type="button">导入字体文件…</button>
      <button id="ofdLocalFonts" type="button">读取本机字体…</button><span>TTF / TTC / OTF · 最大 100 MB</span></div>
    <input id="ofdFontFile" type="file" accept=".ttf,.ttc,.otf" hidden>
    <div id="ofdFontRows"></div>
    <p id="ofdFontMessage" role="status" aria-live="polite"></p>
    <p class="font-footnote">所选字体的字形和宽度可能与原字体不同。更换后请核对文字；不会修改原文件。数字签名请使用“工具”菜单的“签名验证”检查原始 OFD；转换后的 PDF 不继承原签名。</p>
    <div class="actions"><button id="ofdFontCancel" type="button">关闭</button>
      <button id="ofdFontApply" type="button">应用并重新预览</button></div>`;
  nativeDialog(dialog, ["ofdFontApply"]);
  document.body.append(dialog);
  button.addEventListener("click", showFontSettings);
  $("ofdLocalFonts").addEventListener("click", loadLocalFonts);
  $("ofdFontCancel").addEventListener("click", () => dialog.close());
  $("ofdFontApply").addEventListener("click", applyFonts);
  $("ofdImportFont").addEventListener("click", () => {
    $("ofdFontFile").value = "";
    $("ofdFontFile").click();
  });
  $("ofdFontFile").addEventListener("change", (event) =>
    importFont(event.target.files[0]),
  );
}

function chosenFonts() {
  const choices = {};
  $("ofdFontRows")
    .querySelectorAll("select")
    .forEach((select) => {
      for (const id of JSON.parse(select.dataset.ids))
        choices[id] = select.value;
    });
  return choices;
}

function renderFontSettings(selections = {}) {
  $("ofdFormatWarnings").replaceChildren();
  for (const warning of fontData.warnings) {
    const li = document.createElement("li");
    li.textContent = warning;
    $("ofdFormatWarnings").append(li);
  }
  $("ofdFormatWarnings").hidden = !fontData.warnings.length;
  const groups = new Map();
  for (const font of fontData.fonts) {
    const key = JSON.stringify([
      font.name,
      font.family,
      font.embedded,
      selections[font.id] || font.selected,
    ]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(font);
  }
  const optionGroups = document.createDocumentFragment();
  for (const [label, match] of [
    ["本次导入", (option) => option.imported],
    ["项目字体", (option) => option.source === "bundled"],
    ["内置字体", (option) => option.source === "builtin"],
  ]) {
    const group = document.createElement("optgroup");
    group.label = label;
    fontData.options.filter(match).forEach((font) => {
      const option = document.createElement("option");
      option.value = font.id;
      option.textContent = font.label;
      group.append(option);
    });
    if (group.childElementCount) optionGroups.append(group);
  }
  $("ofdFontRows").replaceChildren();
  for (const fonts of groups.values()) {
    const font = fonts[0];
    const row = document.createElement("div");
    row.className = "font-row";
    const label = document.createElement("label");
    label.textContent = font.name || font.family || `字体 ${font.id}`;
    const details = document.createElement("small");
    const missingCharacters = Math.max(
      ...fonts.map((f) => f.missingCharacters),
    );
    details.textContent =
      `${font.selected !== "auto" ? "已手动替换" : font.embedded ? "已内嵌" : font.missing ? "原字体缺失，正在使用替代字体" : font.source === "bundled" ? "项目字体已匹配" : "本机已匹配"} · ID ${fonts.map((f) => f.id).join(", ")}` +
      (missingCharacters
        ? ` · 当前替代字体仍缺 ${missingCharacters} 个字符`
        : "") +
      (fonts.some((f) => f.glyphIndexed)
        ? " · 含字形索引，替换后需核对字符"
        : "");
    label.append(details);
    row.append(label);
    const select = document.createElement("select");
    select.className = "toolbarField";
    select.id = `ofd-font-${font.id}`;
    select.dataset.ids = JSON.stringify(fonts.map((f) => f.id));
    const auto = document.createElement("option");
    auto.value = "auto";
    auto.textContent = font.embedded ? "自动 · 文档内嵌字体" : "自动匹配";
    select.append(auto, optionGroups.cloneNode(true));
    select.value = selections[font.id] || font.selected || "auto";
    label.htmlFor = select.id;
    row.append(select);
    $("ofdFontRows").append(row);
  }
}

async function showFontSettings() {
  if (current?.type !== "ofd") return;
  const token = generation;
  try {
    fontData = await engine.call("fonts");
    if (token !== generation) return;
    renderFontSettings();
    $("ofdFontMessage").textContent =
      "选择后点击“应用并重新预览”；PDF 导出使用相同字体。";
    $("ofdFontDialog").showModal();
  } catch (e) {
    status(e.message, true);
  }
}
async function importFont(file) {
  if (!file || !current) return;
  if (!file.size || file.size > 100 * 1048576) {
    $("ofdFontMessage").textContent = "字体文件为空或超过 100 MB。";
    return;
  }
  const token = generation,
    selections = chosenFonts();
  $("ofdImportFont").disabled = $("ofdFontApply").disabled = true;
  $("ofdFontMessage").textContent = "正在检查字体文件…";
  try {
    const result = await engine.call("importFont", {
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    if (token !== generation) return;
    fontData = result;
    renderFontSettings(selections);
    $("ofdFontMessage").textContent = "字体已加入“本次导入”，选择后应用即可。";
  } catch (e) {
    if (token === generation) $("ofdFontMessage").textContent = e.message;
  } finally {
    $("ofdImportFont").disabled = $("ofdFontApply").disabled = false;
  }
}
async function authorizedLocalFonts() {
  if (!window.queryLocalFonts) return { fonts: [] };
  const permission = await navigator.permissions.query({ name: "local-fonts" });
  if (permission.state !== "granted") {
    ((localFontCatalog = null), nativeDialog, security);
    return { fonts: [] };
  }
  localFontCatalog ||= await window.queryLocalFonts();
  return { fonts: localFontCatalog };
}
function fontDescriptions(fonts) {
  return fonts.map(({ fullName, postscriptName, family, style }) => ({ fullName, postscriptName, family, style }));
}
async function autoLocalFonts(worker, fonts) {
  const indexes = await worker.call("matchLocalFonts", {
    fonts: fonts.map(({ fullName, postscriptName, family, style }) => ({
      fullName,
      postscriptName,
      family,
      style,
    })),
  });
  const result = { count: 0, warnings: [] };
  for (const index of indexes) {
    try {
      const blob = await fonts[index].blob();
      await worker.call("importFont", {
        bytes: new Uint8Array(await blob.arrayBuffer()),
      });
      result.count++;
    } catch (e) {
      result.warnings.push(`${fonts[index].fullName}：${e.message}`);
    }
  }
  return result;
}
async function loadLocalFonts() {
  if (!window.queryLocalFonts) {
    $("ofdFontMessage").textContent =
      "当前浏览器不提供本机字体访问，请点击“导入字体文件”。";
    return;
  }
  const token = generation;
  try {
    const fonts = await window.queryLocalFonts();
    localFontCatalog = fonts;
    engine.localFonts = fonts;
    await engine.call("setLocalFonts", { fonts: fontDescriptions(fonts) });
    if (token !== generation) return;
    const selections = chosenFonts();
    const matched = await autoLocalFonts(engine, fonts);
    if (token !== generation) return;
    fontData = await engine.call("fonts");
    renderFontSettings(selections);
    const select = document.createElement("select");
    select.className = "toolbarField";
    select.id = "ofdLocalFontChoice";
    select.setAttribute("aria-label", "本机字体");
    for (const [i, font] of fonts.entries()) {
      const option = document.createElement("option");
      option.value = i;
      option.textContent = font.fullName;
      select.append(option);
    }
    const button = document.createElement("button");
    button.className = "secondaryButton";
    button.textContent = "导入所选本机字体";
    button.type = "button";
    button.addEventListener("click", async () => {
      try {
        button.disabled = true;
        const blob = await fonts[Number(select.value)].blob();
        if (token !== generation) return;
        await importFont(blob);
      } catch (e) {
        $("ofdFontMessage").textContent = e.message;
      } finally {
        button.disabled = false;
      }
    });
    $("ofdLocalFontPicker")?.remove();
    const row = document.createElement("div");
    row.id = "ofdLocalFontPicker";
    row.append(select, button);
    $("ofdFontRows").before(row);
    $("ofdFontMessage").textContent =
      `已自动导入 ${matched.count} 个匹配字体，点击“应用并重新预览”生效。也可在上方选择其他本机字体；以后打开文件会自动匹配已授权的字体。${matched.warnings.join("；")}`;
  } catch (e) {
    if (token === generation)
      $("ofdFontMessage").textContent =
        `无法读取本机字体：${e.message}。也可直接导入字体文件。`;
  }
}
async function applyFonts() {
  if (!current || opening) return;
  const token = generation,
    previousPage = app.page,
    previousScale = app.pdfViewer.currentScaleValue;
  $("ofdFontApply").disabled = $("ofdImportFont").disabled = true;
  opening = true;
  controls();
  $("ofdFontMessage").textContent = "正在重新生成预览…";
  try {
    const result = await engine.call("setFonts", { choices: chosenFonts() });
    if (token !== generation) return;
    await app.close();
    await openOfdViewer(app, engine, result, current.sourceOriginal||current.original, current.name);
    if (token !== generation) return;
    current = { ...current, ...result };
    await app.pdfViewer.firstPagePromise;
    if (token !== generation) return;
    app.pdfViewer.currentScaleValue = previousScale;
    app.page = Math.min(previousPage, result.pages);
    fontNotice();
    $("ofdFontDialog").close();
    status("字体已应用 · PDF 导出将使用当前预览的字体");
  } catch (e) {
    if (token === generation) {
      $("ofdFontMessage").textContent = `应用失败：${e.message}`;
      status(e.message, true);
    }
  } finally {
    if (token === generation) {
      opening = false;
      controls();
    }
    $("ofdFontApply").disabled = $("ofdImportFont").disabled = false;
  }
}

function mountSignatureSettings() {
  const button = $("ofdVerifySignatures");
  const dialog = document.createElement("dialog");
  dialog.id = "ofdSignatureDialog";
  dialog.setAttribute("aria-labelledby", "ofdSignatureTitle");
  dialog.innerHTML = `<h2 id="ofdSignatureTitle">签名验证</h2><div id="ofdSignatureResults" role="status" aria-live="polite"></div><div class="actions"><button id="ofdSignatureManage" type="button">证书管理</button><button id="ofdSignatureRefresh" type="button">重新验证</button><button id="ofdSignatureClose" type="button">关闭</button></div>`;
  nativeDialog(dialog);
  document.body.append(dialog);
  $("ofdSignatureClose").onclick = () => dialog.close();
  let controller;
  dialog.addEventListener('close',()=>controller?.abort());
  const run = async () => {
    if (current?.type !== "ofd") return;
    const token = generation;
    controller?.abort();const requestController=new AbortController();controller=requestController;
    const owner=current;
    const output = $("ofdSignatureResults");
    output.textContent = "正在验证…";
    if(!dialog.open)dialog.showModal();
    button.disabled = true;
    for(const id of ['ofdSignatureManage','ofdSignatureRefresh'])$(id).disabled=true;
    try {
      const result=await security.verify(owner.original,owner.selection);
      if (token !== generation||requestController.signal.aborted) return;
      output.replaceChildren();
      const localStatus=s=>s.verdict==='failed'?'failed':s.status;
      const line = (parent, text, tag = "p") => {
        const e = document.createElement(tag);
        e.textContent = text;
        parent.append(e);
        return e;
      };
      const disclosure = (parent, title) => {
        const details = line(parent, "", "details");
        line(details, title, "summary");
        return details;
      };
      const statusName = (value) =>
        ({
          passed: "通过",
          failed: "失败",
          unknown: "未确认",
          trusted: "已信任",
          good: "未吊销",
          revoked: "已吊销",
          "not-applicable": "信任锚",
        })[value] || "未确认";
      function showValidation(parent, validation, title = "证书信任链") {
        if (!validation) return;
        line(
          parent,
          `${title}：${statusName(validation.trust)} · 吊销状态：${statusName(validation.revocation)}`,
        );
        if (validation.reason) line(parent, validation.reason);
        if(validation.detail){const d=line(parent,'','details');line(d,'证书链检查细节','summary');line(d,validation.detail);}
        if (validation.path.length) {
          const details = document.createElement("details");
          parent.append(details);
          line(details, `${title}详情（${validation.checkedAt}）`, "summary");
          for (const c of validation.path) {
            certificateIdentity(details, c);
            line(
              details,
              `吊销：${statusName(c.revocation.status)}${c.revocation.source ? " · " + c.revocation.source : ""}`,
            );
            if (c.revocation.reason) line(details, c.revocation.reason);
            if (c.revocation.thisUpdate)
              line(
                details,
                `材料有效期：${c.revocation.thisUpdate} — ${c.revocation.nextUpdate||'未声明 nextUpdate（仅接受 24 小时内状态）'}`,
              );
          }
        }
      }
      if (!result.signatures.length)
        line(
          output,
          "未找到数字签名。",
        );
      for (const s of result.signatures) {
        const section = document.createElement("section");
        section.className = "ofdResult";
        section.dataset.status = localStatus(s);
        output.append(section);
        line(
          section,
          `签名 ${s.id || "—"} · ${{ passed: "本地验证通过", failed: "本地验证失败", incomplete: "本地验证未完成" }[localStatus(s)]}`,
          "h3",
        );
        if (s.claimedTime)
          line(section, `签名时间：${s.claimedTime}`);
        if (s.error) line(section, s.error);
        const failures = [];
        if (s.references.some(r => r.status === "failed")) failures.push("文件摘要不一致");
        if (s.crypto?.verified === false) failures.push("签名值验证失败");
        const seal = s.crypto?.seal;
        if (seal?.authorization === "failed") failures.push("用章授权失败");
        if (seal?.validity === "failed") failures.push("印章不在有效期内");
        if (seal?.signingTimeValidity === "failed") failures.push("签章时间校验失败");
        if (s.trust === "failed") failures.push("证书校验失败");
        if (s.revocation === "revoked") failures.push("证书已吊销");
        if (s.timestamp === "failed") failures.push("时间戳验证失败");
        if (failures.length) line(section, failures.join(" · "));
        for (const signer of s.crypto?.signers || []) {
          const c = signer.certificate;
          const signerDetails = disclosure(section, `签名者：${certificateLabel(c)}`);
          line(
            signerDetails,
            `签名值：${signer.verified ? "通过" : "失败"} · 算法 ${signer.algorithm}`,
          );
          certificateIdentity(signerDetails, c);
          if (c.der) {
            const save = line(signerDetails, "保存证书", "button");
            save.type = "button";
            save.className = "secondaryButton";
            save.onclick = async () => {
              save.disabled = true;
              try {
                await security.addCertificate(c.der);
                save.textContent = "证书已保存";
              } catch (error) {
                save.textContent = error.message;
                save.disabled = false;
              }
            };
          }
          line(
            signerDetails,
            `证书有效期：${c.notBefore} 至 ${c.notAfter} · ${c.timeValid ? "有效" : "不在有效期内"}`,
          );
          showValidation(signerDetails, signer.validation);
          if (!signer.timestamps?.length)
            line(signerDetails, "时间戳：未附带");
          for (const timestamp of signer.timestamps || []) {
            line(
              signerDetails,
              `可信时间戳：${statusName(timestamp.status)}${timestamp.time ? " · " + timestamp.time : ""}`,
            );
            if (timestamp.tsa)
              line(signerDetails, `TSA：${timestamp.tsa} · 策略 ${timestamp.policy}`);
            if (timestamp.reason) line(signerDetails, timestamp.reason);
            showValidation(signerDetails, timestamp.validation, "TSA 证书链");
          }
        }
        if (s.crypto?.seal) {
          const seal = s.crypto.seal;
          const sealDetails = disclosure(section, seal.name ? `印章：${seal.name}` : "印章详情");
          line(
            sealDetails,
            `制章签名：${seal.verified === null ? "未验证" : seal.verified ? "通过" : "失败"} · 用章授权：${statusName(seal.authorization)} · 有效期：${statusName(seal.validity)}`,
          );
          line(sealDetails, `印章有效期：${seal.validFrom} — ${seal.validTo}`);
          if (seal.reason) line(sealDetails, seal.reason);
          line(
            sealDetails,
            `签章时间校验：${statusName(seal.signingTimeValidity)}${seal.signingTime ? " · " + seal.signingTime : ""}`,
          );
          if (seal.timeReason) line(sealDetails, seal.timeReason);
          showValidation(sealDetails, seal.validation, "制章者证书链");
        }
        const verification = disclosure(section, "验证详情");
        line(verification, `签名文件：${s.file || "未知"}`);
        line(verification, `摘要算法：${s.digest || "未知"} · 格式：${s.crypto?.format || "未知"}`);
        const details = document.createElement("details");
        verification.append(details);
        line(
          details,
          `文件摘要：${s.references.filter((r) => r.status === "passed").length}/${s.references.length} 通过`,
          "summary",
        );
        const list = document.createElement("ul");
        details.append(list);
        for (const r of s.references)
          line(
            list,
            `${{ passed: "通过", failed: "失败", unsupported: "不支持" }[r.status]} · ${r.path}${r.error ? " · " + r.error : ""}`,
            "li",
          );
        for (const w of s.warnings) line(verification, w);
        if (s.uncovered.length) {
          const uncovered = document.createElement("details");
          verification.append(uncovered);
          line(uncovered, "未被本签名引用的文件", "summary");
          const list = document.createElement("ul");
          uncovered.append(list);
          for (const path of s.uncovered) line(list, path, "li");
        }
      }
      const failed = result.signatures.some(
          (s) => localStatus(s) === "failed",
        ),
        incomplete = result.signatures.some(
          (s) => localStatus(s) !== "passed",
        );
      current.signatureSummary = !result.signatures.length
        ? "未声明数字签名"
        : failed
          ? "签名校验失败"
          : incomplete
            ? "签名验证未完成"
            : "签名本地验证通过";
      fontNotice();
    } catch (e) {
      if (token === generation&&!requestController.signal.aborted) {
        output.textContent = `无法完成验证：${e.message}`;
        current.signatureSummary = "签名验证未完成";
        fontNotice();
      }
    } finally {
      if (token === generation&&controller===requestController) {controls();for(const id of ['ofdSignatureManage','ofdSignatureRefresh'])$(id).disabled=false;}
    }
  };
  button.onclick=()=>run();
  $('ofdSignatureRefresh').onclick=()=>run();
  $('ofdSignatureManage').onclick=async()=>{const owner=current;dialog.close();await security.manageCertificates();if(current===owner)await run();};
}

async function switchDocument(selection) {
  if (!current || opening || converting) return;
  const previous = current;
  opening = true; ++generation; controls();
  security?.closeDocumentDialogs();
  $("ofdSignatureDialog")?.close();
  try {
    await app.close();
    const result = await engine.call("selectDocument", { selection });
    current = { ...previous, ...result, signatureSummary: "未验证数字签名" };
    await openOfdViewer(app, engine, result, current.sourceOriginal||current.original, current.name);
    fontNotice();
    status(`已打开 ${current.documents[selection.documentIndex].title} · ${current.pages} 页`);
  } catch (error) {
    const restored = await engine.call("selectDocument", { selection: previous.selection });
    current = { ...previous, ...restored };
    await openOfdViewer(app, engine, restored, previous.sourceOriginal||previous.original, previous.name);
    status(error.message, true);
  } finally { opening = false; controls(); }
}

async function applyRemark(args) {
  if (!current || opening || converting) return;
  opening = true; ++generation; controls();
  try {
    const result = await engine.call("editRemark", args);
    await app.close();
    current = { ...current, ...result, modified:true, sourceOriginal:null, original: result.bytes, signatureSummary: "请重新验证数字签名" };
    await openOfdViewer(app, engine, result, current.original, current.name);
    fontNotice(); status(`备注已修改；可下载当前 OFD 文件或导出 PDF 保存。${current.decrypted?'修改后的文件不加密，可通过“文档加密”重新加密。':''}`);
  } finally { opening = false; controls(); }
}

const applyOfficial=patch=>applyDocumentEdit('editOfficial',patch);
async function applyDocumentEdit(method,patch) {
  if (!current || opening || converting) throw Error("文档正在处理，请稍后重试。");
  const owner=current,worker=engine, page=app.page, token=++generation;
  opening=true;controls();
  try {
    const result=await worker.call(method,patch);
    if(token!==generation||current!==owner)throw Error("文档已切换，操作取消。");
    await app.close();
    if(token!==generation)return;
    current={...owner,...result,modified:true,sourceOriginal:null,original:result.bytes,signatureSummary:"请重新验证数字签名"};
    await openOfdViewer(app,worker,result,current.original,current.name);
    app.page=Math.min(page,current.pages);
    fontNotice();status(`${method==='editOfficial'?'公文信息':'文档元数据'}已写入当前 OFD；可下载保存。${current.decrypted?'修改后的文件不加密，可通过“文档加密”重新加密。':''}`);
    app.eventBus.dispatch("ofdofficialupdated",{});
  } finally {if(token===generation){opening=false;controls();}}
}
