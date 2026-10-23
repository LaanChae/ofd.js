import { nativeDialog, line } from "./dialogs.js";

export async function mountPackageDialog(app, getCurrent, select) {
  const dialog = document.createElement("dialog");
  dialog.id = "ofdPackageDialog";
  dialog.setAttribute("aria-label", "包内文档与版本");
  line(dialog, "包内文档与版本", "h2");
  const documentLabel = line(dialog, "文档", "label");
  const documents = document.createElement("select");
  documents.id = "ofdPackageDocument"; documentLabel.htmlFor = documents.id;
  dialog.append(documents);
  const versionLabel = line(dialog, "版本", "label");
  const versions = document.createElement("select");
  versions.id = "ofdPackageVersion"; versionLabel.htmlFor = versions.id;
  dialog.append(versions);
  const details = line(dialog, "", "p", "ofdMuted");
  const message = line(dialog, "", "p", "ofdMuted"); message.setAttribute("role", "status");
  const buttons = document.createElement("div"); buttons.className = "buttonRow";
  const cancel = document.createElement("button"), apply = document.createElement("button");
  cancel.textContent = "关闭"; apply.textContent = "打开所选文档与版本"; apply.id = "ofdPackageApply";
  buttons.append(cancel, apply); dialog.append(buttons); document.body.append(dialog);
  nativeDialog(dialog, [apply.id]); await app.overlayManager.register(dialog);
  const option = (value, label) => { const o = document.createElement("option"); o.value = value; o.textContent = label; return o; };
  const updateVersions = (chosen) => {
    const doc = getCurrent().documents[Number(documents.value)];
    versions.replaceChildren(option("", "主文档"));
    for (const v of doc.versions) {
      const o = option(v.id, `${v.title} · 版本 ${v.index}${v.current ? "（当前）" : ""}${v.error ? "（不可读取）" : ""}`);
      o.disabled = !!v.error; o.title = v.error || v.file; versions.append(o);
    }
    versions.value = chosen ?? doc.versions.find((v) => v.current)?.id ?? "";
    updateDetails();
  };
  const updateDetails = () => {
    const doc = getCurrent().documents[Number(documents.value)], v = doc.versions.find((v) => v.id === versions.value);
    details.textContent = `${v?.date ? `创建日期：${v.date} · ` : ""}入口：${v?.docRoot || doc.docRoot}。预览、PDF 导出和验签使用当前选择；下载原文件保留整个包。`;
  };
  documents.onchange = () => updateVersions(); versions.onchange = updateDetails;
  cancel.onclick = () => app.overlayManager.close(dialog);
  apply.onclick = async () => {
    const selection = { documentIndex: Number(documents.value), versionId: versions.value };
    await app.overlayManager.close(dialog);
    await select(selection);
  };
  document.getElementById("ofdPackage").onclick = async () => {
    const current = getCurrent(); if (current?.type !== "ofd") return;
    documents.replaceChildren(...current.documents.map((d) => option(String(d.index), `${d.index + 1}. ${d.title}`)));
    documents.value = String(current.selection.documentIndex);
    updateVersions(current.selection.versionId); message.textContent = "";
    await app.overlayManager.open(dialog);
  };
}
