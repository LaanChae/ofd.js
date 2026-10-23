import {metadataFields as fields} from "../shared/metadata-fields.js";
import { officialFields } from "../shared/official-fields.js";
import { line } from "./dialogs.js";



export async function mountProperties(app) {
  const dialog = document.createElement("dialog");
  dialog.id = "ofdPropertiesDialog";
  dialog.setAttribute("aria-label", "OFD 文档属性");
  // Use the same row / separator / buttonRow DOM and CSS as PDF.js properties.
  const actions = document.createElement("div");
  actions.className = "buttonRow";
  const close = document
    .getElementById("documentPropertiesClose")
    .cloneNode(true);
  close.removeAttribute("id");
  close.addEventListener("click", () => app.overlayManager.close(dialog));
  actions.append(close);
  const edit=line(actions,'编辑元数据','button');edit.id='ofdPropertiesEdit';edit.className='secondaryButton';
  edit.onclick=async()=>{await app.overlayManager.close(dialog);app.eventBus.dispatch('ofdeditmetadata',{});};
  document.body.append(dialog);
  await app.overlayManager.register(dialog);
  let rowId = 0;
  function row(label, value) {
    const element = document.createElement("div");
    element.className = "row";
    const term = line(element, `${label}：`, "span");
    term.id = `ofdPropertyLabel${++rowId}`;
    const content = line(element, value || "-", "p");
    content.setAttribute("aria-labelledby", term.id);
    dialog.append(element);
  }
  function separator() {
    const element = document.createElement("div");
    element.className = "separator";
    dialog.append(element);
  }
  app.eventBus.on("ofddocumentproperties", async () => {
    const doc = app.pdfDocument;
    if (!doc?.isOFD || dialog.open) return;
    const properties = doc.metadata.properties,
      number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 }),
      pageNumber = app.page || 1,
      page = (await doc.getPage(pageNumber)).info;
    if (app.pdfDocument !== doc) return;
    dialog.replaceChildren();
    rowId = 0;
    row("文件名", doc.filename);
    row("文件大小", `${number.format(doc.original.byteLength)} 字节`);
    separator();
    for (const [key, label] of fields)
      if (key === "DocID" || properties.docInfo[key])
        row(label, properties.docInfo[key]);
    if (properties.keywords.length)
      row("关键词", properties.keywords.join("；"));
    separator();
    if (doc.metadata.selection) {
      const selection = doc.metadata.selection, selected = doc.metadata.documents[selection.documentIndex];
      row("包内文档", `${selection.documentIndex + 1} / ${doc.metadata.documents.length} · ${selected.title}`);
      row("文档版本", selection.versionId ? selected.versions.find((v) => v.id === selection.versionId)?.title : "主文档");
    }
    row("OFD 版本", properties.version);
    row("文档类型", properties.docType);
    row("页数", String(doc.numPages));
    if (page) {
      row("当前页", `${pageNumber} / ${doc.numPages}（ID ${page.id}）`);
      row(
        "页面大小",
        `${number.format(page.physicalBox[2])} × ${number.format(page.physicalBox[3])} 毫米`,
      );
      if (page.physicalBox[0] || page.physicalBox[1])
        row(
          "页面原点",
          `${number.format(page.physicalBox[0])}, ${number.format(page.physicalBox[1])} 毫米`,
        );
    }
    row("命名空间", properties.namespace);
    row("文档入口", properties.docRoot);
    if (properties.signatures) row("签名索引", properties.signatures);
    if (properties.customData.length) {
      separator();
      for (const entry of properties.customData) {
        const field = officialFields.find(f => f.key === entry.name);
        row(field ? `${field.label}（${entry.name}）` : entry.name || "（未命名）", entry.value);
      }
    }
    dialog.append(actions);
    await app.overlayManager.open(dialog);
    dialog.scrollTop = 0;
  });
  app.eventBus.on("pagesdestroy", () =>
    app.overlayManager.closeIfActive(dialog),
  );
}
