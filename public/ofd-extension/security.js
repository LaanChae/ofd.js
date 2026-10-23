import { mountSealManager } from "./seal-manager.js";
import { mountStampEditor } from "./stamp-editor.js";
import { certificateFields } from "../shared/certificate-fields.js";
import {
  certificateIdentity,
  certificateLabel,
  propertyRows,
} from "./certificate-view.js";
import { nativeDialog, line } from "./dialogs.js";
import { passwordStrengthHint } from "./password-strength.js";
const $ = (id) => document.getElementById(id);
const storageKey = "paperdesk.certificates";
const trustKey = "paperdesk.trustedCertificates",
  evidenceKey = "paperdesk.revocationEvidence";
const decode = (value) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
export function mountSecurity({ Engine, getCurrent, download, onChange }) {
  const worker = new Engine("/engine/security-worker.js");
  let certificates = [],
    materials = [],
    busy = false;
  const manager = document.createElement("dialog");
  manager.id = "ofdCertificateDialog";
  manager.setAttribute("aria-labelledby", "ofdCertificateTitle");
  manager.innerHTML = `<h2 id="ofdCertificateTitle">证书管理</h2>
    <p class="ofdMuted">证书保存在当前浏览器；刷新或关闭页面后需重新导入私钥。</p>
    <details><summary>导入证书与私钥</summary><form id="ofdCertificateImport" class="ofdForm">
      <label>证书文件<input id="ofdCertificateFile" type="file" accept=".p12,.pfx,.pem,.cer,.crt,.der,.p7b,.p7c" required></label>
      <label>私钥文件（签名时需要）<input id="ofdPrivateKeyFile" type="file" accept=".pem,.key,.der,.p8"></label>
      <label>文件密码<input id="ofdCertificatePassword" type="password" autocomplete="off" placeholder="P12/PFX 或加密私钥的密码"></label>
      <p class="ofdMuted">证书：P12/PFX、PEM/DER、P7B/P7C；私钥：PKCS#8。</p>
      <div class="actions"><button id="ofdCertificateImportButton" type="submit">导入证书与私钥</button></div>
    </form></details>
    <details><summary>创建与签发证书</summary>
      <form id="ofdCertificateCreate" class="ofdForm">
        <label>创建方式<select id="ofdCreateType"><option value="self-signed">自签名文档证书</option><option value="root-ca">自签名根 CA 证书</option><option value="issued">由 CA 签发文档证书</option></select></label>
        <label>证书用途<select id="ofdCreatePurpose"><option value="sign">数字签名</option><option value="encrypt">文档加密（SM2）</option></select></label>
        <label id="ofdCreateIssuerRow" hidden>颁发者（CA）<select id="ofdCreateIssuer" required disabled></select></label>
        <p id="ofdCreateHint" class="ofdMuted"></p>
        <div id="ofdCreateIssuerDetails"></div>
        <div id="ofdCreateSubject" class="ofdForm"></div>
        <details><summary>更多主体字段</summary><div id="ofdCreateSubjectMore" class="ofdForm"></div></details>
        <label>持有人密钥算法<select id="ofdCreateAlgorithm"><option value="SM2">SM2 / SM3</option><option value="ECDSA">ECDSA P-256 / SHA-256</option><option value="RSA">RSA 3072 / SHA-256</option></select></label>
        <label>有效期（天）<input id="ofdCreateDays" type="number" min="1" max="3650" value="365" required></label>
        <label>私钥备份密码（可选）<input id="ofdCreatePassword" type="password" maxlength="1024" autocomplete="new-password" aria-describedby="ofdCreatePasswordStrength" placeholder="留空不加密"></label>
        <p id="ofdCreatePasswordStrength" class="ofdMuted" role="status" aria-live="polite"></p>
        <label>再次输入密码<input id="ofdCreatePasswordAgain" type="password" maxlength="1024" autocomplete="new-password"></label>
        <div class="actions"><button id="ofdCreateConfirm" type="submit">创建并下载备份</button></div>
      </form>
    </details>
    <details><summary>吊销验证材料（CRL / OCSP）</summary>
      <p class="ofdMuted">支持 CRL 或完整 OCSP 响应，格式为 PEM / DER。</p>
      <form id="ofdEvidenceForm" class="ofdForm">
        <label>材料类型<select id="ofdEvidenceType"><option value="crl">CRL 证书吊销列表</option><option value="ocsp">OCSP 响应</option></select></label>
        <label>材料文件<input id="ofdEvidenceFile" type="file" accept=".crl,.ocsp,.der,.pem,.res,.resp" required></label>
        <div class="actions"><button id="ofdEvidenceImport" type="submit">导入验证材料</button></div>
      </form><div id="ofdEvidenceList"></div>
    </details>
    <p id="ofdCertificateMessage" role="status" aria-live="polite"></p>
    <div id="ofdCertificateList"></div>
    <div class="actions"><button id="ofdCertificateClose" type="button">关闭</button></div>`;
  for (const [index, field] of certificateFields.entries()) {
    const label = document.createElement("label");
    label.textContent = `${field.label}（${field.key}）${field.required ? " *" : ""}`;
    const input = document.createElement("input");
    input.id = `ofdCreate${field.key}`;
    input.name = field.key;
    input.autocomplete = "off";
    input.maxLength = field.maxLength;
    input.required = !!field.required;
    if (field.key === "C") {
      input.placeholder = "CN";
      input.pattern = "[A-Za-z]{2}";
    }
    if (field.key === "emailAddress") input.type = "email";
    if (field.key === "DC") input.placeholder = "example";
    label.append(input);
    manager
      .querySelector(index < 6 ? "#ofdCreateSubject" : "#ofdCreateSubjectMore")
      .append(label);
  }
  nativeDialog(manager, [
    "ofdCertificateImportButton",
    "ofdCreateConfirm",
    "ofdEvidenceImport",
  ]);
  document.body.append(manager);
  const updatePasswordStrength = () => {
    $("ofdCreatePasswordStrength").textContent = passwordStrengthHint($("ofdCreatePassword").value);
  };
  $("ofdCreatePassword").addEventListener("input", updatePasswordStrength);
  updatePasswordStrength();
  const signing = document.createElement("dialog");
  signing.id = "ofdSignDialog";
  signing.setAttribute("aria-labelledby", "ofdSignTitle");
  signing.innerHTML = `<h2 id="ofdSignTitle">数字签名与电子印章</h2>
    <p id="ofdSignFile"></p>
    <p class="ofdMuted">为原始 OFD 生成签名副本，不包含预览中的字体替换。可添加数字签名或可见电子印章，原文件保持不变。</p>
    <form id="ofdSignForm" class="ofdForm">
      <label>签名证书<select id="ofdSigningCertificate" required></select></label>
      <div id="ofdSigningDetails"></div>
      <label class="ofdCheck"><input id="ofdVisibleSeal" type="checkbox">添加可见电子印章（SM2）</label>
      <label id="ofdSigningSealRow" hidden>电子印章<select id="ofdSigningSeal"></select></label>
      <div id="ofdStampFields" hidden></div>
      <p class="ofdMuted">新签名时间来自本机，不附加 TSA 时间戳。打开副本后可在“签名验证”中核验信任链、吊销材料和已有可信时间戳。</p>
      <p id="ofdSignMessage" role="status" aria-live="polite"></p>
      <div class="actions"><button id="ofdSignManage" type="button">管理证书…</button><button id="ofdSignSeals" type="button">管理电子印章…</button><button id="ofdSignCancel" type="button">取消</button><button id="ofdSignConfirm" type="submit">签名并下载副本</button></div>
    </form>`;
  const stampEditor = mountStampEditor(
    signing.querySelector("#ofdStampFields"),
    showSigningDetails,
  );
  nativeDialog(signing, ["ofdSignConfirm"]);
  document.body.append(signing);
  let selectedSeal,
    sealRequest = 0;
  const sealManager = mountSealManager({
    worker,
    getCertificates: () => certificates,
    download,
    onChange: renderSeals,
  });
  function renderSeals() {
    const select = $("ofdSigningSeal"),
      previous = select.value;
    select.replaceChildren();
    const id = $("ofdSigningCertificate").value;
    for (const seal of sealManager
      .list()
      .filter((s) => s.timeValid && s.authorized.some((c) => c.id === id)))
      line(select, `${seal.name} · ${seal.sealId}`, "option").value = seal.id;
    if ([...select.options].some((o) => o.value === previous))
      select.value = previous;
    if (!select.options.length)
      line(select, "没有授权此证书的有效印章，请先制章或导入", "option").value =
        "";
    select.disabled = busy;
    chooseSeal();
  }
  async function chooseSeal() {
    const id = $("ofdSigningSeal").value;
    if (id && selectedSeal?.metadata.id === id) return showSigningDetails();
    const request = ++sealRequest;
    selectedSeal = undefined;
    stampEditor.setSeal(undefined);
    if (!id) return;
    try {
      const entry = await worker.call("sealGet", { id });
      if (request !== sealRequest) return;
      selectedSeal = entry;
      stampEditor.setSeal(entry);
    } catch (e) {
      if (request === sealRequest) message("ofdSignMessage", e.message, true);
    }
    showSigningDetails();
  }
  function message(id, text, error = false) {
    $(id).textContent = text;
    $(id).classList.toggle("ofdError", error);
  }
  function persist() {
    onChange();
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify(certificates.map((c) => c.der)),
      );
      localStorage.setItem(
        trustKey,
        JSON.stringify(certificates.filter((c) => c.trusted).map((c) => c.id)),
      );
      localStorage.setItem(evidenceKey, JSON.stringify(materials));
      return true;
    } catch {
      message(
        "ofdCertificateMessage",
        "当前操作已完成，但浏览器未能保存证书目录；重新打开页面后需要重新导入。",
        true,
      );
      return false;
    }
  }
  function detail(parent, c) {
    certificateIdentity(parent, c);
    propertyRows(parent, [
      ["有效期起始", c.notBefore],
      ["有效期截止", c.notAfter],
      ["证书类型", c.isCA ? "CA 证书" : "终端签名证书"],
      ["公钥算法", c.algorithm],
      ["证书序列号", c.serial],
      ["SHA-256 指纹", c.id],
    ]);
  }

  function action(parent, label, handler) {
    const button = line(parent, label, "button", "secondaryButton");
    button.type = "button";
    button.disabled = busy;
    button.onclick = async () => {
      if (busy) return;
      busy = true;
      render();
      try {
        await handler();
      } catch (error) {
        message("ofdCertificateMessage", error.message, true);
      } finally {
        busy = false;
        render();
      }
    };
  }
  function render() {
    const list = $("ofdCertificateList");
    list.replaceChildren();
    if (!certificates.length) line(list, "尚未导入证书。", "p", "ofdMuted");
    for (const c of certificates) {
      const section = document.createElement("section");
      list.append(section);
      line(section, certificateLabel(c), "h3");
      line(
        section,
        `${c.isCA ? "CA 证书" : "文档签名证书"} · ${c.hasKey ? "私钥已载入" : "无私钥"} · ${c.timeValid ? "有效" : "不在有效期内"} · ${c.trusted ? "本机已信任" : "未设置信任"}`,
        "p",
        "ofdMuted",
      );
      if (c.isCA && !c.canIssue)
        line(section, `暂不可签发：${c.issueReason}`, "p", "ofdMuted");
      const details = document.createElement("details");
      section.append(details);
      line(details, "证书详情", "summary");
      detail(details, c);
      const actions = document.createElement("div");
      actions.className = "actions buttonRow";
      section.append(actions);
      action(actions, "导出证书", () =>
        download(
          new TextEncoder().encode(
            `-----BEGIN CERTIFICATE-----\n${c.der.match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`,
          ),
          `${c.id.slice(0, 16)}.pem`,
          "application/x-pem-file",
        ),
      );
      action(
        actions,
        c.trusted ? "撤销本机信任" : "设置本机信任…",
        async () => {
          if (!c.trusted) {
            showTrust(c);
            return;
          }
          certificates = await worker.call("trust", {
            id: c.id,
            trusted: false,
          });
          persist();
          render();
        },
      );
      if (c.hasKey)
        action(actions, "清除会话私钥", async () => {
          certificates = await worker.call("lock", { id: c.id });
          render();
        });
      action(actions, "移除", async () => {
        certificates = await worker.call("remove", { id: c.id });
        render();
        persist();
      });
    }
    const evidenceList = $("ofdEvidenceList");
    evidenceList.replaceChildren();
    for (const material of materials) {
      const row = document.createElement("section");
      evidenceList.append(row);
      line(
        row,
        `${material.type.toUpperCase()} · ${material.name} · ${material.count} 份材料`,
      );
      action(row, "移除材料", async () => {
        materials = await worker.call("removeEvidence", { id: material.id });
        persist();
        render();
      });
    }
    const selected = $("ofdSigningCertificate").value;
    const select = $("ofdSigningCertificate");
    select.replaceChildren();
    for (const c of certificates.filter((c) => c.canSign)) {
      const option = line(
        select,
        `${certificateLabel(c)} · ${c.algorithm} · ${c.id.slice(0, 12)}`,
        "option",
      );
      option.value = c.id;
    }
    if (!select.options.length) {
      const option = line(select, "请先导入有效证书及对应私钥", "option");
      option.value = "";
    } else if (certificates.some((c) => c.id === selected && c.canSign))
      select.value = selected;
    const previousIssuer = $("ofdCreateIssuer").value;
    const issuerSelect = $("ofdCreateIssuer");
    issuerSelect.replaceChildren();
    line(issuerSelect, "请选择已载入私钥的有效 CA", "option").value = "";
    for (const c of certificates.filter((c) => c.canIssue)) {
      line(
        issuerSelect,
        `${certificateLabel(c)} · ${c.algorithm} · ${c.id.slice(0, 12)}`,
        "option",
      ).value = c.id;
    }
    if (certificates.some((c) => c.id === previousIssuer && c.canIssue))
      issuerSelect.value = previousIssuer;
    renderSeals();
    sealManager.render();
    showSigningDetails();
    for (const input of manager.querySelectorAll(
      "input, select, button[type=submit]",
    ))
      input.disabled = busy;
    $("ofdCertificateClose").disabled = busy;
    for (const input of signing.querySelectorAll("input"))
      input.disabled = busy;
    stampEditor.setBusy(busy);
    showCreateOptions();
  }
  function showSigningDetails() {
    const c = certificates.find(
      (c) => c.id === $("ofdSigningCertificate").value,
    );
    $("ofdSigningDetails").replaceChildren();
    if (c) detail($("ofdSigningDetails"), c);
    const visible = $("ofdVisibleSeal").checked;
    $("ofdStampFields").hidden = !visible;
    $("ofdSigningSealRow").hidden = !visible;
    $("ofdSignConfirm").disabled =
      busy ||
      !c?.canSign ||
      (visible &&
        (!c.algorithm.startsWith("SM2") ||
          !selectedSeal ||
          !stampEditor.ready()));
    if (visible && c && !c.algorithm.startsWith("SM2"))
      line(
        $("ofdSigningDetails"),
        "可见印章需要 SM2 证书，请更换证书或在证书管理中创建。",
        "p",
        "ofdError",
      );
  }
  function showCreateOptions() {
    const type = $("ofdCreateType").value,
      issued = type === "issued";
    if(type==='root-ca')$("ofdCreatePurpose").value='sign';
    $("ofdCreatePurpose").disabled=busy||type==='root-ca';
    const encryption=$("ofdCreatePurpose").value==='encrypt';
    if(encryption)$("ofdCreateAlgorithm").value='SM2';
    $("ofdCreateAlgorithm").disabled=busy||encryption;
    $("ofdCreateIssuerRow").hidden = !issued;
    $("ofdCreateIssuer").disabled = busy || !issued;
    $("ofdCreateHint").textContent = issued
      ? "由所选 CA 签发，有效期不超过 CA 的有效期。"
      : type === "root-ca"
        ? "用于签发文档证书。"
        : "持有人与颁发者相同。";
    const details = $("ofdCreateIssuerDetails");
    details.replaceChildren();
    if (issued) {
      const ca = certificates.find(
        (c) => c.id === $("ofdCreateIssuer").value && c.canIssue,
      );
      if (ca)
        propertyRows(details, [
          ["颁发者", certificateLabel(ca)],
          ["CA 有效期截止", ca.notAfter],
          ["CA SHA-256 指纹", ca.id],
        ]);
      else if (!certificates.some((c) => c.canIssue))
        line(
          details,
          "请先创建 CA，或导入 CA 证书及私钥。",
          "p",
          "ofdMuted",
        );
    }
    $("ofdCreateConfirm").textContent = issued
      ? "签发并下载备份"
      : "创建并下载备份";
    $("ofdCreateConfirm").disabled =
      busy || (issued && !$("ofdCreateIssuer").value);
  }
  $("ofdCreateType").onchange = showCreateOptions;
  $("ofdCreatePurpose").onchange = showCreateOptions;
  $("ofdCreateIssuer").onchange = showCreateOptions;
  const ready = (async () => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "[]");
      if (!Array.isArray(saved) || saved.length > 100)
        throw Error("证书目录格式无效。");
      for (const der of saved)
        certificates = await worker.call("import", { bytes: decode(der) });
      const trusted = JSON.parse(localStorage.getItem(trustKey) || "[]");
      if (!Array.isArray(trusted) || trusted.length > 100)
        throw Error("信任目录无效。");
      for (const id of trusted)
        if (certificates.some((c) => c.id === id))
          certificates = await worker.call("trust", { id, trusted: true });
      const evidence = JSON.parse(localStorage.getItem(evidenceKey) || "[]");
      if (!Array.isArray(evidence) || evidence.length > 100)
        throw Error("验证材料目录无效。");
      for (const item of evidence)
        materials = await worker.call("evidence", {
          ...item,
          bytes: decode(item.der),
        });
    } catch (e) {
      message(
        "ofdCertificateMessage",
        `部分本机证书未能载入：${e.message}`,
        true,
      );
    }
    await sealManager.ready;
    render();
  })();
  $("ofdCertificates").onclick = async () => {
    manager.showModal();
    await ready;
    render();
  };
  $("ofdSeals").onclick = async () => {
    await ready;
    await sealManager.open();
  };
  $("ofdCertificateClose").onclick = () => manager.close();
  manager.addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });
  manager.addEventListener("close", () => {
    $("ofdCertificateImport").reset();
    $("ofdCertificateCreate").reset();
    updatePasswordStrength();
    stampEditor.setBusy(busy);
    showCreateOptions();
  });
  const trustDialog = document.createElement("dialog");
  trustDialog.id = "ofdTrustDialog";
  trustDialog.setAttribute("aria-labelledby", "ofdTrustTitle");
  trustDialog.innerHTML = `<h2 id="ofdTrustTitle">设置本机信任</h2><div id="ofdTrustDetails"></div><p>当前浏览器将信任此证书及其有效签发链。</p><div class="actions"><button id="ofdTrustCancel">取消</button><button id="ofdTrustConfirm">信任此证书</button></div>`;
  nativeDialog(trustDialog, ["ofdTrustConfirm"]);
  document.body.append(trustDialog);
  let trustCandidate;
  function showTrust(c) {
    trustCandidate = c;
    $("ofdTrustDetails").replaceChildren();
    detail($("ofdTrustDetails"), c);
    trustDialog.showModal();
  }
  $("ofdTrustCancel").onclick = () => trustDialog.close();
  $("ofdTrustConfirm").onclick = async () => {
    $("ofdTrustConfirm").disabled = true;
    try {
      certificates = await worker.call("trust", {
        id: trustCandidate.id,
        trusted: true,
      });
      persist();
      render();
      trustDialog.close();
    } catch (e) {
      message("ofdCertificateMessage", e.message, true);
      trustDialog.close();
    } finally {
      $("ofdTrustConfirm").disabled = false;
    }
  };
  $("ofdCertificateCreate").onsubmit = async (event) => {
    event.preventDefault();
    if (busy) return;
    await ready;
    if ($("ofdCreatePassword").value !== $("ofdCreatePasswordAgain").value)
      return message(
        "ofdCertificateMessage",
        "两次输入的备份密码不一致。",
        true,
      );
    busy = true;
    render();
    message("ofdCertificateMessage", "正在生成密钥、证书和备份…");
    const encryptedBackup = $("ofdCreatePassword").value.length > 0;
    try {
      const type = $("ofdCreateType").value;
      const result = await worker.call("create", {
        type,
        issuerId: type === "issued" ? $("ofdCreateIssuer").value : undefined,
        subject: Object.fromEntries(
          certificateFields.map((field) => [
            field.key,
            $(`ofdCreate${field.key}`).value,
          ]),
        ),
        algorithm: $("ofdCreateAlgorithm").value,
        purpose: $("ofdCreatePurpose").value,
        days: Number($("ofdCreateDays").value),
        password: $("ofdCreatePassword").value,
      });
      certificates = result.certificates;
      download(result.backup, "certificate-backup.zip", "application/zip");
      $("ofdCertificateCreate").reset();
      if (persist())
        message(
          "ofdCertificateMessage",
          `${type === "issued" ? "证书已由所选 CA 签发" : type === "root-ca" ? "根 CA 证书已创建" : "自签名证书已创建"}，已下载${encryptedBackup ? "加密" : "未加密"}备份。`,
        );
    } catch (e) {
      message("ofdCertificateMessage", e.message, true);
    } finally {
      $("ofdCreatePassword").value = $("ofdCreatePasswordAgain").value = "";
      updatePasswordStrength();
      busy = false;
      render();
    }
  };
  $("ofdEvidenceForm").onsubmit = async (event) => {
    event.preventDefault();
    if (busy) return;
    await ready;
    const file = $("ofdEvidenceFile").files[0];
    if (!file || file.size > 16 * 1048576)
      return message("ofdCertificateMessage", "材料文件最大 16 MB。", true);
    busy = true;
    render();
    try {
      materials = await worker.call("evidence", {
        name: file.name,
        type: $("ofdEvidenceType").value,
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
      $("ofdEvidenceForm").reset();
      if (persist())
        message(
          "ofdCertificateMessage",
          "验证材料已导入，可重新验签。",
        );
    } catch (e) {
      message("ofdCertificateMessage", e.message, true);
    } finally {
      busy = false;
      render();
    }
  };
  $("ofdCertificateImport").onsubmit = async (event) => {
    event.preventDefault();
    if (busy) return;
    await ready;
    const file = $("ofdCertificateFile").files[0],
      keyFile = $("ofdPrivateKeyFile").files[0];
    if (!file) return;
    if (file.size > 16 * 1048576 || keyFile?.size > 16 * 1048576)
      return message(
        "ofdCertificateMessage",
        "单个证书或私钥文件最大 16 MB。",
        true,
      );
    const password = $("ofdCertificatePassword").value;
    busy = true;
    render();
    message("ofdCertificateMessage", "正在读取证书并匹配私钥…");
    try {
      certificates = await worker.call("import", {
        bytes: new Uint8Array(await file.arrayBuffer()),
        format: /\.(p12|pfx)$/i.test(file.name) ? "p12" : "certificate",
        privateKey: keyFile
          ? new Uint8Array(await keyFile.arrayBuffer())
          : undefined,
        password,
      });
      $("ofdCertificateImport").reset();
      if (persist())
        message(
          "ofdCertificateMessage",
          "导入完成。",
        );
    } catch (e) {
      message("ofdCertificateMessage", e.message, true);
    } finally {
      $("ofdCertificatePassword").value = "";
      busy = false;
      render();
    }
  };
  let signingDocument,
    previewEngine,
    previewSession = 0;
  function closePreview() {
    previewSession++;
    previewEngine?.close();
    previewEngine = undefined;
    stampEditor.setPages([]);
  }
  signing.addEventListener("close", closePreview);
  $("ofdSign").onclick = async () => {
    const doc = getCurrent();
    if (doc?.type !== "ofd" || doc.partial) return;
    signingDocument = doc;
    closePreview();
    const session = previewSession;
    const renderer = (previewEngine = new Engine());
    $("ofdSignFile").textContent = `文件：${doc.name}`;
    message("ofdSignMessage", "正在载入原始文档页面…");
    signing.showModal();
    try {
      const [metadata] = await Promise.all([
        renderer.call("open", { bytes: doc.original, selection: doc.selection }),
        ready,
      ]);
      if (session !== previewSession || doc !== getCurrent() || !signing.open)
        return;
      const pageInfo = await renderer.call("pageAreas");
      if (session !== previewSession || doc !== getCurrent() || !signing.open) return;
      const pages = pageInfo.map((p) => ({
        id: p.id,
        box: p.physicalBox,
      }));
      stampEditor.setPages(pages, (index, width, height) => {
        const scale = width / pageInfo[index].view[2];
        return renderer.call("renderPage", {
          index,
          width,
          height,
          matrix: [scale, 0, 0, scale, 0, 0],
        });
      }, (index, query, ignoreWhitespace) => renderer.call("keywordMatches", {index, query, ignoreWhitespace}));
      message("ofdSignMessage", doc.decrypted ? '当前文档已解密，签署后下载的副本不加密。可重新打开副本并使用“文档加密”。' : '');
    } catch (e) {
      if (session === previewSession && signing.open)
        message("ofdSignMessage", e.message, true);
    }
    render();
  };
  $("ofdSigningCertificate").onchange = renderSeals;
  $("ofdSigningSeal").onchange = chooseSeal;
  $("ofdSignSeals").onclick = () => sealManager.open();
  $("ofdSignManage").onclick = () => manager.showModal();
  $("ofdSignCancel").onclick = () => signing.close();
  $("ofdSignForm").onsubmit = async (event) => {
    event.preventDefault();
    if (
      busy ||
      !$("ofdSigningCertificate").value ||
      signingDocument !== getCurrent()
    )
      return;
    const doc = signingDocument;
    busy = true;
    render();
    $("ofdSignCancel").disabled =
      $("ofdSignManage").disabled =
      $("ofdSignSeals").disabled =
      $("ofdSigningCertificate").disabled =
        true;
    message("ofdSignMessage", "正在生成文件摘要、签名并验证结果…");
    try {
      const result = await worker.call("sign", {
        bytes: doc.original,
        selection: doc.selection,
        id: $("ofdSigningCertificate").value,
        sealId: $("ofdVisibleSeal").checked
          ? $("ofdSigningSeal").value
          : undefined,
        placements: $("ofdVisibleSeal").checked
          ? stampEditor.options().placements
          : undefined,
      });
      if (doc !== getCurrent() || !signing.open) return;
      download(
        result.bytes,
        doc.name.replace(/\.ofd$/i, "-signed.ofd"),
        "application/ofd",
      );
      message(
        "ofdSignMessage",
        `已生成签名副本，签名 ${result.id} 自检通过，保护 ${result.references} 个文件。可打开下载的副本查看签名。${doc.decrypted?'此副本未加密，可重新打开后使用“文档加密”保存。':''}`,
      );
    } catch (e) {
      message("ofdSignMessage", e.message, true);
    } finally {
      busy = false;
      $("ofdSignCancel").disabled =
        $("ofdSignManage").disabled =
        $("ofdSignSeals").disabled =
        $("ofdSigningCertificate").disabled =
          false;
      render();
    }
  };
  $("ofdVisibleSeal").onchange = showSigningDetails;
  signing.addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });
  return {
    async encryptionCall(method,args) {await ready;return worker.call(method,args);},
    async encryptionCertificates() {await ready;return worker.call('list');},
    async manageCertificates() {
      await ready;
      return new Promise(resolve=>{manager.addEventListener('close',resolve,{once:true});manager.showModal();});
    },
    async verify(bytes, selection) {
      await ready;
      return worker.call("verify", { bytes, selection });
    },
    closeDocumentDialogs() {
      signing.close();
    },
    async addCertificate(der) {
      await ready;
      certificates = await worker.call("import", { bytes: decode(der) });
      render();
      if (!persist()) throw Error("已导入本次会话，但浏览器无法保存证书。");
    },
  };
}
